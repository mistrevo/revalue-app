using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Tests;

public sealed class NextMovePolicyTests
{
    private static TurnReading Read(params AnswerSignal[] signals) => new(new HashSet<AnswerSignal>(signals));

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 分からない・何もないには、答えやすい場面を聞く")]
    public void DontKnowAsksEasierScene() =>
        Assert.Equal(MoveKind.AskEasierScene, NextMovePolicy.Decide(Read(AnswerSignal.DontKnow), 1));

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 一般論と「何もない」が重なっても、答えやすい場面を聞く")]
    public void DontKnowWinsOverGeneralOnly() =>
        Assert.Equal(MoveKind.AskEasierScene, NextMovePolicy.Decide(Read(AnswerSignal.GeneralOnly, AnswerSignal.DontKnow), 2));

    [Fact(DisplayName = "discover-4（「何もない」も受け止める）: 行動を話したうえで「特別なことは何も」と添えても、その出来事の中で本人がしたことを聞く")]
    public void ConcreteEventWinsOverDontKnow() =>
        Assert.Equal(MoveKind.AskWhatYouDid, NextMovePolicy.Decide(Read(AnswerSignal.ConcreteEvent, AnswerSignal.DontKnow), 2));

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 具体的な出来事があれば、一般論が添えてあっても、その出来事の中で本人がしたことを聞く")]
    public void ConcreteEventWinsOverGeneralOnly()
    {
        Assert.Equal(MoveKind.AskWhatYouDid, NextMovePolicy.Decide(Read(AnswerSignal.ConcreteEvent, AnswerSignal.GeneralOnly), 2));
        Assert.Equal(MoveKind.AskWhatYouDid, NextMovePolicy.Decide(Read(AnswerSignal.ConcreteEvent, AnswerSignal.GeneralOnly, AnswerSignal.DontKnow), 2));
    }

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 具体的な出来事と「何もない」が重なっても、家族の病気の話が先")]
    public void FamilyIllnessWinsOverConcreteEventAndDontKnow() =>
        Assert.Equal(
            MoveKind.ReturnFromIllness,
            NextMovePolicy.Decide(Read(AnswerSignal.FamilyIllness, AnswerSignal.ConcreteEvent, AnswerSignal.DontKnow), 3));

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 家族の病気の話には、本人がしたことに戻す")]
    public void FamilyIllnessReturnsToWhatYouDid() =>
        Assert.Equal(MoveKind.ReturnFromIllness, NextMovePolicy.Decide(Read(AnswerSignal.FamilyIllness, AnswerSignal.ConcreteEvent), 3));

    [Fact(DisplayName = "discover-9（病気の詳しいことは聞かない）: 家族の病気の話は、「何もない」より先")]
    public void FamilyIllnessWinsOverDontKnow() =>
        Assert.Equal(MoveKind.ReturnFromIllness, NextMovePolicy.Decide(Read(AnswerSignal.FamilyIllness, AnswerSignal.DontKnow), 3));

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: つらい状態のサインがいちばん先")]
    public void DistressComesFirst()
    {
        var reading = Read(AnswerSignal.Distress, AnswerSignal.DontKnow, AnswerSignal.FamilyIllness);

        Assert.Equal(MoveKind.Distress, NextMovePolicy.Decide(reading, 1));
        Assert.Equal(MoveKind.Distress, NextMovePolicy.Decide(reading, NextMovePolicy.MaxUserTurns));
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 8 往復目は締める")]
    public void EighthTurnCloses()
    {
        Assert.Equal(8, NextMovePolicy.MaxUserTurns);
        Assert.Equal(MoveKind.Close, NextMovePolicy.Decide(Read(AnswerSignal.ConcreteEvent), 8));
        Assert.Equal(MoveKind.AskWhatYouDid, NextMovePolicy.Decide(Read(AnswerSignal.ConcreteEvent), 7));
        Assert.Equal(MoveKind.Close, NextMovePolicy.Decide(Read(AnswerSignal.FamilyIllness, AnswerSignal.DontKnow), 8));
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 一般論だけには、その中の具体的な出来事を聞く")]
    public void GeneralOnlyAsksConcreteEvent() =>
        Assert.Equal(MoveKind.AskConcreteEvent, NextMovePolicy.Decide(Read(AnswerSignal.GeneralOnly), 1));

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 具体的な出来事や空の読み取りには、本人がしたことを聞く")]
    public void ConcreteOrEmptyAsksWhatYouDid()
    {
        Assert.Equal(MoveKind.AskWhatYouDid, NextMovePolicy.Decide(Read(AnswerSignal.ConcreteEvent), 1));
        Assert.Equal(MoveKind.AskWhatYouDid, NextMovePolicy.Decide(Read(), 1));
    }
}
