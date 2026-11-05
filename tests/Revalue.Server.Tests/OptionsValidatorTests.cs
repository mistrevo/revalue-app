using System.Text.Json;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class OptionsValidatorTests
{
    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-03T03:00:00Z");
    private static readonly JobCatalog Catalog = JobCatalog.Load();
    private static readonly ForbiddenWordList Forbidden = ForbiddenWordList.Load();

    private const string Q1 = "夫と母の予定がぶつかって";
    private const string Q2 = "班の 2 家族に連絡しました";

    private static Evidence E(Ability ability, int action, string quote) => new(ability, action, quote, 1, 1, false, false, null);

    private static readonly Evidence[] CoordinatingQuotes = [E(TestAbilities.BalancingInterests, 1, Q1), E(TestAbilities.BalancingInterests, 2, Q2)];

    private static OptionsInputs Inputs(
        int hours = 10, Place place = Place.HomeOnly, TimeSlot[]? slots = null, Ability[]? excluded = null, Ability[]? usable = null) =>
        new(
            new ProfileConditions(slots ?? [TimeSlot.Daytime, TimeSlot.Evening], hours, place, 5),
            true,
            (usable ?? [TestAbilities.BalancingInterests]).Select(a => new UsableAbility(
                a, AbilityState.NeedsCheck, a == TestAbilities.BalancingInterests ? CoordinatingQuotes : [E(a, 1, "予定を見比べました")])).ToList(),
            excluded ?? [],
            [],
            [],
            null);

    private static ChooseDraft GoodChoose() => new(true, "online-secretary", ["online-secretary-schedule"], "balancing-interests", "話してくれた「班の 2 家族」への連絡を、日程の調整に生かせるかもしれません。");

    private static CombineDraft GoodCombine() =>
        new(true, ["online-secretary-schedule", "recruiting-interview-schedule"], "予定をつなぐ人", "balancing-interests", "予定を合わせた経験を、二つの仕事に生かせるかもしれません。");

    private static CreateDraft GoodCreate() =>
        new(true, "近所の予定合わせ", "小さな子のいる家庭の", "習い事の送迎の都合が合わないこと", "送迎の予定を取りまとめて、組み合わせを提案する事業のアイデア",
            "balancing-interests", [Q1], 5, "home", ["daytime"], "話してくれた「夫と母の予定がぶつかって」の場面の段取りが、生かせるかもしれません。");

    private static OptionsDraft Draft(ChooseDraft? choose = null, CombineDraft? combine = null, CreateDraft? create = null) =>
        new(choose ?? GoodChoose(), combine ?? GoodCombine(), create ?? GoodCreate());

    private static (OptionCards Cards, IReadOnlyList<CardRejection> Rejections) Build(OptionsDraft draft, OptionsInputs? inputs = null, JobCatalog? catalog = null)
    {
        inputs ??= Inputs();
        catalog ??= Catalog;
        return OptionsValidator.Build(draft, OptionCandidates.From(catalog, inputs), inputs, catalog, Forbidden, Now);
    }

    /// <summary>登録データのうち、決めた職種だけの業務マスター。条件に合う業務がないときを作るために使う。</summary>
    private static JobCatalog Only(params string[] occupationIds) =>
        Catalog with { Occupations = Catalog.Occupations.Where(o => occupationIds.Contains(o.Id)).ToList() };

    private static void AssertRejected(CardKind kind, string rule, OptionsDraft draft, OptionsInputs? inputs = null)
    {
        var (cards, rejections) = Build(draft, inputs);
        Assert.Contains(new CardRejection(kind, rule), rejections);
        Assert.Contains(new MissingCard(kind, MissingReason.Rejected), cards.Missing);
        Assert.True(kind switch
        {
            CardKind.Choose => cards.Choose is null,
            CardKind.Combine => cards.Combine is null,
            _ => cards.Create is null,
        });
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 候補の職種と業務と使える力でできた選ぶは、カードになる")]
    public void ValidChooseBecomesACard()
    {
        var (cards, rejections) = Build(Draft());

        Assert.Empty(rejections);
        var choose = cards.Choose!;
        Assert.Equal("オンライン秘書", choose.OccupationName);
        Assert.Equal("online-secretary-schedule", Assert.Single(choose.Tasks).TaskId);
        Assert.Equal([TimeSlot.Daytime, TimeSlot.Evening], choose.Tasks[0].TimeSlots);
        Assert.Equal(new WorkRange(3, 10, 15000, 80000), choose.Range);
        Assert.Equal((TestAbilities.BalancingInterests, AbilityState.NeedsCheck), (choose.Ability.Ability, choose.Ability.State));
        Assert.Equal([Q1, Q2], choose.Ability.Quotes.Select(q => q.Quote));
        Assert.Empty(cards.Missing);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 登録にない ID の選ぶは出さない")]
    public void UnknownIdsAreRejected()
    {
        AssertRejected(CardKind.Choose, "unknownId", Draft(choose: GoodChoose() with { OccupationId = "no-such" }));
        AssertRejected(CardKind.Choose, "unknownId", Draft(choose: GoodChoose() with { TaskIds = ["no-such-task"] }));
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 選んだ職種の業務でない業務、業務の数が合わない選ぶは出さない")]
    public void WrongOccupationAndTaskCountAreRejected()
    {
        AssertRejected(CardKind.Choose, "wrongOccupation", Draft(choose: GoodChoose() with { TaskIds = ["recruiting-interview-schedule"] }));
        AssertRejected(CardKind.Choose, "taskCount", Draft(choose: GoodChoose() with { TaskIds = [] }));
        AssertRejected(CardKind.Choose, "taskCount", Draft(choose: GoodChoose() with { TaskIds = ["online-secretary-schedule", "online-secretary-schedule"] }));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 登録にあっても条件に合わない業務は出さない")]
    public void RegisteredButOutOfConditionsTaskIsRejected()
    {
        var choose = new ChooseDraft(true, "accounting-clerk", ["accounting-cash"], "noticing-changes", "見立ててきた経験が生かせるかもしれません。");
        var inputs = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.NoticingChanges]);

        var (cards, rejections) = Build(Draft(choose: choose), inputs);

        Assert.Null(cards.Choose);
        Assert.Contains(new CardRejection(CardKind.Choose, "unknownId"), rejections);
        Assert.Contains(new MissingCard(CardKind.Choose, MissingReason.Rejected), cards.Missing);
    }

    [Fact(DisplayName = "options-3（組み合わせるは登録した業務から）: 1 つの職種だけの組み合わせ、業務が 1 つ、始めやすさの合計が本人の時間を超える組み合わせは出さない")]
    public void BadCombinationsAreRejected()
    {
        var (cards, rejections) = Build(Draft());
        Assert.Empty(rejections);
        Assert.Equal(2, cards.Combine!.Tasks.Count);
        Assert.NotNull(cards.Combine.Range);

        AssertRejected(CardKind.Combine, "singleOccupation", Draft(combine: GoodCombine() with { TaskIds = ["online-secretary-schedule", "online-secretary-arrangement"] }));
        AssertRejected(CardKind.Combine, "taskCount", Draft(combine: GoodCombine() with { TaskIds = ["online-secretary-schedule"] }));
        AssertRejected(CardKind.Combine, "unknownId", Draft(combine: GoodCombine() with { TaskIds = ["online-secretary-schedule", "no-such"] }));
        // 3 + 3 = 6 時間から。本人は週 5 時間
        AssertRejected(CardKind.Combine, "overHours", Draft(combine: GoodCombine()), Inputs(hours: 5));
    }

    [Fact(DisplayName = "options-4（創るは根拠を引けるときだけ）: 根拠の言葉と一字一句同じ言葉を引いた創るだけを出す")]
    public void CreateNeedsVerbatimQuotes()
    {
        var (cards, rejections) = Build(Draft(create: GoodCreate() with { Quotes = [$" {Q1} "] }));
        Assert.Empty(rejections);
        Assert.Equal([Q1], cards.Create!.Ability.Quotes.Select(q => q.Quote));

        AssertRejected(CardKind.Create, "quoteNotVerbatim", Draft(create: GoodCreate() with { Quotes = ["夫と母の予定がぶつかった"] }));
        AssertRejected(CardKind.Create, "quoteNotVerbatim", Draft(create: GoodCreate() with { Quotes = [] }));
        AssertRejected(CardKind.Create, "quoteNotVerbatim", Draft(create: GoodCreate() with { Quotes = [Q1, Q2, Q1, Q2] }));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 創るは、時間、場所、時間帯が本人の条件に収まるときだけ出す")]
    public void CreateMustFitConditions()
    {
        AssertRejected(CardKind.Create, "overHours", Draft(create: GoodCreate() with { HoursPerWeek = 11 }));
        AssertRejected(CardKind.Create, "overHours", Draft(create: GoodCreate() with { HoursPerWeek = 0 }));
        AssertRejected(CardKind.Create, "outsideConditions", Draft(create: GoodCreate() with { Place = "out" }));
        AssertRejected(CardKind.Create, "outsideConditions", Draft(create: GoodCreate() with { Place = "abroad" }));
        AssertRejected(CardKind.Create, "outsideConditions", Draft(create: GoodCreate() with { TimeSlots = ["night"] }));
        AssertRejected(CardKind.Create, "outsideConditions", Draft(create: GoodCreate() with { TimeSlots = [] }));
        AssertRejected(CardKind.Create, "outsideConditions", Draft(create: GoodCreate() with { TimeSlots = ["noon"] }));

        var (cards, _) = Build(Draft(create: GoodCreate() with { Place = "out" }), Inputs(place: Place.CanGoOut));
        Assert.Equal(TaskPlace.Out, cards.Create!.Place);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 外した力、使えない力、業務と合わない力のカードは出さない")]
    public void AbilityMustBeUsableAndMatchTasks()
    {
        AssertRejected(CardKind.Choose, "abilityNotUsable", Draft(choose: GoodChoose() with { Ability = "noticing-changes" }));
        AssertRejected(CardKind.Choose, "abilityNotUsable", Draft(choose: GoodChoose() with { Ability = "cooking" }));
        AssertRejected(CardKind.Combine, "abilityNotUsable", Draft(combine: GoodCombine() with { Ability = "setting-priorities" }));
        AssertRejected(CardKind.Create, "abilityNotUsable", Draft(create: GoodCreate() with { Ability = "noticing-changes" }));
        // 外した力は使える力に入らない
        var excluded = Inputs(excluded: [TestAbilities.NoticingChanges], usable: [TestAbilities.BalancingInterests]);
        AssertRejected(CardKind.Choose, "abilityNotUsable", Draft(choose: GoodChoose() with { Ability = "noticing-changes" }), excluded);
        // 変化への気づきは使えるが、会議や面会の日程調整の業務の力（主な力と補助の力）にない
        var both = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.NoticingChanges]);
        AssertRejected(CardKind.Choose, "abilityNotInTasks", Draft(choose: GoodChoose() with { Ability = "noticing-changes", Reason = "見立ててきた経験が生かせるかもしれません。" }), both);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 選ぶの力は、業務の主な力でも補助の力でもよく、どちらでもない力なら落とす")]
    public void ChooseAbilityMayBeMainOrSub()
    {
        // 会議や面会の日程調整の主な力は段取り力、利害調整力は補助の力
        var schedule = Catalog.FindTask("online-secretary-schedule")!;
        Assert.Equal(TestAbilities.PlanningSteps, schedule.Abilities.Main);
        Assert.Contains(TestAbilities.BalancingInterests, schedule.Abilities.Sub);

        var (cards, rejections) = Build(Draft());
        Assert.Empty(rejections);
        Assert.Equal(TestAbilities.BalancingInterests, cards.Choose!.Ability.Ability);
        // カードの業務の写しの力は、業務の主な力
        Assert.Equal(TestAbilities.PlanningSteps, Assert.Single(cards.Choose.Tasks).Ability);

        var withEmpathy = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.Empathy]);
        AssertRejected(CardKind.Choose, "abilityNotInTasks", Draft(choose: GoodChoose() with { Ability = "empathy", Reason = "見立ててきた経験が生かせるかもしれません。" }), withEmpathy);
    }

    [Fact(DisplayName = "options-3（組み合わせるは登録した業務から）: 組み合わせるの力は、業務のどれかの主な力か補助の力")]
    public void CombineAbilityMayBeMainOrSub()
    {
        var (cards, rejections) = Build(Draft());
        Assert.Empty(rejections);
        Assert.Equal(TestAbilities.BalancingInterests, cards.Combine!.Ability.Ability);

        var withEmpathy = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.Empathy]);
        AssertRejected(CardKind.Combine, "abilityNotInTasks", Draft(combine: GoodCombine() with { Ability = "empathy" }), withEmpathy);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 準備中の業務の id は、渡していない ID として落とす")]
    public void PreparingTaskIdsAreUnknown()
    {
        var inputs = Inputs(place: Place.CanGoOut, usable: [TestAbilities.BalancingInterests, TestAbilities.ActiveListening]);

        AssertRejected(CardKind.Choose, "unknownId",
            Draft(choose: new ChooseDraft(true, "insurance-sales", ["insurance-sales-hearing"], "active-listening", "見立ててきた経験が生かせるかもしれません。")), inputs);
        AssertRejected(CardKind.Combine, "unknownId",
            Draft(combine: GoodCombine() with { TaskIds = ["online-secretary-schedule", "insurance-sales-hearing"] }), inputs);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 業務の準備中の力（原因分析力）は、カードの力にできない")]
    public void PreparingAbilityIsNotUsable()
    {
        var sensing = new Ability("sensing-incongruity");
        var inputs = Inputs(usable: [TestAbilities.BalancingInterests, sensing]);

        AssertRejected(CardKind.Choose, "abilityNotUsable",
            Draft(choose: new ChooseDraft(true, "planner", ["planning-cause-hypothesis"], "cause-analysis", "見立ててきた経験が生かせるかもしれません。")), inputs);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 理由の「」の言葉が本人の根拠にないカードは出さない。根拠の言葉の一部を一字一句そのまま引くのはよい")]
    public void BracketQuoteNotInEvidenceIsRejected()
    {
        AssertRejected(CardKind.Choose, "bracketNotVerbatim", Draft(choose: GoodChoose() with { Reason = "「早めに連絡しました」と話してくれた経験が、生かせるかもしれません。" }));
        AssertRejected(CardKind.Combine, "bracketNotVerbatim", Draft(combine: GoodCombine() with { Reason = "「早め」の連絡が、二つの仕事に生かせるかもしれません。" }));
        AssertRejected(CardKind.Create, "bracketNotVerbatim", Draft(create: GoodCreate() with { Reason = "「早めに連絡しました」の経験が、生かせるかもしれません。" }));
        AssertRejected(CardKind.Choose, "bracketNotVerbatim", Draft(choose: GoodChoose() with { Reason = "話してくれた「」の経験が、生かせるかもしれません。" }));

        var (cards, rejections) = Build(Draft(choose: GoodChoose() with { Reason = "「班の 2 家族」への連絡が、日程の調整に生かせるかもしれません。" }));
        Assert.Empty(rejections);
        Assert.NotNull(cards.Choose);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 理由の「」が、カードに使った力でない力の根拠の言葉や、「創る」で引かなかった言葉を引いたカードは出さない")]
    public void BracketQuoteFromOtherEvidenceIsRejected()
    {
        // 変化への気づきの根拠「予定を見比べました」は、利害調整力のカードの理由には引けない。あとでその場面を確かめに使わなくなっても、
        // 利害調整力のカードは見張られないまま、言葉が理由に残るため
        var both = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.NoticingChanges]);
        const string other = "話してくれた「予定を見比べました」ときの動き方を、生かせるかもしれません。";
        AssertRejected(CardKind.Choose, "bracketNotVerbatim", Draft(choose: GoodChoose() with { Reason = other }), both);
        AssertRejected(CardKind.Combine, "bracketNotVerbatim", Draft(combine: GoodCombine() with { Reason = other }), both);
        AssertRejected(CardKind.Create, "bracketNotVerbatim", Draft(create: GoodCreate() with { Reason = other }), both);

        // 「創る」は、引いた言葉（Q1）だけを理由に引ける。同じ力の根拠でも、引いていない Q2 はカードに添えないので引けない
        AssertRejected(CardKind.Create, "bracketNotVerbatim", Draft(create: GoodCreate() with { Reason = $"話してくれた「{Q2}」ときの動き方が、生かせるかもしれません。" }), both);
        var (cards, rejections) = Build(Draft(create: GoodCreate() with { Quotes = [Q1, Q2], Reason = $"話してくれた「{Q2}」ときの動き方が、生かせるかもしれません。" }), both);
        Assert.NotNull(cards.Create);
        Assert.DoesNotContain(rejections, r => r.Kind == CardKind.Create);
        Assert.Equal([Q1, Q2], cards.Create!.Ability.Quotes.Select(q => q.Quote));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 褒め言葉を含む文のカードは出さない。「得意先」「プロジェクト」と、「」で引いた本人の言葉の中は数えない")]
    public void PraiseWordsAreRejected()
    {
        AssertRejected(CardKind.Choose, "praiseWord", Draft(choose: GoodChoose() with { Reason = "段取りのプロとして、日程の調整に生かせるかもしれません。" }));
        AssertRejected(CardKind.Choose, "praiseWord", Draft(choose: GoodChoose() with { Reason = "得意な段取りを、日程の調整に生かせるかもしれません。" }));
        AssertRejected(CardKind.Combine, "praiseWord", Draft(combine: GoodCombine() with { RoleName = "予定合わせの達人" }));
        AssertRejected(CardKind.Create, "praiseWord", Draft(create: GoodCreate() with { Summary = "すばらしい段取りで、送迎の予定を取りまとめる事業のアイデア" }));
        AssertRejected(CardKind.Create, "praiseWord", Draft(create: GoodCreate() with { Title = "素敵な予定合わせ" }));

        var (plain, plainRejections) = Build(Draft(choose: GoodChoose() with { Reason = "予定を合わせた経験を、得意先との日程の調整や、プロジェクトの予定の取りまとめに生かせるかもしれません。" }));
        Assert.NotNull(plain.Choose);
        Assert.DoesNotContain(plainRejections, r => r.Kind == CardKind.Choose);

        // 本人の言葉に褒め言葉があっても、「」で一字一句引くなら落とさない
        const string own = "素敵な会になったと言われました";
        var inputs = Inputs() with
        {
            Abilities = [new UsableAbility(TestAbilities.BalancingInterests, AbilityState.NeedsCheck, [.. CoordinatingQuotes, E(TestAbilities.BalancingInterests, 3, own)])],
        };
        var (cards, rejections) = Build(
            Draft(choose: GoodChoose() with { Reason = $"話してくれた「{own}」ときの動き方を、日程の調整に生かせるかもしれません。" }), inputs);
        Assert.NotNull(cards.Choose);
        Assert.DoesNotContain(rejections, r => r.Kind == CardKind.Choose);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 理由で「」のほかの括弧（『』や “” など）と、閉じていない「」を使ったカードは出さない")]
    public void OtherBracketKindsInReasonAreRejected()
    {
        // 括弧の種類を変えると、カードの力の根拠に限る照らし合わせを抜けて、ほかの力の言葉を引けてしまうため
        var both = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.NoticingChanges]);
        foreach (var reason in new[]
        {
            "話してくれた『予定を見比べました』ときの動き方を、生かせるかもしれません。",
            "話してくれた“予定を見比べました”ときの動き方を、生かせるかもしれません。",
            $"話してくれた「{Q1}ときの動き方を、生かせるかもしれません。",
            $"話してくれた{Q1}」ときの動き方を、生かせるかもしれません。",
        })
        {
            AssertRejected(CardKind.Choose, "bracketKind", Draft(choose: GoodChoose() with { Reason = reason }), both);
        }
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 根拠の言葉を「」なしで写したカードは出さない。理由の「」の外で、カードに添える根拠の言葉を言い換えるのはよい")]
    public void CopiedEvidenceIsRejected()
    {
        // 役割の名前と「創る」の文は、選んだあとで力を外したり場面を飛ばしたりしても案の中身として残るので、どの力の根拠も写させない
        var both = Inputs(usable: [TestAbilities.BalancingInterests, TestAbilities.NoticingChanges]);
        AssertRejected(CardKind.Create, "evidenceCopied", Draft(create: GoodCreate() with { Who = $"{Q1}困っている家庭の" }), both);
        AssertRejected(CardKind.Create, "evidenceCopied", Draft(create: GoodCreate() with { Trouble = "予定を見比べましたが決まらないこと" }), both);
        AssertRejected(CardKind.Create, "evidenceCopied", Draft(create: GoodCreate() with { Summary = $"{Q2}、という段取りを手伝う事業のアイデア" }), both);
        AssertRejected(CardKind.Combine, "evidenceCopied", Draft(combine: GoodCombine() with { RoleName = "班の2家族に連絡しました人" }), both);
        // 理由の「」の外でも、カードに添えない言葉（ほかの力の根拠、「創る」で引かなかった言葉）は写させない
        AssertRejected(CardKind.Choose, "evidenceCopied", Draft(choose: GoodChoose() with { Reason = "予定を見比べましたという動き方を、生かせるかもしれません。" }), both);
        AssertRejected(CardKind.Create, "evidenceCopied", Draft(create: GoodCreate() with { Reason = $"話してくれた「{Q1}」ときと、{Q2}ときの動き方が、生かせるかもしれません。" }), both);

        // カードに添える根拠の言葉なら、理由の「」の外で写してもよい（力が変われば、理由ごと出さなくなる）
        var (cards, rejections) = Build(Draft(choose: GoodChoose() with { Reason = $"{Q1}、そのあと連絡した動き方を、日程の調整に生かせるかもしれません。" }), both);
        Assert.NotNull(cards.Choose);
        Assert.DoesNotContain(rejections, r => r.Kind == CardKind.Choose);
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 円を付けない書き方のお金の額も、カードに書かせない")]
    public void MoneyWithoutYenIsRejected()
    {
        foreach (var summary in new[]
        {
            "送迎の予定を取りまとめる事業のアイデアで、月に5万ほどです",
            "送迎の予定を取りまとめる事業のアイデアで、時給1500くらいです",
            "送迎の予定を取りまとめる事業のアイデアで、1回3000えんです",
            "送迎の予定を取りまとめる事業のアイデアで、月3万程度です",
            "送迎の予定を取りまとめる事業のアイデアで、数万になります",
        })
        {
            AssertRejected(CardKind.Create, "moneyAmount", Draft(create: GoodCreate() with { Summary = summary }));
        }

        // 時間の数は額ではない
        var (cards, rejections) = Build(Draft(create: GoodCreate() with { Summary = "週 5 時間で、送迎の予定を取りまとめる事業のアイデア" }));
        Assert.NotNull(cards.Create);
        Assert.DoesNotContain(rejections, r => r.Kind == CardKind.Create);
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 言い切り、順位、褒め言葉の表記ゆれも、カードに書かせない")]
    public void AssertiveAndPraiseVariantsAreRejected()
    {
        foreach (var reason in new[] { "日程の調整にオススメです。", "日程の調整に向いてる経験です。", "日程の調整の適任です。", "ベストな案です。", "イチオシの案です。" })
        {
            AssertRejected(CardKind.Choose, "assertiveWord", Draft(choose: GoodChoose() with { Reason = reason }));
        }

        foreach (var reason in new[] { "素晴らしく段取りができる経験です。", "プロフェッショナルな段取りです。", "見事な段取りです。", "抜群の段取りです。" })
        {
            AssertRejected(CardKind.Choose, "praiseWord", Draft(choose: GoodChoose() with { Reason = reason }));
        }
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 「優先順位」の「順位」は、力の名前の外でも、使わない言葉として数えない")]
    public void PriorityWordIsNotForbidden()
    {
        const string own = "優先順位を決めて、書類を先にしました";
        var inputs = Inputs() with
        {
            Abilities = [new UsableAbility(TestAbilities.BalancingInterests, AbilityState.NeedsCheck, [.. CoordinatingQuotes, E(TestAbilities.BalancingInterests, 3, own)])],
        };
        var (cards, rejections) = Build(
            Draft(choose: GoodChoose() with { Reason = $"話してくれた「{own}」ときの、優先順位の決め方を、日程の調整に生かせるかもしれません。" }), inputs);
        Assert.NotNull(cards.Choose);
        Assert.DoesNotContain(rejections, r => r.Kind == CardKind.Choose);
        Assert.Equal("順位", Forbidden.FirstIn("カードに順位を付けます"));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 選んだ案が、いまの条件に収まるかを確かめられる")]
    public void ChosenCardFitsCurrentConditions()
    {
        var inputs = Inputs();
        var (cards, _) = Build(Draft(), inputs);
        var create = new OptionChoice(ChoiceKind.Card, Now, CardKind.Create, null, null, cards.Create, null);
        var choose = new OptionChoice(ChoiceKind.Card, Now, CardKind.Choose, cards.Choose, null, null, null);
        Assert.True(OptionsValidator.ChosenFits(create, inputs.Conditions!, Catalog));
        Assert.True(OptionsValidator.ChosenFits(choose, inputs.Conditions!, Catalog));

        // 「創る」は週 5 時間、日中。週 3 時間、夜だけにすると収まらない
        var narrowed = Inputs(hours: 3, slots: [TimeSlot.Night]).Conditions!;
        Assert.False(OptionsValidator.ChosenFits(create, narrowed, Catalog));
        Assert.False(OptionsValidator.ChosenFits(choose, narrowed, Catalog));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 飛ばして消えた本人の言葉を持つカードは捨て、選んだ案からは理由と根拠の言葉を消す")]
    public void ScrubRemovesSkippedWords()
    {
        var inputs = Inputs();
        var (cards, _) = Build(Draft(), inputs);
        var item = new OptionsItem
        {
            Id = OptionsItem.ItemId,
            UserKey = "u",
            Type = OptionsItem.ItemType,
            Cards = cards,
            Choice = new OptionChoice(ChoiceKind.Card, Now, CardKind.Create, null, null, cards.Create, null),
        };

        // 根拠の言葉がどれも残っていれば、何も変えない
        Assert.Same(item, OptionsScrub.Scrub(item, [$"{Q1}いたので、{Q2}。"]));

        // Q2 を話した場面を飛ばした。Q2 を根拠に持つ選ぶと組み合わせるは捨てる。「創る」は Q1 だけを引いていたので残す
        var scrubbed = OptionsScrub.Scrub(item, [$"{Q1}いました。"]);
        Assert.Null(scrubbed.Cards!.Choose);
        Assert.Null(scrubbed.Cards.Combine);
        Assert.NotNull(scrubbed.Cards.Create);
        Assert.Contains(new MissingCard(CardKind.Choose, MissingReason.Changed), scrubbed.Cards.Missing);
        Assert.False(scrubbed.Choice!.SourceRemoved);

        // Q1 も消えた。選んだ「創る」は中身を残し、理由と根拠の言葉を消す
        var gone = OptionsScrub.Scrub(item, []);
        Assert.Null(gone.Cards!.Create);
        Assert.True(gone.Choice!.SourceRemoved);
        Assert.Equal("", gone.Choice.Create!.Reason);
        Assert.Empty(gone.Choice.Create.Ability.Quotes);
        Assert.Equal(cards.Create!.Title, gone.Choice.Create.Title);
        Assert.Equal(MissingReason.Changed, gone.Choice.AbilityProblem(inputs));
        var raw = new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping };
        Assert.Contains(Q1, JsonSerializer.Serialize(item, raw));
        var serialized = JsonSerializer.Serialize(gone, raw);
        Assert.DoesNotContain(Q1, serialized);
        Assert.DoesNotContain(Q2, serialized);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: カードの理由に使えない力を外したり戻したりしても、元の記録の指紋は変わらず、作り直さない")]
    public void ExcludingUnusableAbilityKeepsBasis()
    {
        var inputs = Inputs();
        // 変化への気づきはまだ聞けていない（使える力の一覧にない）。外しても戻しても、AI を呼んで作り直す理由にならない
        Assert.Equal(OptionsInputsReader.Basis(inputs), OptionsInputsReader.Basis(inputs with { Excluded = [TestAbilities.NoticingChanges] }));
        // 使える力を外すと、使える力の一覧が変わるので指紋も変わる
        Assert.NotEqual(OptionsInputsReader.Basis(inputs), OptionsInputsReader.Basis(Inputs(excluded: [TestAbilities.BalancingInterests], usable: [])));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 理由の「」の言葉が、根拠の言葉の一部でも、空白と記号を除いて 4 文字に満たないカードは出さない")]
    public void TooShortBracketQuoteIsRejected()
    {
        // 「家族」「2 家族」は根拠の言葉「班の 2 家族に連絡しました」の一部だが、それだけでは何の話か分からない
        AssertRejected(CardKind.Choose, "bracketTooShort", Draft(choose: GoodChoose() with { Reason = "話してくれた「家族」のことが、日程の調整に生かせるかもしれません。" }));
        AssertRejected(CardKind.Combine, "bracketTooShort", Draft(combine: GoodCombine() with { Reason = "話してくれた「2 家族」への連絡が、二つの仕事に生かせるかもしれません。" }));

        // 4 文字（の、2、家、族）なら引ける
        var (cards, rejections) = Build(Draft(choose: GoodChoose() with { Reason = "話してくれた「の 2 家族」への連絡が、日程の調整に生かせるかもしれません。" }));
        Assert.NotNull(cards.Choose);
        Assert.Empty(rejections);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 理由のほかの文に「」や『』があるカードは、根拠の言葉どおりでも出さない")]
    public void BracketsOutsideReasonAreRejected()
    {
        // 選んだあとで力を外すと理由は出さなくなるが、役割の名前や「創る」の文は案の中身として残るため
        AssertRejected(CardKind.Combine, "bracketOutsideReason", Draft(combine: GoodCombine() with { RoleName = $"「{Q1}」の人" }));
        AssertRejected(CardKind.Combine, "bracketOutsideReason", Draft(combine: GoodCombine() with { RoleName = "「早め」の人" }));
        AssertRejected(CardKind.Create, "bracketOutsideReason", Draft(create: GoodCreate() with { Title = $"「{Q1}」の手伝い" }));
        AssertRejected(CardKind.Create, "bracketOutsideReason", Draft(create: GoodCreate() with { Who = $"「{Q1}」家庭の" }));
        AssertRejected(CardKind.Create, "bracketOutsideReason", Draft(create: GoodCreate() with { Trouble = $"『{Q1}』こと" }));
        AssertRejected(CardKind.Create, "bracketOutsideReason", Draft(create: GoodCreate() with { Summary = $"「{Q1}」ときの予定を取りまとめる事業のアイデア" }));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: AI が書いた文にお金の額があるカードは出さない。「」で引いた本人の言葉の中と、額でない「円」は数えない")]
    public void MoneyAmountsAreRejected()
    {
        // 「創る」は需要を確かめていないので収入の数字を出さない。「選ぶ」と「組み合わせる」の収入の目安は、コードが登録の業務から計算する
        AssertRejected(CardKind.Create, "moneyAmount", Draft(create: GoodCreate() with { Summary = "送迎の予定を取りまとめる事業のアイデアで、1 回 3,000 円くらいです" }));
        AssertRejected(CardKind.Create, "moneyAmount", Draft(create: GoodCreate() with { Trouble = "月に数万円かかる送迎の費用" }));
        AssertRejected(CardKind.Create, "moneyAmount", Draft(create: GoodCreate() with { Title = "千円でできる予定合わせ" }));
        AssertRejected(CardKind.Create, "moneyAmount", Draft(create: GoodCreate() with { Reason = $"話してくれた「{Q1}」の場面の段取りで、月 5 万円になるかもしれません。" }));
        AssertRejected(CardKind.Choose, "moneyAmount", Draft(choose: GoodChoose() with { Reason = "日程の調整で、¥30000 くらいになるかもしれません。" }));
        AssertRejected(CardKind.Combine, "moneyAmount", Draft(combine: GoodCombine() with { Reason = "予定を合わせた経験で、時給１２００円の仕事に生かせるかもしれません。" }));

        const string own = "会費を 500 円ずつ集めました";
        var inputs = Inputs() with
        {
            Abilities = [new UsableAbility(TestAbilities.BalancingInterests, AbilityState.NeedsCheck, [.. CoordinatingQuotes, E(TestAbilities.BalancingInterests, 3, own)])],
        };
        var (cards, rejections) = Build(
            Draft(choose: GoodChoose() with { Reason = $"話してくれた「{own}」の動きを、日程の調整を円滑に進めるのに生かせるかもしれません。" }), inputs);
        Assert.NotNull(cards.Choose);
        Assert.DoesNotContain(rejections, r => r.Kind == CardKind.Choose);
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 使わない言葉を含む文のカードは出さない。力の名前の「順位」は数えない")]
    public void ForbiddenWordsAreRejectedButAbilityNamesAreNot()
    {
        AssertRejected(CardKind.Choose, "forbiddenWord", Draft(choose: GoodChoose() with { Reason = "あなたに向いている仕事は日程の調整です。" }));
        AssertRejected(CardKind.Combine, "forbiddenWord", Draft(combine: GoodCombine() with { RoleName = "適職の人" }));

        var (cards, rejections) = Build(Draft(choose: GoodChoose() with { Reason = "優先順位設定力が生かせます。" }));
        Assert.Empty(rejections);
        Assert.NotNull(cards.Choose);
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 言い切りと順位の言葉を含む文のカードは出さない。「」で引いた本人の言葉の中は数えない")]
    public void AssertiveWordsHideCards()
    {
        foreach (var reason in new[]
        {
            "予定を合わせた経験は、日程の調整にぴったりです。",
            "日程の調整に向いています。",
            "3 つの中でいちばんおすすめの案です。",
            "予定を合わせた経験が、最も生かせる仕事です。",
        })
        {
            AssertRejected(CardKind.Choose, "assertiveWord", Draft(choose: GoodChoose() with { Reason = reason }));
        }

        AssertRejected(CardKind.Combine, "assertiveWord", Draft(combine: GoodCombine() with { RoleName = "最適な予定係" }));
        AssertRejected(CardKind.Create, "assertiveWord", Draft(create: GoodCreate() with { Summary = "いちばん困っている家庭に、送迎の予定を取りまとめる事業のアイデア" }));

        // 本人の言葉に「いちばん」があっても、「」で一字一句引くなら落とさない
        const string own = "いちばん先に母に電話しました";
        var inputs = Inputs() with
        {
            Abilities = [new UsableAbility(TestAbilities.BalancingInterests, AbilityState.NeedsCheck, [.. CoordinatingQuotes, E(TestAbilities.BalancingInterests, 3, own)])],
        };
        var (cards, rejections) = Build(
            Draft(choose: GoodChoose() with { Reason = $"話してくれた「{own}」の動きを、日程の調整に生かせるかもしれません。" }), inputs);
        Assert.NotNull(cards.Choose);
        Assert.DoesNotContain(rejections, r => r.Kind == CardKind.Choose);
    }

    [Fact(DisplayName = "common-1（使わない言葉を出さない）: 空の文と長すぎる文のカードは出さない")]
    public void EmptyAndTooLongAreRejected()
    {
        AssertRejected(CardKind.Choose, "empty", Draft(choose: GoodChoose() with { Reason = "　 " }));
        AssertRejected(CardKind.Choose, "tooLong", Draft(choose: GoodChoose() with { Reason = new string('あ', OptionsValidator.MaxReason + 1) }));
        AssertRejected(CardKind.Combine, "tooLong", Draft(combine: GoodCombine() with { RoleName = new string('あ', OptionsValidator.MaxRoleName + 1) }));
        AssertRejected(CardKind.Create, "tooLong", Draft(create: GoodCreate() with { Title = new string('あ', OptionsValidator.MaxTitle + 1) }));
        // 見た目が短くても、結合文字を重ねて中身を長くした文は断る
        AssertRejected(CardKind.Choose, "tooLong", Draft(choose: GoodChoose() with { Reason = "あ" + new string('́', OptionsValidator.MaxReason * 4) }));
        var (cards, _) = Build(Draft(choose: GoodChoose() with { Reason = new string('あ', OptionsValidator.MaxReason) }));
        Assert.NotNull(cards.Choose);
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 候補で作れないカードは、AI の答えを見ずに出せない理由を返す")]
    public void CardsWithoutCandidatesAreNoFitWithoutLookingAtTheDraft()
    {
        // 経理事務と採用事務だけで、週 1 時間・夜だけ・家だけ: 条件に合う業務がない
        var inputs = Inputs(hours: 1, slots: [TimeSlot.Night]);
        var (cards, rejections) = Build(Draft(), inputs, Only("accounting-clerk", "recruiting-clerk"));

        Assert.Contains(new MissingCard(CardKind.Choose, MissingReason.NoFit), cards.Missing);
        Assert.Contains(new MissingCard(CardKind.Combine, MissingReason.NoFit), cards.Missing);
        Assert.DoesNotContain(rejections, r => r.Kind is CardKind.Choose or CardKind.Combine);
        Assert.Null(cards.Choose);
        Assert.Null(cards.Combine);
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 条件に収まる業務はあるが使える力を使う業務がないカードは、条件に合わないとは返さない")]
    public void CardsWithoutAbilityMatchAreNotNoFit()
    {
        // 夜だけ、週 10 時間: 夜の業務はあるが、どれも利害調整力につながらず、使えるのは利害調整力だけ
        var night = Build(Draft(), Inputs(slots: [TimeSlot.Night]));
        Assert.Contains(new MissingCard(CardKind.Choose, MissingReason.NoAbilityMatch), night.Cards.Missing);
        Assert.Contains(new MissingCard(CardKind.Combine, MissingReason.NoAbilityMatch), night.Cards.Missing);
        Assert.DoesNotContain(night.Rejections, r => r.Kind is CardKind.Choose or CardKind.Combine);

        // オンライン秘書と採用事務だけで、朝だけ: 朝の業務はオンライン秘書だけで、職種をまたいで組み合わせられない。組み合わせるは条件に合わないとして返す
        var morning = Build(Draft(), Inputs(slots: [TimeSlot.Morning]), Only("online-secretary", "recruiting-clerk"));
        Assert.Contains(new MissingCard(CardKind.Choose, MissingReason.NoAbilityMatch), morning.Cards.Missing);
        Assert.Contains(new MissingCard(CardKind.Combine, MissingReason.NoFit), morning.Cards.Missing);
    }

    [Fact(DisplayName = "options-4（創るは根拠を引けるときだけ）: 創らないと答えたら出さず、本人の話が足りないとは返さず、うまく作れなかったとして返す")]
    public void NotMadeCreateIsRejected()
    {
        var (cards, rejections) = Build(Draft(create: new CreateDraft(false, "", "", "", "", "balancing-interests", [], 0, "home", [], "")));

        Assert.Null(cards.Create);
        Assert.Equal([new MissingCard(CardKind.Create, MissingReason.Rejected)], cards.Missing);
        Assert.Equal([new CardRejection(CardKind.Create, "notMade")], rejections);
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 候補があるのに作らないと答えた選ぶと組み合わせるは、条件に合わないとは返さず、うまく作れなかったとして返す")]
    public void NotMadeChooseAndCombineAreRejected()
    {
        var off = new OptionsDraft(
            new ChooseDraft(false, "", [], "", ""), new CombineDraft(false, [], "", "", ""), GoodCreate());

        var (cards, rejections) = Build(off);

        Assert.Equal(
            [new MissingCard(CardKind.Choose, MissingReason.Rejected), new MissingCard(CardKind.Combine, MissingReason.Rejected)],
            cards.Missing);
        Assert.Equal([new CardRejection(CardKind.Choose, "notMade"), new CardRejection(CardKind.Combine, "notMade")], rejections);
        Assert.NotNull(cards.Create);
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 保存したカードを見せるとき、変わっていなければそのまま出す")]
    public void ForDisplayKeepsUnchangedCards()
    {
        var inputs = Inputs();
        var (cards, _) = Build(Draft(), inputs);

        var shown = OptionsValidator.ForDisplay(cards, inputs, Catalog);

        // 業務の一覧は計算し直して作るので、中身を比べる
        Assert.Equal(JsonSerializer.Serialize(cards.Choose), JsonSerializer.Serialize(shown.Choose));
        Assert.Equal(JsonSerializer.Serialize(cards.Combine), JsonSerializer.Serialize(shown.Combine));
        Assert.Equal(cards.Create, shown.Create);
        Assert.Empty(shown.Missing);
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 条件の時間帯を狭めると、収まるカードの業務の時間帯も、いまの条件で出す")]
    public void ForDisplayRecomputesTaskSlots()
    {
        var (cards, _) = Build(Draft());
        Assert.Equal([TimeSlot.Daytime, TimeSlot.Evening], Assert.Single(cards.Choose!.Tasks).TimeSlots);

        // 日中だけ: 日程の調整と面接の日程の連絡（どちらも日中と夕方）は収まるが、夕方はもう使えない
        var shown = OptionsValidator.ForDisplay(cards, Inputs(slots: [TimeSlot.Daytime]), Catalog);

        Assert.Equal([TimeSlot.Daytime], Assert.Single(shown.Choose!.Tasks).TimeSlots);
        Assert.Equal(2, shown.Combine!.Tasks.Count);
        Assert.All(shown.Combine.Tasks, t => Assert.Equal([TimeSlot.Daytime], t.TimeSlots));
        // 保存したカードは変えない
        Assert.Equal([TimeSlot.Daytime, TimeSlot.Evening], cards.Choose.Tasks[0].TimeSlots);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: カードの力を外すと、そのカードは出さず、外したとして返す")]
    public void ForDisplayHidesCardsOfExcludedAbility()
    {
        var (cards, _) = Build(Draft());

        var shown = OptionsValidator.ForDisplay(cards, Inputs(excluded: [TestAbilities.BalancingInterests], usable: [TestAbilities.NoticingChanges]), Catalog);

        Assert.Null(shown.Choose);
        Assert.Null(shown.Combine);
        Assert.Null(shown.Create);
        Assert.All(Enum.GetValues<CardKind>(), k => Assert.Contains(new MissingCard(k, MissingReason.Excluded), shown.Missing));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 条件を狭めて業務が外れたカードは出さず、収まるカードの幅は新しい条件で出す")]
    public void ForDisplayHidesCardsOutOfNarrowedConditions()
    {
        var (cards, _) = Build(Draft());

        // 週 3 時間: 日程の調整（3 時間から）は収まるが、組み合わせる（3 + 3 時間から）と創る（週 5 時間）は収まらない
        var shown = OptionsValidator.ForDisplay(cards, Inputs(hours: 3), Catalog);

        Assert.Equal(3, shown.Choose!.Range.MaxHours);
        Assert.Null(shown.Combine);
        Assert.Null(shown.Create);
        Assert.Contains(new MissingCard(CardKind.Combine, MissingReason.NoFit), shown.Missing);
        Assert.Contains(new MissingCard(CardKind.Create, MissingReason.NoFit), shown.Missing);

        // 夜だけ: どの業務も時間帯が合わない
        var night = OptionsValidator.ForDisplay(cards, Inputs(slots: [TimeSlot.Night]), Catalog);
        Assert.Null(night.Choose);
        Assert.Contains(new MissingCard(CardKind.Choose, MissingReason.NoFit), night.Missing);

        // 条件を消した: どれも出さない
        var noConditions = OptionsValidator.ForDisplay(cards, Inputs() with { Conditions = null }, Catalog);
        Assert.Null(noConditions.Choose);
        Assert.Null(noConditions.Combine);
        Assert.Null(noConditions.Create);
    }

    /// <summary>3 枚とも出さず、どれも記録が変わったとして返す。</summary>
    private static void AssertAllChanged(OptionCards shown)
    {
        Assert.Null(shown.Choose);
        Assert.Null(shown.Combine);
        Assert.Null(shown.Create);
        Assert.Equal(Enum.GetValues<CardKind>().Select(k => new MissingCard(k, MissingReason.Changed)), shown.Missing);
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 使えなくなった力のカードは出さず、記録が変わったとして返す")]
    public void ForDisplayHidesCardsOfAbilityNoLongerUsable()
    {
        var (cards, _) = Build(Draft());

        // 場面に力の確かめに使わない印が付き、利害調整力がまだ聞けていない力に戻った
        AssertAllChanged(OptionsValidator.ForDisplay(cards, Inputs(usable: [TestAbilities.NoticingChanges]), Catalog));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 力の状態か根拠の言葉が、いまの記録と合わなくなったカードは出さない")]
    public void ForDisplayHidesCardsWhoseAbilityChanged()
    {
        // 確かめ中、根拠の言葉は Q1 と Q2。創るは Q1 だけを引いた
        var (cards, _) = Build(Draft());
        OptionsInputs With(AbilityState state, params Evidence[] quotes) =>
            Inputs() with { Abilities = [new UsableAbility(TestAbilities.BalancingInterests, state, quotes)] };

        // 状態が変わった（訂正で場面を読み直したときなど）
        AssertAllChanged(OptionsValidator.ForDisplay(
            cards, With(AbilityState.Confirmed, [.. CoordinatingQuotes, E(TestAbilities.BalancingInterests, 3, "迎えの時間をずらしてもらいました")]), Catalog));
        // 状態は同じだが、根拠の言葉が別の場面のものに替わった（もとの場面に、確かめに使わない印が付いたときなど）
        AssertAllChanged(OptionsValidator.ForDisplay(cards, With(AbilityState.NeedsCheck, E(TestAbilities.BalancingInterests, 1, "予定を見比べました")), Catalog));
        // 同じ言葉でも、選んだ答えの言葉になった
        AssertAllChanged(OptionsValidator.ForDisplay(
            cards,
            With(AbilityState.NeedsCheck, CoordinatingQuotes[0] with { FromChoice = true, LinkedQuote = "母に電話しました" }, CoordinatingQuotes[1]),
            Catalog));

        // 創るが引いた言葉（Q1）がいまもあれば、創るは出す。選ぶと組み合わせるの根拠の言葉（Q1 と Q2）はもうそろっていない
        var partly = OptionsValidator.ForDisplay(cards, With(AbilityState.NeedsCheck, CoordinatingQuotes[0], E(TestAbilities.BalancingInterests, 2, "予定を見比べました")), Catalog);
        Assert.Null(partly.Choose);
        Assert.Null(partly.Combine);
        Assert.Equal(cards.Create, partly.Create);
        Assert.Equal([new MissingCard(CardKind.Choose, MissingReason.Changed), new MissingCard(CardKind.Combine, MissingReason.Changed)], partly.Missing);

        // 外したら、記録が変わったより先に、外したとして返す
        var excluded = OptionsValidator.ForDisplay(cards, Inputs(excluded: [TestAbilities.BalancingInterests], usable: []), Catalog);
        Assert.All(Enum.GetValues<CardKind>(), k => Assert.Contains(new MissingCard(k, MissingReason.Excluded), excluded.Missing));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 記録が変わって見せられないカードは、いつも元の記録の指紋も変わっていて、作り直す対象になる")]
    public void ChangedAbilityAlwaysMeansStale()
    {
        var inputs = Inputs();
        var (cards, _) = Build(Draft(), inputs);
        Assert.Equal(OptionsInputsReader.Basis(inputs), cards.Basis);

        foreach (var now in new[]
        {
            inputs with { Abilities = [new UsableAbility(TestAbilities.BalancingInterests, AbilityState.Confirmed, CoordinatingQuotes)] },
            inputs with { Abilities = [new UsableAbility(TestAbilities.BalancingInterests, AbilityState.NeedsCheck, [E(TestAbilities.BalancingInterests, 1, "予定を見比べました")])] },
            inputs with { Abilities = [new UsableAbility(TestAbilities.BalancingInterests, AbilityState.NeedsCheck, [CoordinatingQuotes[0] with { LinkedQuote = "母に電話しました", FromChoice = true }])] },
            Inputs(usable: [TestAbilities.NoticingChanges]),
        })
        {
            Assert.Contains(OptionsValidator.ForDisplay(cards, now, Catalog).Missing, m => m.Reason == MissingReason.Changed);
            Assert.NotEqual(cards.Basis, OptionsInputsReader.Basis(now));
        }
    }
}
