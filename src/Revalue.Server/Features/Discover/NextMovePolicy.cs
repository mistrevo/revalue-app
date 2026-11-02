using Revalue.Server.Ai;

namespace Revalue.Server.Features.Discover;

/// <summary>次の一手。コードが決め、AI には決まった一手だけを言葉にさせる。</summary>
public enum MoveKind
{
    /// <summary>その出来事の中で本人がしたことを、一つ聞く。</summary>
    AskWhatYouDid,

    /// <summary>一般論を受け止めて、その中の具体的な出来事を一つ聞く。</summary>
    AskConcreteEvent,

    /// <summary>「分からない」「何もない」を答えとして受け止め、答えやすい具体的な場面を一つ聞く。</summary>
    AskEasierScene,

    /// <summary>病気の詳しいことは聞かず、本人がしたことに話を戻す。</summary>
    ReturnFromIllness,

    /// <summary>つらい状態のサイン。AI の返事は使わず、コードが決めた言葉と相談窓口を出す。</summary>
    Distress,

    /// <summary>8 往復目。受け止めて映し返し、問いを出さずに場面を締める。</summary>
    Close,
}

/// <summary>読み取りと往復の数から、次の一手を決める（02-discover.md の「次の一手」）。</summary>
public static class NextMovePolicy
{
    /// <summary>1 場面の往復の上限。この数の答えへの返事で場面を締める。</summary>
    public const int MaxUserTurns = 8;

    /// <summary>
    /// 優先の順: つらい状態のサイン → 8 往復目の締め → 家族の病気の話 → 具体的な出来事がある → 分からない・何もない → 一般論だけ → それ以外。
    /// </summary>
    /// <param name="reading">いまの答えの読み取り。</param>
    /// <param name="userTurnNumber">いまの答えが何往復目か（1 から）。</param>
    public static MoveKind Decide(TurnReading reading, int userTurnNumber)
    {
        if (reading.Has(AnswerSignal.Distress))
        {
            return MoveKind.Distress;
        }

        if (userTurnNumber >= MaxUserTurns)
        {
            return MoveKind.Close;
        }

        if (reading.Has(AnswerSignal.FamilyIllness))
        {
            return MoveKind.ReturnFromIllness;
        }

        // 具体的な出来事を話していれば、「特別なことは何も」のような言葉や一般論が添えてあっても、
        // 話してくれた行動を映し返し、その出来事の中で聞く。別の場面へ移ると、本人の話を受け取らなかったことになる（Claude の判断）
        if (reading.Has(AnswerSignal.ConcreteEvent))
        {
            return MoveKind.AskWhatYouDid;
        }

        if (reading.Has(AnswerSignal.DontKnow))
        {
            return MoveKind.AskEasierScene;
        }

        if (reading.Has(AnswerSignal.GeneralOnly))
        {
            return MoveKind.AskConcreteEvent;
        }

        return MoveKind.AskWhatYouDid;
    }
}
