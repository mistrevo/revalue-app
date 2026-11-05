using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

/// <summary>一つの話から見せる力の絞り込み（03-validate.md の「話し終えたとき」）。</summary>
public sealed class AbilityShowcaseTests
{
    private static Evidence E(Ability ability, int action, int @event = 1, string? quote = null) =>
        new(ability, action, quote ?? $"{ability}-{action}-{@event} の言葉", 1, @event, false, false, null);

    private static IEnumerable<Evidence> All(Ability ability, int @event = 1) =>
        Enumerable.Range(1, AbilityCatalog.ActionCount(ability)).Select(n => E(ability, n, @event));

    private static Turn Asked(ActionRef target) =>
        new() { Role = TurnRoles.Assistant, Text = "問い", Target = target.ToString(), At = DateTimeOffset.UnixEpoch };

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 同じ分類で 2 つの力が根拠ありなら、そろった行動の多い力だけを見せる")]
    public void SameCategoryShowsTheOneWithMoreActions()
    {
        // 利害調整力（行動 3 つ）と段取り力（行動 2 つ）は、どちらも調整・実行・仕組み化
        Assert.Equal(AbilityCatalog.Category(TestAbilities.BalancingInterests), AbilityCatalog.Category(TestAbilities.PlanningSteps));
        var evidence = All(TestAbilities.PlanningSteps).Concat(All(TestAbilities.BalancingInterests)).ToList();
        Assert.Equal(
            [AbilityState.Confirmed, AbilityState.Confirmed],
            AbilityStates.Evaluate(evidence).Where(r => r.Ability == TestAbilities.BalancingInterests || r.Ability == TestAbilities.PlanningSteps).Select(r => r.State));

        var showcase = AbilityShowcase.Of([], evidence);

        Assert.Equal([TestAbilities.BalancingInterests], showcase.Seen.Select(r => r.Ability));
        Assert.Empty(showcase.MoreToHear);
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: そろった行動の数が同じなら、辞書の順で前の力を見せる")]
    public void SameCountShowsTheEarlierInCatalog()
    {
        // 要約力と傾聴力（どちらも行動 2 つ、対話・コミュニケーション）。辞書では要約力が前
        Assert.Equal(AbilityCatalog.Category(TestAbilities.Summarizing), AbilityCatalog.Category(TestAbilities.ActiveListening));
        var evidence = All(TestAbilities.ActiveListening).Concat(All(TestAbilities.Summarizing)).ToList();

        var showcase = AbilityShowcase.Of([], evidence);

        Assert.Equal([TestAbilities.Summarizing], showcase.Seen.Select(r => r.Ability));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 分類が違えば、根拠ありの力をそれぞれ見せる")]
    public void DifferentCategoriesShowEach()
    {
        Assert.NotEqual(AbilityCatalog.Category(TestAbilities.NoticingChanges), AbilityCatalog.Category(TestAbilities.BalancingInterests));
        var evidence = All(TestAbilities.NoticingChanges).Concat(All(TestAbilities.BalancingInterests)).ToList();

        var showcase = AbilityShowcase.Of([], evidence);

        // 辞書の順（利害調整力が前）
        Assert.Equal([TestAbilities.BalancingInterests, TestAbilities.NoticingChanges], showcase.Seen.Select(r => r.Ability));
        Assert.All(showcase.Seen, r => Assert.Equal(AbilityState.Confirmed, r.State));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 見えた力は場面全体でも 3 つまで。そろった行動の多い力、同じなら辞書の順で選び、辞書の順に並べる")]
    public void SeenIsAtMostThreeInTheScene()
    {
        // 5 つの分類で 1 つずつ根拠あり: 要約力（2）、利害調整力（3）、変化への気づき（3）、共感力（2）、粘り強さ（2）
        Ability[] abilities =
            [TestAbilities.Summarizing, TestAbilities.BalancingInterests, TestAbilities.NoticingChanges, TestAbilities.Empathy, TestAbilities.Persistence];
        Assert.Equal(5, abilities.Select(AbilityCatalog.Category).Distinct().Count());
        var evidence = abilities.SelectMany(a => All(a)).ToList();

        var showcase = AbilityShowcase.Of([], evidence);

        Assert.Equal(3, AbilityShowcase.MaxSeen);
        Assert.Equal(
            [TestAbilities.Summarizing, TestAbilities.BalancingInterests, TestAbilities.NoticingChanges],
            showcase.Seen.Select(r => r.Ability));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: そろっても見えた力に出ない力は、もう少し聞かせてほしいことに入れない")]
    public void MoreToHearSkipsAbilitiesThatCannotBeSeen()
    {
        // 利害調整力（3）がそろっている。同じ分類の段取り力（2）は、2 つそろっても見えた力に出ない
        List<Evidence> sameCategory = [.. All(TestAbilities.BalancingInterests), E(TestAbilities.PlanningSteps, 1), E(TestAbilities.NoticingChanges, 1)];
        var results = AbilityStates.Evaluate(sameCategory);

        Assert.False(AbilityShowcase.CouldBeSeen(TestAbilities.PlanningSteps, results));
        Assert.True(AbilityShowcase.CouldBeSeen(TestAbilities.NoticingChanges, results));
        Assert.Equal([TestAbilities.NoticingChanges], AbilityShowcase.Of([], sameCategory).MoreToHear.Select(r => r.Ability));

        // 行動の数が同じなら、辞書の順で前の力はそろえば入れ替わって出せる。後の力は出せない
        Assert.True(AbilityShowcase.CouldBeSeen(
            TestAbilities.Summarizing, AbilityStates.Evaluate([.. All(TestAbilities.ActiveListening), E(TestAbilities.Summarizing, 1)])));
        Assert.False(AbilityShowcase.CouldBeSeen(
            TestAbilities.ActiveListening, AbilityStates.Evaluate([.. All(TestAbilities.Summarizing), E(TestAbilities.ActiveListening, 1)])));

        // 場面全体の上限: 行動 3 つの力が 3 つの分類でそろっていれば、ほかの分類の行動 2 つの力は出せない
        List<Evidence> full =
        [
            .. All(TestAbilities.OrganizingIssues), .. All(TestAbilities.BalancingInterests), .. All(TestAbilities.NoticingChanges),
            E(TestAbilities.Empathy, 1),
        ];
        Assert.False(AbilityShowcase.CouldBeSeen(TestAbilities.Empathy, AbilityStates.Evaluate(full)));
        Assert.Empty(AbilityShowcase.Of([], full).MoreToHear);
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: もう少し聞かせてほしいことは 2 つまでで、聞き返した力を先にする")]
    public void MoreToHearIsAtMostTwoWithFocusFirst()
    {
        // 要確認が 3 つ: 利害調整力 2 つ、変化への気づき 2 つ、要約力 1 つ。聞き返したのは、見せる根拠がいちばん少ない要約力
        List<Evidence> evidence =
        [
            E(TestAbilities.BalancingInterests, 1), E(TestAbilities.BalancingInterests, 2),
            E(TestAbilities.NoticingChanges, 1), E(TestAbilities.NoticingChanges, 2),
            E(TestAbilities.Summarizing, 1),
        ];
        Assert.Equal(3, AbilityStates.Evaluate(evidence).Count(r => r.State == AbilityState.NeedsCheck));

        var showcase = AbilityShowcase.Of([Asked(new ActionRef(TestAbilities.Summarizing, 2))], evidence);

        Assert.Empty(showcase.Seen);
        Assert.Equal([TestAbilities.Summarizing, TestAbilities.BalancingInterests], showcase.MoreToHear.Select(r => r.Ability));
        Assert.Equal(AbilityShowcase.MaxMoreToHear, showcase.MoreToHear.Count);
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 聞き返した力がなければ、見せる根拠の多い順、同じなら辞書の順に 2 つ")]
    public void MoreToHearWithoutFocusIsByShownCountThenCatalogOrder()
    {
        List<Evidence> evidence =
        [
            E(TestAbilities.Summarizing, 1),
            E(TestAbilities.NoticingChanges, 1), E(TestAbilities.NoticingChanges, 2),
            E(TestAbilities.BalancingInterests, 1), E(TestAbilities.BalancingInterests, 2),
        ];

        var showcase = AbilityShowcase.Of([], evidence);

        Assert.Equal([TestAbilities.BalancingInterests, TestAbilities.NoticingChanges], showcase.MoreToHear.Select(r => r.Ability));
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 聞き返した力が根拠ありになっていれば、もう少し聞かせてほしいことは見せる根拠の多い順")]
    public void ConfirmedFocusDoesNotLeadMoreToHear()
    {
        List<Evidence> evidence =
        [
            .. All(TestAbilities.Summarizing),
            E(TestAbilities.NoticingChanges, 1),
            E(TestAbilities.BalancingInterests, 1), E(TestAbilities.BalancingInterests, 2),
        ];

        var showcase = AbilityShowcase.Of([Asked(new ActionRef(TestAbilities.Summarizing, 2))], evidence);

        Assert.Equal([TestAbilities.Summarizing], showcase.Seen.Select(r => r.Ability));
        Assert.Equal([TestAbilities.BalancingInterests, TestAbilities.NoticingChanges], showcase.MoreToHear.Select(r => r.Ability));
    }
}
