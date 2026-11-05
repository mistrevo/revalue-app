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

        var balancing = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.Confirmed, balancing.State);
        Assert.Empty(balancing.Missing);
        Assert.Equal([1, 2, 3], balancing.Shown.Select(e => e.Action));
        Assert.Equal("早いほう", balancing.Shown[1].Quote);
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

        var balancing = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.NeedsCheck, balancing.State);
        Assert.Equal([2, 3], balancing.Shown.Select(e => e.Action));
        Assert.Equal([1], balancing.Missing);

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

        var balancing = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.Confirmed, balancing.State);
        Assert.Equal("夫は夕方まで仕事で、子どもは午後に習い事がありました", balancing.Shown[0].Quote);
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

        var balancing = Of(results, TestAbilities.BalancingInterests);
        Assert.Equal(AbilityState.NeedsCheck, balancing.State);
        Assert.Equal([1, 2], balancing.Shown.Select(e => e.Action));
        Assert.Equal([3], balancing.Missing);
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

        var priorities = Of(results, TestAbilities.SettingPriorities);
        Assert.Equal(AbilityState.NeedsCheck, priorities.State);
        Assert.Equal([1], priorities.Missing);

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

        var priorities = Of(results, TestAbilities.SettingPriorities);
        Assert.Equal(AbilityState.NeedsCheck, priorities.State);
        Assert.Equal(3, priorities.Shown.Count);
        Assert.Empty(priorities.Missing);

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

        var noticingChanges = Of(results, TestAbilities.NoticingChanges);
        Assert.Equal(AbilityState.NeedsCheck, noticingChanges.State);
        Assert.Equal([2], noticingChanges.Missing);
        Assert.Equal([1, 3], noticingChanges.Shown.Select(e => e.Action));
        Assert.All(noticingChanges.Shown, e => Assert.Equal(1, e.Event));

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

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 含む引用を同じ行動の別の引用に差し替えたら組を確かめ直し、どの組でもほかの行動の引用を含む引用が残るなら根拠ありにしない")]
    public void ReplacedQuoteIsCheckedAgain()
    {
        // 2 の 1 つ目は 1 の引用を含む。2 の 2 つ目に差し替えると、今度は 1 の引用が 2 の引用を含む
        var result = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.Summarizing, 1, 1, answer: 1, quote: "子どもの話を聞いて要点を書き出した"),
            E(TestAbilities.Summarizing, 2, 1, answer: 1, quote: "子どもの話を聞いて要点を書き出したら先生に伝えた"),
            E(TestAbilities.Summarizing, 2, 1, answer: 2, quote: "要点を書き出した"),
        ]), TestAbilities.Summarizing);

        Assert.Equal(AbilityState.NeedsCheck, result.State);
        Assert.Equal(["子どもの話を聞いて要点を書き出した"], result.Shown.Select(e => e.Quote));
        Assert.Equal([2], result.Missing);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 同じ行動に別の引用がいくつかあれば、ほかの行動の引用をすべて含む引用が残らない組を選んで数える")]
    public void PicksCombinationWithoutContainingQuote()
    {
        var result = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.Summarizing, 1, 1, answer: 1, quote: "子どもの話を聞いて要点を書き出した"),
            E(TestAbilities.Summarizing, 2, 1, answer: 1, quote: "子どもの話を聞いて要点を書き出したら先生に伝えた"),
            E(TestAbilities.Summarizing, 2, 1, answer: 2, quote: "要点を書き出した"),
            E(TestAbilities.Summarizing, 2, 1, answer: 3, quote: "明日までに書くのねと言い直して返しました"),
        ]), TestAbilities.Summarizing);

        Assert.Equal(AbilityState.Confirmed, result.State);
        Assert.Equal(["子どもの話を聞いて要点を書き出した", "明日までに書くのねと言い直して返しました"], result.Shown.Select(e => e.Quote));

        // 行動が 3 つの力でも同じ。1 の引用が、2 の 1 つ目と 3 をどちらも含むので、1 を残したまま、2 は 1 に含まれない引用にする
        var three = Of(AbilityStates.Evaluate(
        [
            E(TestAbilities.BalancingInterests, 1, 1, answer: 1, quote: "夫と母の予定を聞いて、迎えの時間をずらしてもらいました"),
            E(TestAbilities.BalancingInterests, 2, 1, answer: 1, quote: "夫と母の予定を聞いて"),
            E(TestAbilities.BalancingInterests, 2, 1, answer: 2, quote: "私から母に電話しました"),
            E(TestAbilities.BalancingInterests, 3, 1, answer: 1, quote: "迎えの時間をずらしてもらいました"),
        ]), TestAbilities.BalancingInterests);

        Assert.Equal(AbilityState.Confirmed, three.State);
        Assert.Equal("私から母に電話しました", three.Shown[1].Quote);
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

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 状況の行動の根拠だけの力は、本人の行動が聞けていないので NotYet")]
    public void SituationOnlyIsNotYet()
    {
        var resilience = TestAbilities.Resilience;
        Assert.True(AbilityCatalog.IsSituation(new ActionRef(resilience, 1)));

        var specific = Of(AbilityStates.Evaluate([E(resilience, 1, 1, quote: "思うようにいかなかった")]), resilience);
        Assert.Equal(AbilityState.NotYet, specific.State);
        Assert.Empty(specific.Shown);
        Assert.Empty(specific.Missing);

        // 一般論の状況だけでも同じ
        var general = Of(AbilityStates.Evaluate([E(resilience, 1, 1, general: true, quote: "いつも予定どおりにいかない")]), resilience);
        Assert.Equal(AbilityState.NotYet, general.State);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 状況の行動と本人の行動が同じ出来事にあれば NeedsCheck で、状況の行動も見せる根拠に入る")]
    public void SituationWithOwnActionNeedsCheck()
    {
        var resilience = TestAbilities.Resilience;
        var result = Of(AbilityStates.Evaluate(
        [
            E(resilience, 1, 1, answer: 1, quote: "思うようにいかなかった"),
            E(resilience, 2, 1, answer: 2, quote: "できることを紙に書き出した"),
        ]), resilience);

        Assert.Equal(AbilityState.NeedsCheck, result.State);
        Assert.Equal([1, 2], result.Shown.Select(e => e.Action));
        Assert.Equal([3], result.Missing);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 新しい出来事が状況の行動だけなら、本人の行動がある出来事の根拠を見せる")]
    public void SituationOnlyEventIsSkipped()
    {
        var resilience = TestAbilities.Resilience;
        var result = Of(AbilityStates.Evaluate(
        [
            E(resilience, 2, 1, answer: 1, quote: "できることを紙に書き出した"),
            E(resilience, 1, 2, answer: 2, quote: "次の日も思うようにいかなかった"),
        ]), resilience);

        Assert.Equal(AbilityState.NeedsCheck, result.State);
        Assert.Equal("できることを紙に書き出した", Assert.Single(result.Shown).Quote);
        Assert.Equal([1, 3], result.Missing);
    }

    [Fact(DisplayName = "validate-5（選んだだけでは根拠にしない）: 行動が 2 つの力で、一方の句に結びつけた選んだ答えをもう一方に当てても、根拠ありにしない")]
    public void ChoiceLinkedToSameQuoteDoesNotConfirm()
    {
        const string phrase = "やることを紙に書き出して、上から順に片づけました";
        var result = Of(AbilityStates.Evaluate(
        [
            new Evidence(TestAbilities.PlanningSteps, 1, phrase, 1, 1, false, false, null),
            new Evidence(TestAbilities.PlanningSteps, 2, "思い当たることがあります", 2, 1, false, true, phrase),
        ]), TestAbilities.PlanningSteps);

        Assert.Equal(AbilityState.NeedsCheck, result.State);

        // 結びついた言葉が別の句なら、根拠ありになる
        var separate = Of(AbilityStates.Evaluate(
        [
            new Evidence(TestAbilities.PlanningSteps, 1, "やることを紙に書き出して", 1, 1, false, false, null),
            new Evidence(TestAbilities.PlanningSteps, 2, "思い当たることがあります", 2, 1, false, true, "上から順に片づけました"),
        ]), TestAbilities.PlanningSteps);
        Assert.Equal(AbilityState.Confirmed, separate.State);
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
