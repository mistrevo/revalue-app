using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AbilityStatesTests
{
    private static Evidence E(Ability ability, int action, int @event, bool general = false, int answer = 1, string? quote = null) =>
        new(ability, action, quote ?? $"{ability}-{action}-{@event}-{answer}", answer, @event, general, false, null);

    private static AbilityResult Of(IReadOnlyList<AbilityResult> results, Ability ability) => results.Single(r => r.Ability == ability);

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 同じ出来事に 3 つそろうと Confirmed")]
    public void ThreeInOneEventConfirms()
    {
        var results = AbilityStates.Evaluate(
        [
            E(Ability.Coordinating, 1, 1, answer: 1),
            E(Ability.Coordinating, 2, 1, answer: 2),
            E(Ability.Coordinating, 2, 1, answer: 1, quote: "早いほう"),
            E(Ability.Coordinating, 3, 1, answer: 3),
        ]);

        var coordinating = Of(results, Ability.Coordinating);
        Assert.Equal(AbilityState.Confirmed, coordinating.State);
        Assert.Empty(coordinating.Missing);
        Assert.Equal([1, 2, 3], coordinating.Shown.Select(e => e.Action));
        Assert.Equal("早いほう", coordinating.Shown[1].Quote);
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: そろう出来事が複数あれば、番号の大きい出来事の根拠を出す")]
    public void LaterCompleteEventIsShown()
    {
        var results = AbilityStates.Evaluate(
        [
            E(Ability.Noticing, 1, 1), E(Ability.Noticing, 2, 1), E(Ability.Noticing, 3, 1),
            E(Ability.Noticing, 1, 2), E(Ability.Noticing, 2, 2), E(Ability.Noticing, 3, 2),
        ]);

        Assert.All(Of(results, Ability.Noticing).Shown, e => Assert.Equal(2, e.Event));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 2 つの出来事に分かれてそろうと NeedsCheck のまま")]
    public void SplitAcrossEventsNeedsCheck()
    {
        var results = AbilityStates.Evaluate(
        [
            E(Ability.Coordinating, 1, 1),
            E(Ability.Coordinating, 2, 1),
            E(Ability.Coordinating, 3, 2),
        ]);

        var coordinating = Of(results, Ability.Coordinating);
        Assert.Equal(AbilityState.NeedsCheck, coordinating.State);
        Assert.Equal([1, 2], coordinating.Shown.Select(e => e.Action));
        Assert.Equal([3], coordinating.Missing);
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 同じ番号でも読み取りが違えば別の出来事として扱い、NeedsCheck のまま")]
    public void SameEventNumberFromDifferentReadingsNeedsCheck()
    {
        var results = AbilityStates.Evaluate(
        [
            E(Ability.Prioritizing, 1, 1) with { Reading = 1 },
            E(Ability.Prioritizing, 2, 1) with { Reading = 2 },
            E(Ability.Prioritizing, 3, 1) with { Reading = 2 },
        ]);

        var prioritizing = Of(results, Ability.Prioritizing);
        Assert.Equal(AbilityState.NeedsCheck, prioritizing.State);
        Assert.Equal([1], prioritizing.Missing);

        // 同じ読み取りの同じ出来事に 3 つそろえば Confirmed
        var confirmed = Of(AbilityStates.Evaluate(
        [
            E(Ability.Prioritizing, 1, 1) with { Reading = 1 },
            E(Ability.Prioritizing, 1, 1) with { Reading = 2 },
            E(Ability.Prioritizing, 2, 1) with { Reading = 2 },
            E(Ability.Prioritizing, 3, 1) with { Reading = 2 },
        ]), Ability.Prioritizing);
        Assert.Equal(AbilityState.Confirmed, confirmed.State);
        Assert.All(confirmed.Shown, e => Assert.Equal(2, e.Reading));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 行動の数が同じなら、新しい読み取りの出来事の根拠を出す")]
    public void TiePrefersNewerReading()
    {
        var result = Of(AbilityStates.Evaluate(
        [
            E(Ability.Noticing, 1, 2) with { Reading = 1 },
            E(Ability.Noticing, 2, 1) with { Reading = 2 },
        ]), Ability.Noticing);

        Assert.Equal(2, Assert.Single(result.Shown).Reading);
        Assert.Equal([1, 3], result.Missing);
    }

    [Fact(DisplayName = "validate-10（一般論には具体的な出来事を聞く）: 一般論の根拠だけなら、3 つあっても NeedsCheck")]
    public void GeneralOnlyNeedsCheck()
    {
        var results = AbilityStates.Evaluate(
        [
            E(Ability.Prioritizing, 1, 1, general: true),
            E(Ability.Prioritizing, 2, 1, general: true),
            E(Ability.Prioritizing, 3, 1, general: true),
        ]);

        var prioritizing = Of(results, Ability.Prioritizing);
        Assert.Equal(AbilityState.NeedsCheck, prioritizing.State);
        Assert.Equal(3, prioritizing.Shown.Count);
        Assert.Empty(prioritizing.Missing);

        var partial = Of(AbilityStates.Evaluate([E(Ability.Prioritizing, 2, 1, general: true)]), Ability.Prioritizing);
        Assert.Equal(AbilityState.NeedsCheck, partial.State);
        Assert.Equal([1, 3], partial.Missing);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: NeedsCheck の Missing は、いちばん多い出来事で足りない行動")]
    public void MissingComesFromBestEvent()
    {
        var results = AbilityStates.Evaluate(
        [
            E(Ability.Noticing, 1, 1),
            E(Ability.Noticing, 3, 1),
            E(Ability.Noticing, 2, 2),
            E(Ability.Noticing, 2, 3, general: true),
        ]);

        var noticing = Of(results, Ability.Noticing);
        Assert.Equal(AbilityState.NeedsCheck, noticing.State);
        Assert.Equal([2], noticing.Missing);
        Assert.Equal([1, 3], noticing.Shown.Select(e => e.Action));
        Assert.All(noticing.Shown, e => Assert.Equal(1, e.Event));

        // 同じ数なら、番号の大きい出来事
        var tie = Of(AbilityStates.Evaluate([E(Ability.Noticing, 1, 1), E(Ability.Noticing, 2, 2)]), Ability.Noticing);
        Assert.Equal([1, 3], tie.Missing);
        Assert.Equal(2, Assert.Single(tie.Shown).Event);
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 根拠がなければ NotYet、3 つの力は noticing、coordinating、prioritizing の順")]
    public void NoEvidenceIsNotYetInOrder()
    {
        var results = AbilityStates.Evaluate([]);

        Assert.Equal([Ability.Noticing, Ability.Coordinating, Ability.Prioritizing], results.Select(r => r.Ability));
        Assert.All(results, r =>
        {
            Assert.Equal(AbilityState.NotYet, r.State);
            Assert.Empty(r.Shown);
            Assert.Empty(r.Missing);
        });
    }
}
