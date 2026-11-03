using Microsoft.Extensions.Time.Testing;
using Revalue.Server.Data;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Home;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.DeepenTestKit;

namespace Revalue.Server.Tests;

public sealed class NextStepTests
{
    private const string User = "u_next";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    /// <summary>決め方の表。上から順に最初に当たるものを返す（01〜07 の境目）。</summary>
    public static TheoryData<string, string?, bool, Readiness, DeepenReadiness, bool, NextStepKind> Table() => new()
    {
        // 話している途中の場面があれば、ほかの記録に関わらず続きを話す
        { "話している途中の場面がある", "episode-1", false, Readiness.NeedsConditions, DeepenReadiness.NoChoice, false, NextStepKind.Continue },
        { "話している途中の場面があり、ほかは進んでいる", "episode-2", true, Readiness.Ready, DeepenReadiness.Ready, true, NextStepKind.Continue },
        { "話し終えた場面がない", null, false, Readiness.NeedsConditions, DeepenReadiness.NoChoice, false, NextStepKind.Talk },
        { "条件が入っていない", null, true, Readiness.NeedsConditions, DeepenReadiness.NeedsConditions, false, NextStepKind.Conditions },
        { "条件がなく、選んだ案がある", null, true, Readiness.NeedsConditions, DeepenReadiness.NeedsConditions, false, NextStepKind.Conditions },
        { "使える力がない", null, true, Readiness.NeedsAbility, DeepenReadiness.NoChoice, false, NextStepKind.Talk },
        { "使える力がなく、選んだ案がある", null, true, Readiness.NeedsAbility, DeepenReadiness.Ready, false, NextStepKind.Talk },
        { "外した力だけ", null, true, Readiness.OnlyExcluded, DeepenReadiness.NoChoice, false, NextStepKind.Talk },
        { "外した力だけで、選んだ案がある", null, true, Readiness.OnlyExcluded, DeepenReadiness.Ready, false, NextStepKind.Talk },
        { "まだ選んでいない", null, true, Readiness.Ready, DeepenReadiness.NoChoice, false, NextStepKind.Options },
        { "選んでいて、深めた中身がない", null, true, Readiness.Ready, DeepenReadiness.Ready, false, NextStepKind.Deepen },
        { "選んでいて、深めた中身がある", null, true, Readiness.Ready, DeepenReadiness.Ready, true, NextStepKind.Report },
        { "保留している", null, true, Readiness.Ready, DeepenReadiness.Hold, false, NextStepKind.Report },
    };

    [Theory(DisplayName = "common-3（次にできることを一つ示す）: 記録の組み合わせから、上から順に最初に当たる一つを返す")]
    [MemberData(nameof(Table))]
    public void DecidesInOrder(
        string label, string? talkingId, bool hasFinished, Readiness readiness, DeepenReadiness deepen, bool deepened, NextStepKind expected)
    {
        var step = NextStep.Decide(talkingId, hasFinished, readiness, deepen, deepened);

        Assert.True(expected == step.Step, label);
        Assert.Equal(expected == NextStepKind.Continue ? talkingId : null, step.EpisodeId);
    }

    private sealed record Kit(InMemoryDataStore Store, FakeTimeProvider Clock);

    private static async Task<Kit> Create()
    {
        var clock = new FakeTimeProvider(Now);
        var store = new InMemoryDataStore(clock);
        await store.UpsertAsync(new ConsentItem
        {
            Id = ConsentItem.ItemId,
            UserKey = User,
            Type = ConsentItem.ItemType,
            Version = ConsentInfo.CurrentVersion,
            At = clock.GetUtcNow(),
        }, Ct);
        return new Kit(store, clock);
    }

    private static readonly Evidence[] CoordinatingAll =
    [
        E(Ability.Coordinating, 1, Q1),
        E(Ability.Coordinating, 2, "二人に電話しました"),
        E(Ability.Coordinating, 3, "迎えの時間をずらしてもらいました"),
    ];

    private static async Task<string> SaveEpisode(Kit kit, string status, DateTimeOffset at)
    {
        var episode = new EpisodeItem
        {
            Id = EpisodeItem.NewId(),
            UserKey = User,
            Type = EpisodeItem.ItemType,
            Status = status,
            StartedAt = at,
            FinishedAt = status == EpisodeStatus.Finished ? at.AddMinutes(10) : null,
            Turns =
            [
                new Turn { Role = TurnRoles.Assistant, Text = "最近の一日を教えてください。", At = at },
                new Turn { Role = TurnRoles.User, Text = string.Concat(CoordinatingAll.Select(e => e.Quote + "。")), AnswerKind = AnswerKind.Free, At = at },
            ],
            Evidence = status == EpisodeStatus.Finished ? CoordinatingAll : [],
        };
        await kit.Store.UpsertAsync(episode, Ct);
        return episode.Id;
    }

    private static Task<NextStepResult> Read(Kit kit) => NextStep.ReadAsync(kit.Store, User, Catalog, Ct);

    /// <summary>話し終えた場面（調整する力が見えた力）と条件がある記録。</summary>
    private static async Task<Kit> Recorded()
    {
        var kit = await Create();
        await SaveEpisode(kit, EpisodeStatus.Finished, Now);
        await ProfileStore.UpdateAsync(kit.Store, User, p => p with { Conditions = Conditions() }, kit.Clock, Ct);
        return kit;
    }

    private static Task SetChoice(Kit kit, OptionChoice? choice, params OwnJob[] own) =>
        OptionsStore.UpdateAsync(kit.Store, User, o => o with { Choice = choice, OwnJobs = own.Length > 0 ? own : o.OwnJobs }, kit.Clock, Ct);

    private static Task Deepen(Kit kit, OptionsItem basisOf) =>
        DeepenStore.UpdateAsync(kit.Store, User, d => d with
        {
            Content = new DeepenContent(Now, Target(basisOf).Basis, [], false, [], [], false),
        }, kit.Clock, Ct);

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 記録が何もなければ、話すことを示す")]
    public async Task EmptyRecordsMeanTalk()
    {
        var kit = await Create();

        Assert.Equal(new NextStepResult(NextStepKind.Talk, null), await Read(kit));
    }

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 話している途中の場面があれば、いちばん新しいその場面の続きを示す")]
    public async Task TalkingEpisodeMeansContinue()
    {
        var kit = await Recorded();
        var talking = await SaveEpisode(kit, EpisodeStatus.Talking, Now.AddHours(1));

        Assert.Equal(new NextStepResult(NextStepKind.Continue, talking), await Read(kit));
    }

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 本人が使える力をすべて外していたら、外した見立てに戻すことは勧めず、別の一日を話すことを示す")]
    public async Task OnlyExcludedMeansTalk()
    {
        var kit = await Recorded();
        await AbilityBook.SetExcludedAsync(kit.Store, User, Ability.Coordinating, true, kit.Clock, Ct);

        Assert.Equal(new NextStepResult(NextStepKind.Talk, null), await Read(kit));
    }

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 選び直して深めた中身が古くなったら、深めることを示す")]
    public async Task StaleDeepenMeansDeepen()
    {
        var kit = await Recorded();
        Assert.Equal(NextStepKind.Options, (await Read(kit)).Step);

        await SetChoice(kit, ChooseChoice());
        Assert.Equal(NextStepKind.Deepen, (await Read(kit)).Step);

        await Deepen(kit, Options(ChooseChoice()));
        Assert.Equal(NextStepKind.Report, (await Read(kit)).Step);

        // 「組み合わせる」に選び直すと、前の案で深めた中身は使えない
        await SetChoice(kit, CombineChoice());
        Assert.Equal(NextStepKind.Deepen, (await Read(kit)).Step);
    }

    [Fact(DisplayName = "common-3（次にできることを一つ示す）: 自分で書いた仕事を選んでいて、その仕事を消していたら、仕事の選択肢で選ぶことを示す")]
    public async Task DeletedOwnJobMeansOptions()
    {
        var kit = await Recorded();
        await SetChoice(kit, new OptionChoice(ChoiceKind.Own, Now, null, null, null, null, "own-gone"));

        Assert.Equal(NextStepKind.Options, (await Read(kit)).Step);
    }
}
