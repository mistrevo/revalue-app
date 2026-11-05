using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AbilityStatesTests
{
    private static Evidence E(Ability ability, int action, int @event, bool general = false, int answer = 1, string? quote = null) =>
        new(ability, action, quote ?? $"{ability}-{action}-{@event}-{answer}", answer, @event, general, false, null);

    private static AbilityResult Of(IReadOnlyList<AbilityResult> results, Ability ability) => results.Single(r => r.Ability == ability);

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 同じ出来事に 3 つそろうと Confirmed")]
    public void ThreeInOneEventConfirms()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.BalancingInterests, 1, 1, answer: 1),
            E(TestAbilities.BalancingInterests, 2, 1, answer: 2),
            E(TestAbilities.BalancingInterests, 2, 1, answer: 1, quote: "早いほう"),
            E(TestAbilities.BalancingInterests, 3, 1, answer: 3),
        ]);

        var coordinating = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.Confirmed, coordinating.State);
        Assert.Empty(coordinating.Missing);
        Assert.Equal([1, 2, 3], coordinating.Shown.Select(e => e.Action));
        Assert.Equal("早いほう", coordinating.Shown[1].Quote);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 3 つの行動の引用が 1 つの引用の中にすべて収まるときは、ほかの 2 つを含む引用を数えず、根拠ありにしない")]
    public void OneSpanCoveringAllThreeDoesNotConfirm()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.BalancingInterests, 1, 1, quote: "歯医者に電話して予約を夕方に変えてもらい"),
            E(TestAbilities.BalancingInterests, 2, 1, quote: "歯医者に電話して"),
            E(TestAbilities.BalancingInterests, 3, 1, quote: "予約を夕方に変えてもらい"),
        ]);

        var coordinating = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.NeedsCheck, coordinating.State);
        Assert.Equal([2, 3], coordinating.Shown.Select(e => e.Action));
        Assert.Equal([1], coordinating.Missing);

        // 3 つが同じ引用でも、根拠ありにしない
        var same = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.NoticingChanges, 1, 1, quote: "いつもと違うと思った"),
            E(TestAbilities.NoticingChanges, 2, 1, quote: "いつもと違うと思った"),
            E(TestAbilities.NoticingChanges, 3, 1, quote: "いつもと違うと思った"),
        ]), TestAbilities.NoticingChanges);
        Assert.Equal(AbilityState.NeedsCheck, same.State);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: ほかの 2 つを含む引用の行動に、別の部分の根拠もあれば、そちらで根拠ありにする")]
    public void ContainerWithAnotherQuoteStillConfirms()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.BalancingInterests, 1, 1, answer: 1, quote: "歯医者に電話して予約を夕方に変えてもらい"),
            E(TestAbilities.BalancingInterests, 1, 1, answer: 2, quote: "夫は夕方まで仕事で、子どもは午後に習い事がありました"),
            E(TestAbilities.BalancingInterests, 2, 1, answer: 1, quote: "歯医者に電話して"),
            E(TestAbilities.BalancingInterests, 3, 1, answer: 1, quote: "予約を夕方に変えてもらい"),
        ]);

        var coordinating = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.Confirmed, coordinating.State);
        Assert.Equal("夫は夕方まで仕事で、子どもは午後に習い事がありました", coordinating.Shown[0].Quote);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: そろう出来事が複数あれば、番号の大きい出来事の根拠を出す")]
    public void LaterCompleteEventIsShown()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.NoticingChanges, 1, 1), E(TestAbilities.NoticingChanges, 2, 1), E(TestAbilities.NoticingChanges, 3, 1),
            E(TestAbilities.NoticingChanges, 1, 2), E(TestAbilities.NoticingChanges, 2, 2), E(TestAbilities.NoticingChanges, 3, 2),
        ]);

        Assert.All(Of(results, TestAbilities.NoticingChanges).Shown, e => Assert.Equal(2, e.Event));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 2 つの出来事に分かれてそろうと NeedsCheck のまま")]
    public void SplitAcrossEventsNeedsCheck()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.BalancingInterests, 1, 1),
            E(TestAbilities.BalancingInterests, 2, 1),
            E(TestAbilities.BalancingInterests, 3, 2),
        ]);

        var coordinating = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.NeedsCheck, coordinating.State);
        Assert.Equal([1, 2], coordinating.Shown.Select(e => e.Action));
        Assert.Equal([3], coordinating.Missing);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 同じ番号でも読み取りが違えば別の出来事として扱い、NeedsCheck のまま")]
    public void SameEventNumberFromDifferentReadingsNeedsCheck()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.SettingPriorities, 1, 1) with { Reading = 1 },
            E(TestAbilities.SettingPriorities, 2, 1) with { Reading = 2 },
            E(TestAbilities.SettingPriorities, 3, 1) with { Reading = 2 },
        ]);

        var prioritizing = Of(results, TestAbilities.SettingPriorities);
        Assert.Equal(AbilityState.NeedsCheck, prioritizing.State);
        Assert.Equal([1], prioritizing.Missing);

        // 同じ読み取りの同じ出来事に 3 つそろえば Confirmed
        var confirmed = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.SettingPriorities, 1, 1) with { Reading = 1 },
            E(TestAbilities.SettingPriorities, 1, 1) with { Reading = 2 },
            E(TestAbilities.SettingPriorities, 2, 1) with { Reading = 2 },
            E(TestAbilities.SettingPriorities, 3, 1) with { Reading = 2 },
        ]), TestAbilities.SettingPriorities);
        Assert.Equal(AbilityState.Confirmed, confirmed.State);
        Assert.All(confirmed.Shown, e => Assert.Equal(2, e.Reading));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 行動の数が同じなら、新しい読み取りの出来事の根拠を出す")]
    public void TiePrefersNewerReading()
    {
        var result = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.NoticingChanges, 1, 2) with { Reading = 1 },
            E(TestAbilities.NoticingChanges, 2, 1) with { Reading = 2 },
        ]), TestAbilities.NoticingChanges);

        Assert.Equal(2, Assert.Single(result.Shown).Reading);
        Assert.Equal([1, 3], result.Missing);
    }

    [Fact(DisplayName = "validate-10（一般論には具体的な出来事を聞く）: 一般論の根拠だけなら、3 つあっても NeedsCheck")]
    public void GeneralOnlyNeedsCheck()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.SettingPriorities, 1, 1, general: true),
            E(TestAbilities.SettingPriorities, 2, 1, general: true),
            E(TestAbilities.SettingPriorities, 3, 1, general: true),
        ]);

        var prioritizing = Of(results, TestAbilities.SettingPriorities);
        Assert.Equal(AbilityState.NeedsCheck, prioritizing.State);
        Assert.Equal(3, prioritizing.Shown.Count);
        Assert.Empty(prioritizing.Missing);

        var partial = Of(AbilityStates.Evaluate([E(TestAbilities.SettingPriorities, 2, 1, general: true)]), TestAbilities.SettingPriorities);
        Assert.Equal(AbilityState.NeedsCheck, partial.State);
        Assert.Equal([1, 3], partial.Missing);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: NeedsCheck の Missing は、いちばん多い出来事で足りない行動")]
    public void MissingComesFromBestEvent()
    {
        var results = AbilityStates.Evaluate(
        [
            E(TestAbilities.NoticingChanges, 1, 1),
            E(TestAbilities.NoticingChanges, 3, 1),
            E(TestAbilities.NoticingChanges, 2, 2),
            E(TestAbilities.NoticingChanges, 2, 3, general: true),
        ]);

        var noticing = Of(results, TestAbilities.NoticingChanges);
        Assert.Equal(AbilityState.NeedsCheck, noticing.State);
        Assert.Equal([2], noticing.Missing);
        Assert.Equal([1, 3], noticing.Shown.Select(e => e.Action));
        Assert.All(noticing.Shown, e => Assert.Equal(1, e.Event));

        // 同じ数なら、番号の大きい出来事
        var tie = Of(AbilityStates.Evaluate([E(TestAbilities.NoticingChanges, 1, 1), E(TestAbilities.NoticingChanges, 2, 2)]), TestAbilities.NoticingChanges);
        Assert.Equal([1, 3], tie.Missing);
        Assert.Equal(2, Assert.Single(tie.Shown).Event);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力は、一つの出来事の中で 2 つそろったときだけ根拠ありになる")]
    public void TwoActionAbilityConfirmsWithBoth()
    {
        var both = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.Summarizing, 1, 1, quote: "先生の話を三つにまとめて"),
            E(TestAbilities.Summarizing, 2, 1, answer: 2, quote: "つまり来週までに出すのですね、と返しました"),
        ]), TestAbilities.Summarizing);
        Assert.Equal(AbilityState.Confirmed, both.State);
        Assert.Equal([1, 2], both.Shown.Select(e => e.Action));
        Assert.Empty(both.Missing);

        var one = Of(AbilityStates.Evaluate([E(TestAbilities.Summarizing, 1, 1, quote: "先生の話を三つにまとめて")]), TestAbilities.Summarizing);
        Assert.Equal(AbilityState.NeedsCheck, one.State);
        Assert.Equal([2], one.Missing);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力で、一方の引用がもう一方の引用をすべて含むときは、含むほうを数えない")]
    public void TwoActionAbilityIgnoresContainingQuote()
    {
        var covered = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.Summarizing, 1, 1, quote: "先生の話をまとめて、つまりこういうことですねと返しました"),
            E(TestAbilities.Summarizing, 2, 1, quote: "つまりこういうことですねと返しました"),
        ]), TestAbilities.Summarizing);
        Assert.Equal(AbilityState.NeedsCheck, covered.State);
        Assert.Equal([2], covered.Shown.Select(e => e.Action));
        Assert.Equal([1], covered.Missing);

        // 含むほうの行動に、もう一方を含まない別の根拠があれば、そちらで根拠ありにする
        var alternative = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.Summarizing, 1, 1, answer: 1, quote: "先生の話をまとめて、つまりこういうことですねと返しました"),
            E(TestAbilities.Summarizing, 1, 1, answer: 2, quote: "要点を紙に三つ書き出しました"),
            E(TestAbilities.Summarizing, 2, 1, answer: 1, quote: "つまりこういうことですねと返しました"),
        ]), TestAbilities.Summarizing);
        Assert.Equal(AbilityState.Confirmed, alternative.State);
        Assert.Equal("要点を紙に三つ書き出しました", alternative.Shown[0].Quote);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力で、同じ引用を 2 つの行動に当てても根拠ありにしない")]
    public void TwoActionAbilitySameQuoteDoesNotConfirm()
    {
        var result = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.ActiveListening, 1, 1, quote: "最後まで黙って話を聞きました"),
            E(TestAbilities.ActiveListening, 2, 1, quote: "最後まで黙って話を聞きました"),
        ]), TestAbilities.ActiveListening);

        Assert.Equal(AbilityState.NeedsCheck, result.State);
        Assert.Single(result.Shown);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力で、別々の出来事に 1 つずつ出たときは要確認のまま")]
    public void TwoActionAbilitySplitAcrossEventsNeedsCheck()
    {
        var result = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.PlanningSteps, 1, 1, quote: "やることを紙に書き出しました"),
            E(TestAbilities.PlanningSteps, 2, 2, answer: 2, quote: "洗濯を先にする順番にしました"),
        ]), TestAbilities.PlanningSteps);

        Assert.Equal(AbilityState.NeedsCheck, result.State);
        Assert.Single(result.Shown);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 行動が 3 つの力では、ほかの 2 つの引用をすべて含む引用だけを数えない")]
    public void ThreeActionAbilityIgnoresOnlyQuoteCoveringBothOthers()
    {
        // 1 の引用が 2 の引用だけを含む（3 は含まない）なら、数える
        var result = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.BalancingInterests, 1, 1, quote: "夫と母の予定がぶつかって、私から電話して"),
            E(TestAbilities.BalancingInterests, 2, 1, quote: "私から電話して"),
            E(TestAbilities.BalancingInterests, 3, 1, answer: 2, quote: "迎えの時間をずらしてもらいました"),
        ]), TestAbilities.BalancingInterests);

        Assert.Equal(AbilityState.Confirmed, result.State);
        Assert.Equal([1, 2, 3], result.Shown.Select(e => e.Action));
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 根拠がなければ NotYet、話から確かめる力は辞書の順")]
    public void NoEvidenceIsNotYetInOrder()
    {
        var results = AbilityStates.Evaluate([]);

        Assert.Equal(AbilityCatalog.Active, results.Select(r => r.Ability));
        Assert.All(results, r =>
        {
            Assert.Equal(AbilityState.NotYet, r.State);
            Assert.Empty(r.Shown);
            Assert.Empty(r.Missing);
        });
    }
}
