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

    private static readonly Evidence[] BalancingInterestsAll =
    [
        E(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって"),
        E(TestAbilities.BalancingInterests, 2, "二人に電話しました"),
        E(TestAbilities.BalancingInterests, 3, "迎えの時間をずらしてもらいました"),
    ];

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 消した場面の確かめに使わない履歴だけを外し、残っている場面の同じ履歴は残す")]
    public async Task ForgetsOnlyDeletedEpisodeSetAside()
    {
        var (store, clock) = Create();
        await Consent(store);
        Evidence[] noticingAll =
        [
            E(TestAbilities.NoticingChanges, 1, "顔色がいつもと違うと気づきました"),
            E(TestAbilities.NoticingChanges, 2, "熱っぽい様子でした"),
            E(TestAbilities.NoticingChanges, 3, "前の日と比べて元気がありませんでした"),
        ];
        // 残る場面: 変化への気づきがそろったあと、サインで確かめに使わなくなった
        var kept = await SaveEpisode(store, clock.GetUtcNow(), noticingAll);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, kept.Id, clock, Ct);
        await store.TryUpdateAsync<EpisodeItem>(User, kept.Id, e => e with { ExcludedFromValidation = true }, Ct);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.SetAside, kept.Id, clock, Ct);
        // 消す場面: 利害調整力がそろったあと、サインで確かめに使わなくなり、残さずに飛ばした
        var deleted = await SaveEpisode(store, clock.GetUtcNow().AddMinutes(1), BalancingInterestsAll);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, deleted.Id, clock, Ct);
        await store.TryUpdateAsync<EpisodeItem>(User, deleted.Id, e => e with { ExcludedFromValidation = true }, Ct);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.SetAside, deleted.Id, clock, Ct);
        var read = await store.GetVersionedAsync<EpisodeItem>(User, deleted.Id, Ct);
        Assert.True(await store.TryDeleteAsync(User, deleted.Id, read!.ETag, Ct));
        clock.Advance(TimeSpan.FromMinutes(5));

        var book = await AbilityBook.RecomputeAfterDeletingAsync(store, User, deleted.Id, clock, Ct);

        Assert.Equal(
            [
                (TestAbilities.NoticingChanges, AbilityState.NotYet, AbilityState.Confirmed, ChangeReason.Talk, kept.Id),
                (TestAbilities.NoticingChanges, AbilityState.Confirmed, AbilityState.NotYet, ChangeReason.SetAside, kept.Id),
                (TestAbilities.BalancingInterests, AbilityState.NotYet, AbilityState.Confirmed, ChangeReason.Talk, deleted.Id),
                (TestAbilities.BalancingInterests, AbilityState.Confirmed, AbilityState.NotYet, ChangeReason.Skip, deleted.Id),
            ],
            book.History.Select(h => (h.Ability, h.From, h.To, h.Reason, h.EpisodeId)));
        Assert.Equal(clock.GetUtcNow(), book.History[^1].At);
        Assert.All(AbilityCatalog.Active, a => Assert.Equal(AbilityState.NotYet, book.StateOf(a)));

        // 外す行がなく、状態も変わらなければ書かない
        var again = await AbilityBook.RecomputeAfterDeletingAsync(store, User, deleted.Id, clock, Ct);
        Assert.Equal(book.History, again.History);
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 状態が変わった力だけ、いつ、前と後、なぜを履歴に残す")]
    public async Task HistoryKeepsOnlyChangedAbilities()
    {
        var (store, clock) = Create();
        await Consent(store);
        var first = await SaveEpisode(store, clock.GetUtcNow(), [BalancingInterestsAll[0], BalancingInterestsAll[1]]);

        var book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, first.Id, clock, Ct);

        var change = Assert.Single(book.History);
        Assert.Equal(TestAbilities.BalancingInterests, change.Ability);
        Assert.Equal(AbilityState.NotYet, change.From);
        Assert.Equal(AbilityState.NeedsCheck, change.To);
        Assert.Equal(ChangeReason.Talk, change.Reason);
        Assert.Equal(first.Id, change.EpisodeId);
        Assert.Equal(clock.GetUtcNow(), change.At);

        clock.Advance(TimeSpan.FromHours(1));
        await store.UpsertAsync(first with { Evidence = BalancingInterestsAll }, Ct);
        book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Correction, first.Id, clock, Ct);

        Assert.Equal(2, book.History.Count);
        var corrected = book.History[^1];
        Assert.Equal((TestAbilities.BalancingInterests, AbilityState.NeedsCheck, AbilityState.Confirmed, ChangeReason.Correction),
            (corrected.Ability, corrected.From, corrected.To, corrected.Reason));
        Assert.Equal(clock.GetUtcNow(), corrected.At);
        Assert.Equal(AbilityState.Confirmed, book.States[TestAbilities.BalancingInterests]);
        Assert.Equal(AbilityState.NotYet, book.StateOf(TestAbilities.NoticingChanges));

        // 変わらなければ履歴は増えない
        book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, first.Id, clock, Ct);
        Assert.Equal(2, book.History.Count);

        // 保存したものを読み直しても同じ（JSON の形）
        var stored = await store.GetAsync<AbilityBookItem>(User, AbilityBookItem.ItemId, Ct);
        Assert.NotNull(stored);
        Assert.Equal(AbilityBookItem.ItemType, stored.Type);
        Assert.Equal(AbilityState.Confirmed, stored.States[TestAbilities.BalancingInterests]);
        Assert.Equal(2, stored.History.Count);
        Assert.Equal(ChangeReason.Correction, stored.History[^1].Reason);
        var raw = new List<string>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            raw.Add(json);
        }

        Assert.Contains(raw, j => j.Contains("\"states\":{\"info-gathering\":\"notYet\"", StringComparison.Ordinal)
            && j.Contains("\"balancing-interests\":\"confirmed\"", StringComparison.Ordinal));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 力の確かめに使わない場面は数えない")]
    public async Task ExcludedEpisodesAreNotCounted()
    {
        var (store, clock) = Create();
        await Consent(store);
        var episode = await SaveEpisode(store, clock.GetUtcNow(), BalancingInterestsAll, excluded: true);

        var book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, episode.Id, clock, Ct);

        Assert.Equal(AbilityState.NotYet, book.StateOf(TestAbilities.BalancingInterests));
        Assert.Empty(book.History);
        Assert.Empty(AbilityBook.View([episode], book));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 場面のうちいちばん進んだ状態を使い、根拠はその状態の新しい場面から")]
    public async Task MostAdvancedStateWithNewestEvidence()
    {
        var (store, clock) = Create();
        await Consent(store);
        var start = clock.GetUtcNow();
        var older = await SaveEpisode(store, start, BalancingInterestsAll);
        var newerConfirmed = await SaveEpisode(store, start.AddDays(1),
        [
            E(TestAbilities.BalancingInterests, 1, "姉と兄の都合が合わず"),
            E(TestAbilities.BalancingInterests, 2, "私から姉に連絡して"),
            E(TestAbilities.BalancingInterests, 3, "週末に二人がそろう日を決めました"),
        ]);
        var newestPartial = await SaveEpisode(store, start.AddDays(2), [E(TestAbilities.BalancingInterests, 2, "近所の人に頼みました")]);

        var book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, newestPartial.Id, clock, Ct);
        var view = AbilityBook.View([older, newerConfirmed, newestPartial], book);

        var coordinating = view.Single(v => v.Ability == TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.Confirmed, coordinating.State);
        Assert.Equal(newerConfirmed.Id, coordinating.EpisodeId);
        Assert.Equal(["姉と兄の都合が合わず", "私から姉に連絡して", "週末に二人がそろう日を決めました"], coordinating.Shown.Select(e => e.Quote));
        Assert.Empty(coordinating.Hints);
        Assert.Equal(AbilityState.Confirmed, book.StateOf(TestAbilities.BalancingInterests));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 要確認の力には、足りない行動の手がかりが付く")]
    public async Task NeedsCheckHasHints()
    {
        var (store, clock) = Create();
        await Consent(store);
        var episode = await SaveEpisode(store, clock.GetUtcNow(), [E(TestAbilities.SettingPriorities, 2, "病院を先にしました")]);

        var view = AbilityBook.View([episode], null);

        var prioritizing = view.Single(v => v.Ability == TestAbilities.SettingPriorities);
        Assert.Equal(AbilityState.NeedsCheck, prioritizing.State);
        Assert.Equal(
            [AbilityText.Hint(new ActionRef(TestAbilities.SettingPriorities, 1)), AbilityText.Hint(new ActionRef(TestAbilities.SettingPriorities, 3))],
            prioritizing.Hints);
        // 見せた力だけを返す（まだ聞けていない力は並べない）
        Assert.Equal([TestAbilities.SettingPriorities], view.Select(v => v.Ability));
        Assert.All(view, v => Assert.False(v.Excluded));
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 力の本の状態と履歴は、本人に見せた力だけで決まり、画面に出さない力は未確認のまま")]
    public async Task BookUsesOnlyShownAbilities()
    {
        var (store, clock) = Create();
        await Consent(store);
        // 利害調整力と段取り力が同じ出来事でそろう（同じ分類なので、見せるのは行動の多い利害調整力）。
        // 要確認は 3 つ（変化への気づき 2、要約力 1、傾聴力 1）で、見せるのは変化への気づきと、辞書の順で前の要約力
        var episode = await SaveEpisode(store, clock.GetUtcNow(),
        [
            .. BalancingInterestsAll,
            E(TestAbilities.PlanningSteps, 1, "することを書き出しました"),
            E(TestAbilities.PlanningSteps, 2, "迎えを先にすると決めました"),
            E(TestAbilities.NoticingChanges, 1, "顔色がいつもと違って"),
            E(TestAbilities.NoticingChanges, 2, "熱があるかもしれないと思って"),
            E(TestAbilities.Summarizing, 1, "話をまとめて伝えました"),
            E(TestAbilities.ActiveListening, 1, "先に最後まで聞きました"),
        ]);

        var book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, episode.Id, clock, Ct);

        Assert.Equal(AbilityState.Confirmed, book.StateOf(TestAbilities.BalancingInterests));
        Assert.Equal(AbilityState.NeedsCheck, book.StateOf(TestAbilities.NoticingChanges));
        Assert.Equal(AbilityState.NeedsCheck, book.StateOf(TestAbilities.Summarizing));
        Assert.Equal(AbilityState.NotYet, book.StateOf(TestAbilities.PlanningSteps));
        Assert.Equal(AbilityState.NotYet, book.StateOf(TestAbilities.ActiveListening));
        Assert.Equal(
            [TestAbilities.Summarizing, TestAbilities.BalancingInterests, TestAbilities.NoticingChanges],
            book.History.Select(h => h.Ability));
        Assert.Equal(
            [TestAbilities.Summarizing, TestAbilities.BalancingInterests, TestAbilities.NoticingChanges],
            AbilityBook.View([episode], book).Select(v => v.Ability));

        // 別の場面で段取り力を見せると、その場面の状態（確かめ中）になる。隠れていた場面の根拠ありは使わない
        clock.Advance(TimeSpan.FromDays(1));
        var later = await SaveEpisode(store, clock.GetUtcNow(), [E(TestAbilities.PlanningSteps, 1, "買うものを書き出しました")]);
        book = await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, later.Id, clock, Ct);

        Assert.Equal(AbilityState.NeedsCheck, book.StateOf(TestAbilities.PlanningSteps));
        var planning = AbilityBook.View([episode, later], book).Single(v => v.Ability == TestAbilities.PlanningSteps);
        Assert.Equal((AbilityState.NeedsCheck, later.Id), (planning.State, planning.EpisodeId));
        Assert.Equal(["買うものを書き出しました"], planning.Shown.Select(e => e.Quote));
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 履歴は 100 件まで、古いものから捨てる")]
    public async Task HistoryIsCapped()
    {
        var (store, clock) = Create();
        await Consent(store);
        // 外す・戻すは本人に見せた力だけなので、変化への気づきを見せた場面を置く
        await SaveEpisode(store, clock.GetUtcNow(), [E(TestAbilities.NoticingChanges, 1, "顔色がいつもと違うと気づきました")]);
        for (var i = 0; i < 60; i++)
        {
            await AbilityBook.SetExcludedAsync(store, User, TestAbilities.NoticingChanges, excluded: true, clock, Ct);
            clock.Advance(TimeSpan.FromMinutes(1));
            await AbilityBook.SetExcludedAsync(store, User, TestAbilities.NoticingChanges, excluded: false, clock, Ct);
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
        await SaveEpisode(store, clock.GetUtcNow(), BalancingInterestsAll);

        var book = await AbilityBook.SetExcludedAsync(store, User, TestAbilities.BalancingInterests, excluded: true, clock, Ct);
        book = await AbilityBook.SetExcludedAsync(store, User, TestAbilities.BalancingInterests, excluded: true, clock, Ct);

        Assert.NotNull(book);
        Assert.Contains(TestAbilities.BalancingInterests, book.Excluded);
        var exclude = Assert.Single(book.History, h => h.Reason == ChangeReason.Exclude);
        Assert.Equal((AbilityState.Confirmed, AbilityState.Confirmed), (exclude.From, exclude.To));

        book = await AbilityBook.SetExcludedAsync(store, User, TestAbilities.BalancingInterests, excluded: false, clock, Ct);
        Assert.NotNull(book);
        Assert.DoesNotContain(TestAbilities.BalancingInterests, book.Excluded);
        Assert.Single(book.History, h => h.Reason == ChangeReason.Restore);
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 外す・戻すは、見せた力か外した力だけを受け付け、見せていない力には何も書かない。外した力は、見せなくなっても戻せる")]
    public async Task OnlyShownOrExcludedAbilitiesCanBeToggled()
    {
        var (store, clock) = Create();
        await Consent(store);

        // 場面がなければ、どの力も本人に見せていない
        Assert.Null(await AbilityBook.SetExcludedAsync(store, User, TestAbilities.Empathy, excluded: true, clock, Ct));
        Assert.Null(await AbilityBook.SetExcludedAsync(store, User, TestAbilities.Empathy, excluded: false, clock, Ct));
        var book = await store.GetAsync<AbilityBookItem>(User, AbilityBookItem.ItemId, Ct);
        Assert.Empty(book?.Excluded ?? []);
        Assert.Empty(book?.History ?? []);

        // 利害調整力（行動 3 つ）と段取り力（行動 2 つ）が同じ出来事でそろうと、段取り力は見せない。見せていない段取り力は外せない
        var episode = await SaveEpisode(store, clock.GetUtcNow(),
        [
            .. BalancingInterestsAll,
            E(TestAbilities.PlanningSteps, 1, "買うものを書き出しました"),
            E(TestAbilities.PlanningSteps, 2, "スーパーを先に回る順にしました"),
        ]);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, episode.Id, clock, Ct);
        Assert.Null(await AbilityBook.SetExcludedAsync(store, User, TestAbilities.PlanningSteps, excluded: true, clock, Ct));

        // 見せた力は外せる。外していない力を戻しても、何も変わらない
        book = (await AbilityBook.SetExcludedAsync(store, User, TestAbilities.BalancingInterests, excluded: false, clock, Ct))!;
        Assert.DoesNotContain(book.History, h => h.Reason is ChangeReason.Exclude or ChangeReason.Restore);
        book = (await AbilityBook.SetExcludedAsync(store, User, TestAbilities.BalancingInterests, excluded: true, clock, Ct))!;
        Assert.Equal([TestAbilities.BalancingInterests], book.Excluded);
        Assert.DoesNotContain(book.History, h => h.Ability == TestAbilities.PlanningSteps);

        // 場面がなくなって見せなくなった力も、外した力の一覧にあれば戻せる
        await store.DeleteAsync(User, episode.Id, Ct);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.Skip, episode.Id, clock, Ct);
        book = (await AbilityBook.SetExcludedAsync(store, User, TestAbilities.BalancingInterests, excluded: false, clock, Ct))!;
        Assert.Empty(book.Excluded);
        Assert.Equal(ChangeReason.Restore, book.History[^1].Reason);
    }

    [Fact(DisplayName = "foundation-3（いつでも全部消せる）: 全部消したあとは、力の状態の本を作り直さない")]
    public async Task DoesNotRecreateAfterDeleteAll()
    {
        var (store, clock) = Create();
        await Consent(store);
        var episode = await SaveEpisode(store, clock.GetUtcNow(), BalancingInterestsAll);
        await AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, episode.Id, clock, Ct);

        await store.DeleteAllAsync(User, Ct);

        await Assert.ThrowsAsync<ConsentMissingException>(() => AbilityBook.RecomputeAsync(store, User, ChangeReason.Talk, null, clock, Ct));
        await Assert.ThrowsAsync<ConsentMissingException>(
            () => AbilityBook.SetExcludedAsync(store, User, TestAbilities.NoticingChanges, excluded: true, clock, Ct));
        Assert.Equal(0, await store.CountAllAsync(User, Ct));
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 理由は JSON で talk、correction、skip、exclude、restore、setAside")]
    public void ReasonsSerializeAsCamelCase()
    {
        var names = Enum.GetValues<ChangeReason>().Select(r => JsonSerializer.Serialize(r, DataConstants.Json));
        Assert.Equal(["\"talk\"", "\"correction\"", "\"skip\"", "\"exclude\"", "\"restore\"", "\"setAside\""], names);
    }
}
