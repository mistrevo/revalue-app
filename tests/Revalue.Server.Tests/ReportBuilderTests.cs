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

    private static readonly Evidence[] CoordinatingAll =
    [
        E(Ability.Coordinating, 1, Q1),
        E(Ability.Coordinating, 2, "二人に電話しました"),
        E(Ability.Coordinating, 3, "迎えの時間をずらしてもらいました"),
    ];

    private static readonly Evidence NoticingOne = E(Ability.Noticing, 1, "連絡帳の書き方がいつもと違って");

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

    /// <summary>「選ぶ」のカードを、いまの記録の力（調整する力が根拠あり）で選んだ案。</summary>
    private static OptionChoice ChooseConfirmed() =>
        ChooseChoice() with
        {
            Choose = ChooseChoice().Choose! with { Ability = new CardAbility(Ability.Coordinating, AbilityState.Confirmed, [E(Ability.Coordinating, 1, Q1)]) },
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
                new DeepenQuestion("q1", "急に予定が変わったら、どうしますか？", Ability.Coordinating, ["相手に聞く", "予定を見直す", "まず待つ"]),
                new DeepenQuestion("q2", "頼まれごとが重なったら、どうしますか？", Ability.Prioritizing, ["順に並べる", "人に頼む", "まず一つ"]),
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
        var (ready, content) = await ReportBuilder.BuildAsync(kit.Store, User, Catalog, Ct);
        Assert.True(ready);
        return content!;
    }

    /// <summary>調整する力が見えた力、見立てる力が確かめ中、優先順位をつける力がまだ聞けていない記録。</summary>
    private static async Task<Kit> Recorded()
    {
        var kit = await Create();
        await SaveEpisode(kit, [.. CoordinatingAll, NoticingOne]);
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
        Assert.Equal((false, (ReportContent?)null), await ReportBuilder.BuildAsync(kit.Store, User, Catalog, Ct));

        await SaveEpisode(kit, CoordinatingAll, EpisodeStatus.Talking);
        Assert.False((await ReportBuilder.BuildAsync(kit.Store, User, Catalog, Ct)).Ready);

        await SaveEpisode(kit, CoordinatingAll);
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

        Assert.Equal([Ability.Noticing, Ability.Coordinating], content.Abilities.Select(a => a.Ability));
        Assert.Equal(AbilityState.NeedsCheck, content.Abilities[0].State);
        Assert.Equal(AbilityState.Confirmed, content.Abilities[1].State);
        Assert.Equal(NoticingOne.Quote, Assert.Single(content.Abilities[0].Quotes).Quote);
        Assert.Contains(content.Abilities[1].Quotes, q => q.Quote == Q1);

        Assert.Equal([Ability.Prioritizing], content.NotYet.NotHeard);
        Assert.Equal([Ability.Noticing], content.NotYet.Checking);
        Assert.False(content.NotYet.HasExcluded);
        // 日程の調整は調整する力（使える力）なので、力は出さずに知識や道具だけ
        var gap = Assert.Single(content.NotYet.TaskGaps);
        Assert.Equal(("日程の調整", (Ability?)null), (gap.TaskName, gap.Ability));
        Assert.Equal(["オンラインの予定表"], gap.Knowledge);

        var preference = Assert.Single(content.Records.Preferences);
        Assert.Equal(EntrySource.Chosen, preference.Source);
        Assert.Equal((10, Place.HomeOnly), (content.Records.Conditions!.HoursPerWeek, content.Records.Conditions.Place));
        Assert.Equal(Conditions().TimeSlots, content.Records.Conditions.TimeSlots);
        Assert.Equal("自分のペースで始めたい", content.Records.Agency);

        Assert.Equal((ChoiceKind.Card, CardKind.Choose, "オンライン秘書"), (content.Choice.Kind, content.Choice.Card, content.Choice.Title));
        Assert.Equal("要約", content.Choice.Summary);
        Assert.Equal(["日程の調整"], content.Choice.Tasks);
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
        await AbilityBook.SetExcludedAsync(kit.Store, User, Ability.Coordinating, true, kit.Clock, Ct);
        await AbilityBook.SetExcludedAsync(kit.Store, User, Ability.Prioritizing, true, kit.Clock, Ct);

        var content = await Build(kit);

        Assert.DoesNotContain(content.Abilities, a => a.Ability == Ability.Coordinating);
        Assert.DoesNotContain(Ability.Coordinating, content.NotYet.Checking);
        Assert.Empty(content.NotYet.NotHeard);
        // 選んだ案の業務の力を外していれば、力の名前は出さずに、外したことだけを持つ
        Assert.True(content.NotYet.HasExcluded);
        Assert.All(content.NotYet.TaskGaps, g => Assert.Null(g.Ability));
        Assert.Null(content.Choice.Ability);
        Assert.Null(content.Choice.Reason);
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
        // 組み合わせるの業務は登録から出す。帳簿の見直しの見立てる力は確かめ中（使える力）なので、知識や道具だけ
        Assert.Equal(["日程の調整", "帳簿の見直し"], content.NotYet.TaskGaps.Select(g => g.TaskName));
        Assert.All(content.NotYet.TaskGaps, g => Assert.Null(g.Ability));
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 使える力でない業務の力は、まだ確かめていない力として持つ")]
    public async Task TaskAbilityNotYetConfirmed()
    {
        var kit = await Create();
        await SaveEpisode(kit, CoordinatingAll);
        await SetConditions(kit, Conditions());
        await SetChoice(kit, CombineChoice());

        var content = await Build(kit);

        var check = content.NotYet.TaskGaps.Single(g => g.TaskName == "帳簿の見直し");
        Assert.Equal(Ability.Noticing, check.Ability);
        Assert.Equal(["簿記の基礎", "会計ソフト"], check.Knowledge);
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
        await OptionsStore.UpdateAsync(kit.Store, User, o => o with { Cards = new OptionCards(Now, OptionsInputsReader.Basis(inputs), null, null, null, []) }, kit.Clock, Ct);
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
        Assert.Equal((Ability.Coordinating, AbilityState.Confirmed), (content.Choice.Ability!.Ability, content.Choice.Ability.State));
        Assert.Equal(Q1, Assert.Single(content.Choice.Ability.Quotes).Quote);
        Assert.Null(content.Choice.Problem);
        Assert.False(content.Choice.OutsideConditions);

        await SetConditions(kit, Conditions(hours: 1));
        Assert.True((await Build(kit)).Choice.OutsideConditions);

        await AbilityBook.SetExcludedAsync(kit.Store, User, Ability.Coordinating, true, kit.Clock, Ct);
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

        // 見立てる力の根拠の言葉だけが変わる（状態は確かめ中のまま）
        await SaveEpisode(kit, [.. CoordinatingAll, NoticingOne with { Quote = "連絡帳の字がいつもより小さくて" }], id: episode);
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
            .Concat(content.NotYet.NotHeard)
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
