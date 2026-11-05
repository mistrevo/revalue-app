using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.Time.Testing;
using Revalue.Server.Data;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Report;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.DeepenTestKit;

namespace Revalue.Server.Tests;

public sealed class ReportBuilderTests
{
    private const string User = "u_report";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

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

    private static readonly Evidence[] BalancingInterestsAll =
    [
        E(TestAbilities.BalancingInterests, 1, Q1),
        E(TestAbilities.BalancingInterests, 2, "二人に電話しました"),
        E(TestAbilities.BalancingInterests, 3, "迎えの時間をずらしてもらいました"),
    ];

    private static readonly Evidence NoticingOne = E(TestAbilities.NoticingChanges, 1, "連絡帳の書き方がいつもと違って");

    private static async Task<string> SaveEpisode(
        Kit kit, IReadOnlyList<Evidence> evidence, string status = EpisodeStatus.Finished, string? id = null)
    {
        var at = kit.Clock.GetUtcNow();
        var episode = new EpisodeItem
        {
            Id = id ?? EpisodeItem.NewId(),
            UserKey = User,
            Type = EpisodeItem.ItemType,
            Status = status,
            StartedAt = at,
            FinishedAt = status == EpisodeStatus.Finished ? at.AddMinutes(10) : null,
            Turns =
            [
                new Turn { Role = TurnRoles.Assistant, Text = "最近の一日を教えてください。", At = at },
                new Turn { Role = TurnRoles.User, Text = string.Concat(evidence.Select(e => e.Quote + "。")), AnswerKind = AnswerKind.Free, At = at },
            ],
            Evidence = evidence,
        };
        await kit.Store.UpsertAsync(episode, Ct);
        return episode.Id;
    }

    /// <summary>「選ぶ」のカードを、いまの記録の力（利害調整力が根拠あり）で選んだ案。</summary>
    private static OptionChoice ChooseConfirmed() =>
        ChooseChoice() with
        {
            Choose = ChooseChoice().Choose! with { Ability = new CardAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, [E(TestAbilities.BalancingInterests, 1, Q1)]) },
        };

    private static Task SetConditions(Kit kit, ProfileConditions conditions) =>
        ProfileStore.UpdateAsync(kit.Store, User, p => p with { Conditions = conditions }, kit.Clock, Ct);

    private static Task SetChoice(Kit kit, OptionChoice? choice, params OwnJob[] own) =>
        OptionsStore.UpdateAsync(kit.Store, User, o => o with { Choice = choice, OwnJobs = own.Length > 0 ? own : o.OwnJobs }, kit.Clock, Ct);

    private static DeepenContent Deepened(OptionChoice choice) =>
        new(
            Now,
            Target(Options(choice)).Basis,
            [],
            false,
            [
                new DeepenQuestion("q1", "急に予定が変わったら、どうしますか？", TestAbilities.BalancingInterests, ["相手に聞く", "予定を見直す", "まず待つ"]),
                new DeepenQuestion("q2", "頼まれごとが重なったら、どうしますか？", TestAbilities.SettingPriorities, ["順に並べる", "人に頼む", "まず一つ"]),
            ],
            [
                new StepCandidate("s1", "求人を 3 つ読む", 1, TaskPlace.Home, false),
                new StepCandidate("s2", "予定表を使ってみる", 1, TaskPlace.Home, false),
                new StepCandidate("s3", "話を聞く", 1, TaskPlace.Home, false),
            ],
            false);

    private static Task Deepen(Kit kit, OptionChoice choice, IReadOnlyList<string>? chosen = null, IReadOnlyList<string>? own = null) =>
        DeepenStore.UpdateAsync(kit.Store, User, d => d with
        {
            Content = Deepened(choice),
            Answers = [new DeepenAnswer("q1", "相手に聞く", true)],
            ChosenStepIds = chosen ?? ["s1"],
            OwnSteps = own ?? ["架空の一歩を書く"],
        }, kit.Clock, Ct);

    private static async Task<ReportContent> Build(Kit kit)
    {
        var (ready, content, _) = await ReportBuilder.BuildAsync(kit.Store, User, Catalog, Ct);
        Assert.True(ready);
        return content!;
    }

    /// <summary>利害調整力が見えた力、変化への気づきが確かめ中、優先順位設定力がまだ聞けていない記録。</summary>
    private static async Task<Kit> Recorded()
    {
        var kit = await Create();
        await SaveEpisode(kit, [.. BalancingInterestsAll, NoticingOne]);
        await SetConditions(kit, Conditions());
        await ProfileStore.UpdateAsync(kit.Store, User, p => p with
        {
            Preferences = [new ProfileEntry("家でできる", EntrySource.Chosen)],
            Agency = "自分のペースで始めたい",
        }, kit.Clock, Ct);
        return kit;
    }

    [Fact(DisplayName = "report-5（保留しても開ける）: 話し終えた場面がなければ開けず、案を選んでいなくても保留でも開ける")]
    public async Task ReadyWithFinishedEpisodeEvenWithoutChoice()
    {
        var kit = await Create();
        Assert.Equal((false, (ReportContent?)null, false), await ReportBuilder.BuildAsync(kit.Store, User, Catalog, Ct));

        await SaveEpisode(kit, BalancingInterestsAll, EpisodeStatus.Talking);
        Assert.False((await ReportBuilder.BuildAsync(kit.Store, User, Catalog, Ct)).Ready);

        await SaveEpisode(kit, BalancingInterestsAll);
        var none = await Build(kit);
        Assert.Null(none.Choice.Kind);
        Assert.Null(none.Thinking);
        Assert.Null(none.Steps);

        await SetChoice(kit, new OptionChoice(ChoiceKind.Hold, Now, null, null, null, null, null));
        var hold = await Build(kit);
        Assert.Equal(ChoiceKind.Hold, hold.Choice.Kind);
        Assert.Null(hold.Choice.Title);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 確かめた力、まだ確かめていないこと、5 つの記録、選んだ案、考え方、一歩をまとめる")]
    public async Task BuildsAllSections()
    {
        var kit = await Recorded();
        await SetChoice(kit, ChooseConfirmed());
        await Deepen(kit, ChooseConfirmed());

        var content = await Build(kit);

        // 並びは辞書の順（利害調整力が変化への気づきより前）
        Assert.Equal([TestAbilities.BalancingInterests, TestAbilities.NoticingChanges], content.Abilities.Select(a => a.Ability));
        Assert.Equal(AbilityState.Confirmed, content.Abilities[0].State);
        Assert.Equal(AbilityState.NeedsCheck, content.Abilities[1].State);
        Assert.Equal(NoticingOne.Quote, Assert.Single(content.Abilities[1].Quotes).Quote);
        Assert.Contains(content.Abilities[0].Quotes, q => q.Quote == Q1);

        Assert.Equal([TestAbilities.NoticingChanges], content.NotYet.Checking);
        Assert.False(content.NotYet.HasExcluded);
        // 出張や会食の手配の主な力は利害調整力（使える力）なので、力は出さずに知識や道具だけ
        var gap = Assert.Single(content.NotYet.TaskGaps);
        Assert.Equal(("出張や会食の手配", (Ability?)null), (gap.TaskName, gap.Ability));
        Assert.Equal(["予約サイトの使い方"], gap.Knowledge);

        var preference = Assert.Single(content.Records.Preferences);
        Assert.Equal(EntrySource.Chosen, preference.Source);
        Assert.Equal((10, Place.HomeOnly), (content.Records.Conditions!.HoursPerWeek, content.Records.Conditions.Place));
        Assert.Equal(Conditions().TimeSlots, content.Records.Conditions.TimeSlots);
        Assert.Equal("自分のペースで始めたい", content.Records.Agency);

        Assert.Equal((ChoiceKind.Card, CardKind.Choose, "オンライン秘書"), (content.Choice.Kind, content.Choice.Card, content.Choice.Title));
        Assert.Equal("要約", content.Choice.Summary);
        Assert.Equal(["出張や会食の手配"], content.Choice.Tasks);
        Assert.False(content.Choice.DemandNotChecked);

        var thought = Assert.Single(content.Thinking!);
        Assert.Equal(("急に予定が変わったら、どうしますか？", "相手に聞く", true), (thought.Situation, thought.Answer, thought.FromChoice));
        Assert.Equal(
            [new ReportStep("求人を 3 つ読む", false, true), new ReportStep("架空の一歩を書く", true, true)],
            content.Steps);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 本人が外した力は、どの欄にも出さない")]
    public async Task ExcludedAbilityIsNowhere()
    {
        var kit = await Recorded();
        await SetChoice(kit, ChooseConfirmed());
        Assert.NotNull(await AbilityBook.SetExcludedAsync(kit.Store, User, TestAbilities.BalancingInterests, true, kit.Clock, Ct));

        var content = await Build(kit);

        Assert.DoesNotContain(content.Abilities, a => a.Ability == TestAbilities.BalancingInterests);
        Assert.DoesNotContain(TestAbilities.BalancingInterests, content.NotYet.Checking);
        // 選んだ案の業務の力を外していれば、力の名前は出さずに、外したことだけを持つ
        Assert.True(content.NotYet.HasExcluded);
        Assert.All(content.NotYet.TaskGaps, g => Assert.Null(g.Ability));
        Assert.Null(content.Choice.Ability);
        Assert.Null(content.Choice.Reason);
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 画面に出さない力は、レポートの確かめた力にも選んだ案の理由にも使わない")]
    public async Task HiddenAbilityIsNotInReport()
    {
        var kit = await Create();
        // 利害調整力と優先順位設定力（どちらも行動 3 つ、同じ分類）が同じ出来事でそろう。見せるのは辞書の順で前の利害調整力
        await SaveEpisode(kit,
        [
            .. BalancingInterestsAll,
            E(TestAbilities.SettingPriorities, 1, "用事が三つ重なって"),
            E(TestAbilities.SettingPriorities, 2, "病院を先にしました"),
            E(TestAbilities.SettingPriorities, 3, "熱が高かったからです"),
        ]);
        await SetConditions(kit, Conditions());
        // 優先順位設定力を理由にしたカードを選んでいた
        var hiddenChoice = ChooseChoice() with
        {
            Choose = ChooseChoice().Choose! with
            {
                Ability = new CardAbility(TestAbilities.SettingPriorities, AbilityState.Confirmed, [E(TestAbilities.SettingPriorities, 2, "病院を先にしました")]),
            },
        };
        await SetChoice(kit, hiddenChoice);

        var content = await Build(kit);

        Assert.Equal([TestAbilities.BalancingInterests], content.Abilities.Select(a => a.Ability));
        Assert.Empty(content.NotYet.Checking);
        Assert.Null(content.Choice.Ability);
        Assert.Null(content.Choice.Reason);
        Assert.Equal(MissingReason.Changed, content.Choice.Problem);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 選び直して深めた中身が古ければ、考え方と一歩を出さない")]
    public async Task StaleDeepenIsNotShown()
    {
        var kit = await Recorded();
        await SetChoice(kit, ChooseConfirmed());
        await Deepen(kit, ChooseConfirmed());
        await SetChoice(kit, CombineChoice());

        var content = await Build(kit);

        Assert.Null(content.Thinking);
        Assert.Null(content.Steps);
        Assert.Equal((ChoiceKind.Card, CardKind.Combine, "予定をつなぐ人"), (content.Choice.Kind, content.Choice.Card, content.Choice.Title));
        // 組み合わせるの業務は登録から出す。帳簿と口座の照合の変化への気づきは確かめ中（使える力）なので、知識や道具だけ
        Assert.Equal(["出張や会食の手配", "帳簿と口座の照合"], content.NotYet.TaskGaps.Select(g => g.TaskName));
        Assert.All(content.NotYet.TaskGaps, g => Assert.Null(g.Ability));
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 使える力でない業務の力は、まだ確かめていない力として持つ")]
    public async Task TaskAbilityNotYetConfirmed()
    {
        var kit = await Create();
        await SaveEpisode(kit, BalancingInterestsAll);
        await SetConditions(kit, Conditions());
        await SetChoice(kit, CombineChoice());

        var content = await Build(kit);

        var check = content.NotYet.TaskGaps.Single(g => g.TaskName == "帳簿と口座の照合");
        Assert.Equal(TestAbilities.NoticingChanges, check.Ability);
        Assert.Equal(["簿記の基礎", "会計ソフト"], check.Knowledge);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: まだ確かめていないことに、選んだ案の業務の本人に確かめる条件を並べる")]
    public async Task TaskGapsHaveChecks()
    {
        var kit = await Recorded();
        await SetChoice(kit, CombineChoice());

        var gaps = (await Build(kit)).NotYet.TaskGaps;

        // 帳簿と口座の照合には確かめる条件があり、出張や会食の手配にはない
        Assert.Equal(Catalog.FindTask("accounting-check")!.Checks, gaps.Single(g => g.TaskName == "帳簿と口座の照合").Checks);
        Assert.NotEmpty(gaps.Single(g => g.TaskName == "帳簿と口座の照合").Checks);
        Assert.Empty(gaps.Single(g => g.TaskName == "出張や会食の手配").Checks);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 選んだ案の業務の主な力が準備中なら、まだ確かめていない力に名前を出さない")]
    public async Task PreparingMainAbilityIsNotNamed()
    {
        var kit = await Recorded();
        // 課題の原因の見当づくり: 主な力は原因分析力（準備中）
        await SetChoice(kit, ChooseChoice(taskId: "planning-cause-hypothesis"));

        var content = await Build(kit);

        var gap = Assert.Single(content.NotYet.TaskGaps);
        Assert.Equal(("課題の原因の見当づくり", (Ability?)null), (gap.TaskName, gap.Ability));
        Assert.Equal(Catalog.FindTask("planning-cause-hypothesis")!.Knowledge, gap.Knowledge);
        Assert.False(content.NotYet.HasExcluded);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 選んだ案の理由と力を出すときは、使った力を主な力に持つ業務の力が生きる場面を添え、外したときは添えない")]
    public async Task ChoiceScenes()
    {
        var kit = await Recorded();
        // 出張や会食の手配（主な力は利害調整力）と、帳簿と口座の照合（主な力は変化察知力）を、利害調整力で組み合わせた案
        var combine = CombineChoice() with
        {
            Combine = CombineChoice().Combine! with
            {
                Ability = new CardAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, [E(TestAbilities.BalancingInterests, 1, Q1)]),
            },
        };
        await SetChoice(kit, combine);

        var content = await Build(kit);
        Assert.Null(content.Choice.Problem);
        var scene = Assert.Single(content.Choice.Scenes);
        Assert.Equal(("出張や会食の手配", Catalog.FindTask("online-secretary-arrangement")!.Scene), (scene.TaskName, scene.Scene));

        // 使った力が補助の力にしかない業務（会議や面会の日程調整）には添えない
        var schedule = ChooseChoice(taskId: "online-secretary-schedule") with
        {
            Choose = ChooseChoice(taskId: "online-secretary-schedule").Choose! with
            {
                Ability = new CardAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, [E(TestAbilities.BalancingInterests, 1, Q1)]),
            },
        };
        await SetChoice(kit, schedule);
        var sub = await Build(kit);
        Assert.Null(sub.Choice.Problem);
        Assert.Empty(sub.Choice.Scenes);

        // validate-12（本人が見立てを外せる）: 力を外すと、理由と一緒に力が生きる場面も添えない
        await SetChoice(kit, combine);
        await AbilityBook.SetExcludedAsync(kit.Store, User, TestAbilities.BalancingInterests, true, kit.Clock, Ct);
        var excluded = await Build(kit);
        Assert.Equal(MissingReason.Excluded, excluded.Choice.Problem);
        Assert.Empty(excluded.Choice.Scenes);
    }

    [Fact(DisplayName = "report-3（版を残す）: 前の版には、業務の確かめる条件を残し、力が生きる場面を残さない")]
    public async Task SnapshotKeepsChecksButNotScenes()
    {
        var kit = await Recorded();
        var combine = CombineChoice() with
        {
            Combine = CombineChoice().Combine! with
            {
                Ability = new CardAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, [E(TestAbilities.BalancingInterests, 1, Q1)]),
            },
        };
        await SetChoice(kit, combine);
        var content = await Build(kit);
        Assert.NotEmpty(content.Choice.Scenes);

        var snapshot = ReportSnapshot.From(content);

        var check = snapshot.NotYet.TaskGaps.Single(g => g.TaskName == "帳簿と口座の照合");
        Assert.Equal(Catalog.FindTask("accounting-check")!.Checks, check.Checks);
        var json = JsonSerializer.Serialize(snapshot, DataConstants.Json);
        Assert.DoesNotContain("\"scenes\"", json, StringComparison.Ordinal);
        Assert.DoesNotContain(Catalog.FindTask("online-secretary-arrangement")!.Scene, json, StringComparison.Ordinal);

        // 確かめる条件だけがある業務も、前の版に残す
        var onlyChecks = content with
        {
            NotYet = content.NotYet with { TaskGaps = [new ReportTaskGap("架空の業務", null, [], ["架空の確かめること"])] },
        };
        Assert.Equal(["架空の確かめること"], Assert.Single(ReportSnapshot.From(onlyChecks).NotYet.TaskGaps).Checks);

        // 確かめる条件を持たない前の保存の版も読める
        var old = JsonSerializer.Deserialize<ReportSnapshotTaskGap>("""{"taskName":"帳簿と口座の照合","knowledge":["簿記の基礎"]}""", DataConstants.Json)!;
        Assert.Empty(old.Checks);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 「創る」は需要をまだ確かめていないと持ち、05 のカードが古ければそう持つ")]
    public async Task CreateAndStaleCards()
    {
        var kit = await Recorded();
        await SetChoice(kit, CreateChoice());

        var content = await Build(kit);
        Assert.Equal((CardKind.Create, "近所の予定合わせ"), (content.Choice.Card, content.Choice.Title));
        Assert.True(content.Choice.DemandNotChecked);
        Assert.Empty(content.Choice.Tasks);
        Assert.Contains("小さな子のいる家庭の", content.Choice.Summary);
        Assert.Contains("送迎の都合が合わないこと", content.Choice.Summary);
        Assert.Contains("送迎の予定を取りまとめる事業のアイデア", content.Choice.Summary);
        Assert.Null(OptionsValidator.AssertiveIn(content.Choice.Summary!));
        // 「創る」の業務は深めないとないので出さない
        Assert.Empty(content.NotYet.TaskGaps);
        Assert.False(content.Choice.CardsStale);

        var inputs = await OptionsInputsReader.ReadAsync(kit.Store, User, Ct);
        await OptionsStore.UpdateAsync(kit.Store, User, o => o with { Cards = new OptionCards(Now, OptionsInputsReader.Basis(inputs, Catalog), null, null, null, []) }, kit.Clock, Ct);
        Assert.False((await Build(kit)).Choice.CardsStale);

        await OptionsStore.UpdateAsync(kit.Store, User, o => o with { Cards = new OptionCards(Now, "older", null, null, null, []) }, kit.Clock, Ct);
        Assert.True((await Build(kit)).Choice.CardsStale);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 本人が書いた仕事は、名前とメモを持つ")]
    public async Task OwnJobIsShown()
    {
        var kit = await Recorded();
        await SetChoice(kit, new OptionChoice(ChoiceKind.Own, Now, null, null, null, null, "own1"), Own("家の近くで"));

        var content = await Build(kit);

        Assert.Equal((ChoiceKind.Own, (CardKind?)null, "地域の窓口の手伝い", "家の近くで"), (content.Choice.Kind, content.Choice.Card, content.Choice.Title, content.Choice.Summary));
        Assert.False(content.Choice.OutsideConditions);
        Assert.False(content.Choice.DemandNotChecked);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 選んだカードは理由と力を持ち、力を外すと理由と力を持たずに理由を持つ")]
    public async Task ChosenCardReasonAndProblem()
    {
        var kit = await Recorded();
        await SetChoice(kit, ChooseConfirmed());

        var content = await Build(kit);
        Assert.Equal("理由です。", content.Choice.Reason);
        Assert.Equal((TestAbilities.BalancingInterests, AbilityState.Confirmed), (content.Choice.Ability!.Ability, content.Choice.Ability.State));
        Assert.Equal(Q1, Assert.Single(content.Choice.Ability.Quotes).Quote);
        Assert.Null(content.Choice.Problem);
        Assert.False(content.Choice.OutsideConditions);

        await SetConditions(kit, Conditions(slots: [TimeSlot.Night]));
        Assert.True((await Build(kit)).Choice.OutsideConditions);

        await AbilityBook.SetExcludedAsync(kit.Store, User, TestAbilities.BalancingInterests, true, kit.Clock, Ct);
        var excluded = await Build(kit);
        Assert.Null(excluded.Choice.Reason);
        Assert.Null(excluded.Choice.Ability);
        Assert.Equal(MissingReason.Excluded, excluded.Choice.Problem);
        Assert.Equal("オンライン秘書", excluded.Choice.Title);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 保留中は、前に選んでいた案の考え方と一歩と業務を出さない")]
    public async Task HoldHidesDeepen()
    {
        var kit = await Recorded();
        await SetChoice(kit, ChooseConfirmed());
        await Deepen(kit, ChooseConfirmed());
        await SetChoice(kit, new OptionChoice(ChoiceKind.Hold, Now, null, null, null, null, null));

        var content = await Build(kit);

        Assert.Equal(ChoiceKind.Hold, content.Choice.Kind);
        Assert.Null(content.Thinking);
        Assert.Null(content.Steps);
        Assert.Empty(content.NotYet.TaskGaps);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 選んだ一歩がいまの条件の外なら、そう持つ")]
    public async Task StepOutsideConditions()
    {
        var kit = await Recorded();
        await SetChoice(kit, ChooseConfirmed());
        var deepened = Deepened(ChooseConfirmed());
        var outside = deepened with { Steps = [deepened.Steps[0] with { Place = TaskPlace.Out }, .. deepened.Steps.Skip(1)] };
        await DeepenStore.UpdateAsync(kit.Store, User, d => d with { Content = outside, ChosenStepIds = ["s1"] }, kit.Clock, Ct);

        var step = Assert.Single((await Build(kit)).Steps!);
        Assert.Equal(new ReportStep("求人を 3 つ読む", false, false), step);
    }

    [Fact(DisplayName = "report-3（版を残す）: 欄の指紋は、その欄が変わったときだけ変わる")]
    public async Task SectionHashesChangeOnlyForChangedSection()
    {
        var kit = await Recorded();
        var episode = (await kit.Store.ListByTypeAsync<EpisodeItem>(User, EpisodeItem.ItemType, Ct)).Single().Id;
        await SetChoice(kit, ChooseConfirmed());
        await Deepen(kit, ChooseConfirmed(), chosen: [], own: []);

        var first = ReportBuilder.SectionHashes(await Build(kit));
        Assert.Equal(Enum.GetValues<ReportSection>(), first.Keys.Order());
        Assert.Equal(first, ReportBuilder.SectionHashes(await Build(kit)));
        Assert.Equal(ReportBuilder.Hash(first), ReportBuilder.Hash(ReportBuilder.SectionHashes(await Build(kit))));

        await ProfileStore.UpdateAsync(kit.Store, User, p => p with
        {
            Preferences = [.. p.Preferences, new ProfileEntry("短い時間で", EntrySource.Written)],
        }, kit.Clock, Ct);
        var preferences = ReportBuilder.SectionHashes(await Build(kit));
        Assert.Equal([ReportSection.Records], Changed(first, preferences));
        Assert.NotEqual(ReportBuilder.Hash(first), ReportBuilder.Hash(preferences));

        await DeepenStore.UpdateAsync(kit.Store, User, d => d with { ChosenStepIds = ["s2"] }, kit.Clock, Ct);
        var steps = ReportBuilder.SectionHashes(await Build(kit));
        Assert.Equal([ReportSection.Steps], Changed(preferences, steps));

        // 変化への気づきの根拠の言葉だけが変わる（状態は確かめ中のまま）
        await SaveEpisode(kit, [.. BalancingInterestsAll, NoticingOne with { Quote = "連絡帳の字がいつもより小さくて" }], id: episode);
        var quotes = ReportBuilder.SectionHashes(await Build(kit));
        Assert.Contains(ReportSection.Abilities, Changed(steps, quotes));
    }

    [Fact(DisplayName = "report-4（決めつけない）: コードが組み立てる文は記録の言葉を読点と句点でつなぐだけで、使わない言葉と言い切りの言葉を足さない")]
    public async Task CodeBuiltTextAddsNoJudgingWords()
    {
        var kit = await Recorded();
        var forbidden = ForbiddenWordList.Load();
        OptionChoice?[] choices =
        [
            null,
            new OptionChoice(ChoiceKind.Hold, Now, null, null, null, null, null),
            ChooseConfirmed(),
            CombineChoice(),
            CreateChoice(),
            new OptionChoice(ChoiceKind.Own, Now, null, null, null, null, "own1"),
        ];

        foreach (var choice in choices)
        {
            await SetChoice(kit, choice, Own());
            if (choice is { Kind: ChoiceKind.Card })
            {
                await Deepen(kit, choice);
            }

            var content = await Build(kit);
            Assert.Equal(choice?.Kind, content.Choice.Kind);
            foreach (var text in Texts(content))
            {
                Assert.True(forbidden.FirstIn(text) is null, $"{choice?.Kind} {choice?.Card}: {text}");
                Assert.True(OptionsValidator.AssertiveIn(text) is null, $"{choice?.Kind} {choice?.Card}: {text}");
            }
        }

        // コードが文を組み立てるのは「創る」の中身だけ。誰の、困りごと、中身を、言葉を足さずに読点と句点でつなぐ
        await SetChoice(kit, CreateChoice());
        var card = Card();
        Assert.Equal($"{card.Who}、{card.Trouble}。{card.Summary}", (await Build(kit)).Choice.Summary);
    }

    /// <summary>レポートの中身に入る文字列すべて（画面に出す力の名前を含む）。</summary>
    private static List<string> Texts(ReportContent content)
    {
        var texts = new List<string>();
        Collect(JsonSerializer.SerializeToNode(content, DataConstants.Json), texts);
        var abilities = content.Abilities.Select(a => a.Ability)
            .Concat(content.NotYet.Checking)
            .Concat(content.NotYet.TaskGaps.Where(g => g.Ability is not null).Select(g => g.Ability!.Value))
            .Concat(content.Choice.Ability is { } a ? [a.Ability] : []);
        texts.AddRange(abilities.Select(AbilityText.Name));
        Assert.NotEmpty(texts);
        return texts;
    }

    private static void Collect(JsonNode? node, List<string> texts)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (_, child) in obj)
                {
                    Collect(child, texts);
                }

                break;
            case JsonArray array:
                foreach (var child in array)
                {
                    Collect(child, texts);
                }

                break;
            case JsonValue value when value.TryGetValue<string>(out var text):
                texts.Add(text);
                break;
        }
    }

    private static List<ReportSection> Changed(IReadOnlyDictionary<ReportSection, string> before, IReadOnlyDictionary<ReportSection, string> after) =>
        Enum.GetValues<ReportSection>().Where(s => before[s] != after[s]).ToList();
}
