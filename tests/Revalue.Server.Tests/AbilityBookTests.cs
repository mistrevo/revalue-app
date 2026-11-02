using System.Text.Json;
using Microsoft.Extensions.Time.Testing;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AbilityBookTests
{
    private const string User = "u_a";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static (InMemoryDataStore Store, FakeTimeProvider Clock) Create()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-03T03:00:00Z"));
        return (new InMemoryDataStore(clock), clock);
    }

    private static Task Consent(IDataStore store) =>
        store.UpsertAsync(new ConsentItem
        {
            Id = ConsentItem.ItemId,
            UserKey = User,
            Type = ConsentItem.ItemType,
            Version = ConsentInfo.CurrentVersion,
            At = DateTimeOffset.Parse("2026-11-03T03:00:00Z"),
        }, Ct);

    private static Evidence E(Ability ability, int action, string quote, int @event = 1) =>
        new(ability, action, quote, 1, @event, false, false, null);

    /// <summary>根拠を持つ、話し終えた場面を保存する。</summary>
    private static async Task<EpisodeItem> SaveEpisode(
        IDataStore store, DateTimeOffset startedAt, IReadOnlyList<Evidence> evidence, bool excluded = false, string? id = null)
    {
        var answer = string.Concat(evidence.Select(e => e.Quote + "。"));
        var episode = new EpisodeItem
        {
            Id = id ?? EpisodeItem.NewId(),
            UserKey = User,
            Type = EpisodeItem.ItemType,
            Status = EpisodeStatus.Finished,
            StartedAt = startedAt,
            FinishedAt = startedAt.AddMinutes(10),
            Turns =
            [
                new Turn { Role = TurnRoles.Assistant, Text = "最近の一日を教えてください。", At = startedAt },
                new Turn { Role = TurnRoles.User, Text = answer, AnswerKind = AnswerKind.Free, At = startedAt },
            ],
            Evidence = evidence,
            ExcludedFromValidation = excluded,
        };
        await store.UpsertAsync(episode, Ct);
        return episode;
    }

    private static readonly Evidence[] CoordinatingAll =
    [
        E(Ability.Coordinating, 1, "夫と母の予定がぶつかって"),
        E(Ability.Coordinating, 2, "二人に電話しました"),
        E(Ability.Coordinating, 3, "迎えの時間をずらしてもらいました"),
    ];

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 状態が変わった力だけ、いつ、前と後、なぜを履歴に残す")]
    public async Task HistoryKeepsOnlyChangedAbilities()
    {
        var (store, clock) = Create();
        await Consent(store);
        var first = await SaveEpisode(store, clock.GetUtcNow(), [CoordinatingAll[0], CoordinatingAll[1]]);

        var book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, first.Id, clock, Ct);

        var change = Assert.Single(book.History);
        Assert.Equal(Ability.Coordinating, change.Ability);
        Assert.Equal(AbilityState.NotYet, change.From);
        Assert.Equal(AbilityState.NeedsCheck, change.To);
        Assert.Equal(ChangeReason.Talk, change.Reason);
        Assert.Equal(first.Id, change.EpisodeId);
        Assert.Equal(clock.GetUtcNow(), change.At);

        clock.Advance(TimeSpan.FromHours(1));
        await store.UpsertAsync(first with { Evidence = CoordinatingAll }, Ct);
        book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Correction, first.Id, clock, Ct);

        Assert.Equal(2, book.History.Count);
        var corrected = book.History[^1];
        Assert.Equal((Ability.Coordinating, AbilityState.NeedsCheck, AbilityState.Confirmed, ChangeReason.Correction),
            (corrected.Ability, corrected.From, corrected.To, corrected.Reason));
        Assert.Equal(clock.GetUtcNow(), corrected.At);
        Assert.Equal(AbilityState.Confirmed, book.States[Ability.Coordinating]);
        Assert.Equal(AbilityState.NotYet, book.StateOf(Ability.Noticing));

        // 変わらなければ履歴は増えない
        book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, first.Id, clock, Ct);
        Assert.Equal(2, book.History.Count);

        // 保存したものを読み直しても同じ（JSON の形）
        var stored = await store.GetAsync<AbilityBookItem>(User, AbilityBookItem.ItemId, Ct);
        Assert.NotNull(stored);
        Assert.Equal(AbilityBookItem.ItemType, stored.Type);
        Assert.Equal(AbilityState.Confirmed, stored.States[Ability.Coordinating]);
        Assert.Equal(2, stored.History.Count);
        Assert.Equal(ChangeReason.Correction, stored.History[^1].Reason);
        var raw = new List<string>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            raw.Add(json);
        }

        Assert.Contains(raw, j => j.Contains("\"states\":{\"noticing\":\"notYet\",\"coordinating\":\"confirmed\"", StringComparison.Ordinal));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 力の確かめに使わない場面は数えない")]
    public async Task ExcludedEpisodesAreNotCounted()
    {
        var (store, clock) = Create();
        await Consent(store);
        var episode = await SaveEpisode(store, clock.GetUtcNow(), CoordinatingAll, excluded: true);

        var book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, episode.Id, clock, Ct);

        Assert.Equal(AbilityState.NotYet, book.StateOf(Ability.Coordinating));
        Assert.Empty(book.History);
        var view = AbilityBook.View([episode], book);
        Assert.All(view, v => Assert.Equal(AbilityState.NotYet, v.State));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 場面のうちいちばん進んだ状態を使い、根拠はその状態の新しい場面から")]
    public async Task MostAdvancedStateWithNewestEvidence()
    {
        var (store, clock) = Create();
        await Consent(store);
        var start = clock.GetUtcNow();
        var older = await SaveEpisode(store, start, CoordinatingAll);
        var newerConfirmed = await SaveEpisode(store, start.AddDays(1),
        [
            E(Ability.Coordinating, 1, "姉と兄の都合が合わず"),
            E(Ability.Coordinating, 2, "私から姉に連絡して"),
            E(Ability.Coordinating, 3, "週末に二人がそろう日を決めました"),
        ]);
        var newestPartial = await SaveEpisode(store, start.AddDays(2), [E(Ability.Coordinating, 2, "近所の人に頼みました")]);

        var book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, newestPartial.Id, clock, Ct);
        var view = AbilityBook.View([older, newerConfirmed, newestPartial], book);

        var coordinating = view.Single(v => v.Ability == Ability.Coordinating);
        Assert.Equal(AbilityState.Confirmed, coordinating.State);
        Assert.Equal(newerConfirmed.Id, coordinating.EpisodeId);
        Assert.Equal(["姉と兄の都合が合わず", "私から姉に連絡して", "週末に二人がそろう日を決めました"], coordinating.Shown.Select(e => e.Quote));
        Assert.Empty(coordinating.Hints);
        Assert.Equal(AbilityState.Confirmed, book.StateOf(Ability.Coordinating));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 要確認の力には、足りない行動の手がかりが付く")]
    public async Task NeedsCheckHasHints()
    {
        var (store, clock) = Create();
        await Consent(store);
        var episode = await SaveEpisode(store, clock.GetUtcNow(), [E(Ability.Prioritizing, 2, "病院を先にしました")]);

        var view = AbilityBook.View([episode], null);

        var prioritizing = view.Single(v => v.Ability == Ability.Prioritizing);
        Assert.Equal(AbilityState.NeedsCheck, prioritizing.State);
        Assert.Equal(
            [AbilityText.Hint(new ActionRef(Ability.Prioritizing, 1)), AbilityText.Hint(new ActionRef(Ability.Prioritizing, 3))],
            prioritizing.Hints);
        Assert.Equal([Ability.Noticing, Ability.Coordinating, Ability.Prioritizing], view.Select(v => v.Ability));
        Assert.All(view, v => Assert.False(v.Excluded));
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 履歴は 100 件まで、古いものから捨てる")]
    public async Task HistoryIsCapped()
    {
        var (store, clock) = Create();
        await Consent(store);
        for (var i = 0; i < 60; i++)
        {
            await AbilityBook.SetExcludedAsync(store, User, Ability.Noticing, excluded: true, clock, Ct);
            clock.Advance(TimeSpan.FromMinutes(1));
            await AbilityBook.SetExcludedAsync(store, User, Ability.Noticing, excluded: false, clock, Ct);
            clock.Advance(TimeSpan.FromMinutes(1));
        }

        var book = (await store.GetAsync<AbilityBookItem>(User, AbilityBookItem.ItemId, Ct))!;
        Assert.Equal(AbilityBook.MaxHistory, book.History.Count);
        Assert.Equal(ChangeReason.Restore, book.History[^1].Reason);
        Assert.Equal(clock.GetUtcNow().AddMinutes(-1), book.History[^1].At);
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 外す・戻すは、変わったときだけ履歴に残す")]
    public async Task ExcludeAndRestoreAreRecordedOnce()
    {
        var (store, clock) = Create();
        await Consent(store);
        await SaveEpisode(store, clock.GetUtcNow(), CoordinatingAll);

        var book = await AbilityBook.SetExcludedAsync(store, User, Ability.Coordinating, excluded: true, clock, Ct);
        book = await AbilityBook.SetExcludedAsync(store, User, Ability.Coordinating, excluded: true, clock, Ct);

        Assert.Contains(Ability.Coordinating, book.Excluded);
        var exclude = Assert.Single(book.History, h => h.Reason == ChangeReason.Exclude);
        Assert.Equal((AbilityState.Confirmed, AbilityState.Confirmed), (exclude.From, exclude.To));

        book = await AbilityBook.SetExcludedAsync(store, User, Ability.Coordinating, excluded: false, clock, Ct);
        Assert.DoesNotContain(Ability.Coordinating, book.Excluded);
        Assert.Single(book.History, h => h.Reason == ChangeReason.Restore);
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 全部消したあとは、力の状態の本を作り直さない")]
    public async Task DoesNotRecreateAfterDeleteAll()
    {
        var (store, clock) = Create();
        await Consent(store);
        var episode = await SaveEpisode(store, clock.GetUtcNow(), CoordinatingAll);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, episode.Id, clock, Ct);

        await store.DeleteAllAsync(User, Ct);

        await Assert.ThrowsAsync<ConsentMissingException>(() => AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, null, clock, Ct));
        await Assert.ThrowsAsync<ConsentMissingException>(
            () => AbilityBook.SetExcludedAsync(store, User, Ability.Noticing, excluded: true, clock, Ct));
        Assert.Equal(0, await store.CountAllAsync(User, Ct));
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 理由は JSON で talk、correction、skip、exclude、restore")]
    public void ReasonsSerializeAsCamelCase()
    {
        var names = Enum.GetValues<ChangeReason>().Select(r => JsonSerializer.Serialize(r, DataConstants.Json));
        Assert.Equal(["\"talk\"", "\"correction\"", "\"skip\"", "\"exclude\"", "\"restore\""], names);
    }
}
