using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class NextMovePolicyTests
{
    private static TurnReading Read(params AnswerSignal[] signals) => new(new HashSet<AnswerSignal>(signals));

    private static MoveKind Kind(TurnReading reading, int userTurnNumber) => NextMovePolicy.Decide(reading, userTurnNumber).Kind;

    private static readonly DateTimeOffset At = new(2026, 11, 3, 1, 0, 0, TimeSpan.Zero);

    private static readonly TurnReading Concrete = new(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent });

    private static Evidence E(Ability ability, int action, int @event = 1, int answer = 1, bool general = false) =>
        new(ability, action, $"{ability}-{action}", answer, @event, general, false, null);

    /// <summary>いまの答えが <paramref name="latestAnswer"/> 番目で、根拠と、これまでに聞いた行動の回数を持つ確かめの文脈。</summary>
    private static ValidationContext Context(int latestAnswer, IReadOnlyList<Evidence> evidence, params (ActionRef Target, int Count)[] asked) =>
        new(evidence, latestAnswer, asked.ToDictionary(a => a.Target, a => a.Count));

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 分からない・何もないには、答えやすい場面を聞く")]
    public void DontKnowAsksEasierScene() =>
        Assert.Equal(MoveKind.AskEasierScene, Kind(Read(AnswerSignal.DontKnow), 1));

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 一般論と「何もない」が重なっても、答えやすい場面を聞く")]
    public void DontKnowWinsOverGeneralOnly() =>
        Assert.Equal(MoveKind.AskEasierScene, Kind(Read(AnswerSignal.GeneralOnly, AnswerSignal.DontKnow), 2));

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 行動を話したうえで「特別なことは何も」と添えても、その出来事の中で本人がしたことを聞く")]
    public void ConcreteEventWinsOverDontKnow() =>
        Assert.Equal(MoveKind.AskWhatYouDid, Kind(Read(AnswerSignal.ConcreteEvent, AnswerSignal.DontKnow), 2));

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 具体的な出来事があれば、一般論が添えてあっても、その出来事の中で本人がしたことを聞く")]
    public void ConcreteEventWinsOverGeneralOnly()
    {
        Assert.Equal(MoveKind.AskWhatYouDid, Kind(Read(AnswerSignal.ConcreteEvent, AnswerSignal.GeneralOnly), 2));
        Assert.Equal(MoveKind.AskWhatYouDid, Kind(Read(AnswerSignal.ConcreteEvent, AnswerSignal.GeneralOnly, AnswerSignal.DontKnow), 2));
    }

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 具体的な出来事と「何もない」が重なっても、家族の病気の話が先")]
    public void FamilyIllnessWinsOverConcreteEventAndDontKnow() =>
        Assert.Equal(
            MoveKind.ReturnFromIllness,
            Kind(Read(AnswerSignal.FamilyIllness, AnswerSignal.ConcreteEvent, AnswerSignal.DontKnow), 3));

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 家族の病気の話には、本人がしたことに戻す")]
    public void FamilyIllnessReturnsToWhatYouDid() =>
        Assert.Equal(MoveKind.ReturnFromIllness, Kind(Read(AnswerSignal.FamilyIllness, AnswerSignal.ConcreteEvent), 3));

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 家族の病気の話は、「何もない」より先")]
    public void FamilyIllnessWinsOverDontKnow() =>
        Assert.Equal(MoveKind.ReturnFromIllness, Kind(Read(AnswerSignal.FamilyIllness, AnswerSignal.DontKnow), 3));

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: つらい状態のサインがいちばん先")]
    public void DistressComesFirst()
    {
        var reading = Read(AnswerSignal.Distress, AnswerSignal.DontKnow, AnswerSignal.FamilyIllness);

        Assert.Equal(MoveKind.Distress, Kind(reading, 1));
        Assert.Equal(MoveKind.Distress, Kind(reading, NextMovePolicy.MaxUserTurns));
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 8 往復目は締める")]
    public void EighthTurnCloses()
    {
        Assert.Equal(8, NextMovePolicy.MaxUserTurns);
        Assert.Equal(MoveKind.Close, Kind(Read(AnswerSignal.ConcreteEvent), 8));
        Assert.Equal(MoveKind.AskWhatYouDid, Kind(Read(AnswerSignal.ConcreteEvent), 7));
        Assert.Equal(MoveKind.Close, Kind(Read(AnswerSignal.FamilyIllness, AnswerSignal.DontKnow), 8));
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 一般論だけには、その中の具体的な出来事を聞く")]
    public void GeneralOnlyAsksConcreteEvent() =>
        Assert.Equal(MoveKind.AskConcreteEvent, Kind(Read(AnswerSignal.GeneralOnly), 1));

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 具体的な出来事や空の読み取りには、本人がしたことを聞く")]
    public void ConcreteOrEmptyAsksWhatYouDid()
    {
        Assert.Equal(MoveKind.AskWhatYouDid, Kind(Read(AnswerSignal.ConcreteEvent), 1));
        Assert.Equal(MoveKind.AskWhatYouDid, Kind(Read(), 1));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 要確認の力があれば、足りない行動を一つ聞く")]
    public void AsksOneMissingAction()
    {
        var context = Context(2, [E(Ability.Coordinating, 1, answer: 1), E(Ability.Coordinating, 2, answer: 2)]);

        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Coordinating, 3)),
            NextMovePolicy.Decide(Concrete, 2, context));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 同じ行動は 2 回まで。2 回聞いたら次の足りない行動か、いつもの一手へ")]
    public void SameActionAtMostTwice()
    {
        Assert.Equal(2, NextMovePolicy.MaxAskPerAction);
        IReadOnlyList<Evidence> evidence = [E(Ability.Noticing, 2)];
        var first = new ActionRef(Ability.Noticing, 1);
        var third = new ActionRef(Ability.Noticing, 3);

        Assert.Equal(new NextMove(MoveKind.AskMissingAction, first), NextMovePolicy.Decide(Concrete, 3, Context(3, evidence, (first, 1))));
        Assert.Equal(new NextMove(MoveKind.AskMissingAction, third), NextMovePolicy.Decide(Concrete, 3, Context(3, evidence, (first, 2))));
        Assert.Equal(new NextMove(MoveKind.AskWhatYouDid), NextMovePolicy.Decide(Concrete, 3, Context(3, evidence, (first, 2), (third, 2))));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: いちばん多くそろった力を先に聞く")]
    public void MostCompleteAbilityFirst()
    {
        var context = Context(1, [E(Ability.Noticing, 1), E(Ability.Prioritizing, 1), E(Ability.Prioritizing, 3)]);

        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Prioritizing, 2)),
            NextMovePolicy.Decide(Concrete, 1, context));

        // 同じ数なら、力の並び（noticing、coordinating、prioritizing）の順
        var tie = Context(1, [E(Ability.Prioritizing, 1), E(Ability.Coordinating, 2)]);
        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Coordinating, 1)),
            NextMovePolicy.Decide(Concrete, 1, tie));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: いまの答えの出来事の中で聞く")]
    public void AsksWithinCurrentEvent()
    {
        // いまの答え（2 番目）は出来事 2 の話。出来事 1 の調整する力ではなく、出来事 2 の見立てる力を聞く
        var context = Context(2,
        [
            E(Ability.Coordinating, 1, @event: 1, answer: 1),
            E(Ability.Coordinating, 2, @event: 1, answer: 1),
            E(Ability.Noticing, 1, @event: 2, answer: 2),
        ]);

        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Noticing, 2)),
            NextMovePolicy.Decide(Concrete, 2, context));

        // いまの答えに根拠がなければ、いちばん新しい出来事で聞く
        var noneInLatest = Context(3, [E(Ability.Coordinating, 1, @event: 1, answer: 1), E(Ability.Noticing, 1, @event: 2, answer: 2)]);
        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Noticing, 2)),
            NextMovePolicy.Decide(Concrete, 3, noneInLatest));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: いまの出来事は読み取りごとに見分け、前の読み取りの同じ番号の行動とは合わせない")]
    public void CurrentEventIsPerReading()
    {
        // 1 回目の読み取りの出来事 1 に行動 1。2 回目の読み取りは、いまの答え（2 番目）を出来事 1 として行動 2 だけを返した。
        // 2 回目の出来事 1 で足りないのは行動 1 と 3。1 回目の行動 1 は別の日のことかもしれないので、そろったとは数えない。
        // 聞くのは、この場面でまだどこにも話に出ていない行動 3 が先
        IReadOnlyList<Evidence> evidence =
        [
            E(Ability.Prioritizing, 1, @event: 1, answer: 1) with { Reading = 1 },
            E(Ability.Prioritizing, 2, @event: 1, answer: 2) with { Reading = 2 },
        ];
        var third = new ActionRef(Ability.Prioritizing, 3);

        Assert.Equal(new NextMove(MoveKind.AskMissingAction, third), NextMovePolicy.Decide(Concrete, 2, Context(2, evidence)));

        // 行動 3 を 2 回聞いたら、別の読み取りで話に出た行動 1 も、いまの出来事の中で聞く
        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Prioritizing, 1)),
            NextMovePolicy.Decide(Concrete, 2, Context(2, evidence, (third, 2))));

        // いまの答えに根拠がなければ、いちばん新しい読み取りの、番号の大きい出来事で聞く
        var noneInLatest = Context(3,
        [
            E(Ability.Prioritizing, 1, @event: 2, answer: 1) with { Reading = 1 },
            E(Ability.Noticing, 1, @event: 1, answer: 2) with { Reading = 2 },
        ]);
        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Noticing, 2)),
            NextMovePolicy.Decide(Concrete, 3, noneInLatest));
    }

    [Fact(DisplayName = "validate-10（一般論には具体的な出来事を聞く）: いまの答えが一般論だけなら、足りない行動ではなく具体的な出来事を聞く")]
    public void GeneralOnlyAsksConcreteEventEvenWithEvidence()
    {
        var context = Context(2, [E(Ability.Coordinating, 1, answer: 2, general: true), E(Ability.Noticing, 1, answer: 1)]);

        Assert.Equal(new NextMove(MoveKind.AskConcreteEvent), NextMovePolicy.Decide(Read(AnswerSignal.GeneralOnly), 2, context));

        // 一般論の根拠しかない場面で、具体的な出来事を話していても、一般論の行動は聞き返さない
        var generalOnly = Context(1, [E(Ability.Coordinating, 1, general: true)]);
        Assert.Equal(new NextMove(MoveKind.AskWhatYouDid), NextMovePolicy.Decide(Concrete, 1, generalOnly));
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: そろった力は聞かない")]
    public void ConfirmedAbilityIsNotAsked()
    {
        var context = Context(3, [E(Ability.Coordinating, 1, answer: 1), E(Ability.Coordinating, 2, answer: 2), E(Ability.Coordinating, 3, answer: 3)]);

        Assert.Equal(new NextMove(MoveKind.AskWhatYouDid), NextMovePolicy.Decide(Concrete, 3, context));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 場面ですでに根拠ありの力は、新しい読み取りが同じ出来事の行動を落としても聞き直さない")]
    public void ConfirmedInSceneIsNotAskedAgain()
    {
        // 3 回目の読み取りで調整する力の 3 つがそろった。4 回目の読み取りは、同じ出来事の行動 3 を落とした
        IReadOnlyList<Evidence> evidence =
        [
            E(Ability.Coordinating, 1, answer: 1) with { Reading = 3 },
            E(Ability.Coordinating, 2, answer: 2) with { Reading = 3 },
            E(Ability.Coordinating, 3, answer: 3) with { Reading = 3 },
            E(Ability.Coordinating, 1, answer: 1) with { Reading = 4 },
            E(Ability.Coordinating, 2, answer: 4) with { Reading = 4 },
        ];
        Assert.Equal(
            AbilityState.Confirmed,
            AbilityStates.Evaluate(evidence).Single(r => r.Ability == Ability.Coordinating).State);

        Assert.Equal(new NextMove(MoveKind.AskWhatYouDid), NextMovePolicy.Decide(Concrete, 4, Context(4, evidence)));

        // 同じ出来事に要確認の力がほかにあれば、そちらの足りない行動を聞く
        IReadOnlyList<Evidence> withPrioritizing = [.. evidence, E(Ability.Prioritizing, 1, answer: 4) with { Reading = 4 }];
        Assert.Equal(
            new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Prioritizing, 2)),
            NextMovePolicy.Decide(Concrete, 4, Context(4, withPrioritizing)));
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: つらい状態のサイン、締め、家族の病気は、足りない行動より先")]
    public void SaferMovesComeFirst()
    {
        var context = Context(1, [E(Ability.Coordinating, 1)]);

        Assert.Equal(MoveKind.Distress, NextMovePolicy.Decide(Read(AnswerSignal.Distress, AnswerSignal.ConcreteEvent), 1, context).Kind);
        Assert.Equal(MoveKind.Close, NextMovePolicy.Decide(Concrete, NextMovePolicy.MaxUserTurns, context).Kind);
        Assert.Equal(MoveKind.ReturnFromIllness, NextMovePolicy.Decide(Read(AnswerSignal.FamilyIllness, AnswerSignal.ConcreteEvent), 1, context).Kind);
        Assert.Null(NextMovePolicy.Decide(Concrete, NextMovePolicy.MaxUserTurns, context).Target);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: turnLimit を 12 にすると 8 往復目では締めない")]
    public void TurnLimitMovesClose()
    {
        Assert.Equal(MoveKind.AskWhatYouDid, NextMovePolicy.Decide(Concrete, 8, turnLimit: 12).Kind);
        Assert.Equal(MoveKind.Close, NextMovePolicy.Decide(Concrete, 12, turnLimit: 12).Kind);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 聞いた回数は、行動を添えた聞き手のターンから数える")]
    public void ContextCountsAskedTargets()
    {
        var target = new ActionRef(Ability.Coordinating, 3);
        IReadOnlyList<Turn> turns =
        [
            new() { Role = TurnRoles.Assistant, Text = "q1", Move = "opening", At = At },
            new() { Role = TurnRoles.User, Text = "a1", AnswerKind = AnswerKind.Free, At = At },
            new() { Role = TurnRoles.Assistant, Text = "q2", Move = "askMissingAction", Target = target.ToString(), At = At },
            new() { Role = TurnRoles.User, Text = "a2", AnswerKind = AnswerKind.Free, At = At },
            new() { Role = TurnRoles.Assistant, Text = "q3", Move = "askMissingAction", Target = target.ToString(), At = At },
            new() { Role = TurnRoles.User, Text = "a3", AnswerKind = AnswerKind.Choice, At = At },
        ];
        IReadOnlyList<Evidence> evidence = [E(Ability.Coordinating, 1)];

        var context = ValidationContext.From(turns, evidence);

        Assert.Equal(3, context.LatestAnswer);
        Assert.Equal(2, context.AskedCounts[target]);
        Assert.Same(evidence, context.Evidence);
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 訂正で打ち消された行動は、聞いた回数の上限に届いたものとして数える")]
    public void WithdrawnActionsCountAsAskedToTheLimit()
    {
        var withdrawn = new ActionRef(Ability.Coordinating, 2);
        IReadOnlyList<Turn> turns =
        [
            new() { Role = TurnRoles.Assistant, Text = "q1", Move = "opening", At = At },
            new() { Role = TurnRoles.User, Text = "a1", AnswerKind = AnswerKind.Free, At = At },
            new() { Role = TurnRoles.Assistant, Text = "q2", Move = "close", At = At },
            new() { Role = TurnRoles.User, Text = "c1", AnswerKind = AnswerKind.Correction, Withdrawn = [withdrawn.ToString(), "cooking.9"], At = At },
        ];
        IReadOnlyList<Evidence> evidence = [E(Ability.Coordinating, 1), E(Ability.Coordinating, 3)];

        var context = ValidationContext.From(turns, evidence);

        Assert.Equal(NextMovePolicy.MaxAskPerAction, context.AskedCounts[withdrawn]);
        Assert.Single(context.AskedCounts);
        // 足りないのが打ち消された行動だけなら、足りない行動を聞く一手にしない
        Assert.Equal(new NextMove(MoveKind.AskWhatYouDid), NextMovePolicy.Decide(Concrete, 2, context));
    }
}
