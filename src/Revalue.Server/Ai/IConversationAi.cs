namespace Revalue.Server.Ai;

/// <summary>読み取りで見分ける、答えの種類。一つの答えが複数に当たることがある。</summary>
public enum AnswerSignal
{
    /// <summary>いつ、だれと、何をしたかが分かる出来事を話している。</summary>
    ConcreteEvent,

    /// <summary>「いつも〜している」のような話で、一つの出来事がない。</summary>
    GeneralOnly,

    /// <summary>「分からない」「私には何もない」のような答え。</summary>
    DontKnow,

    /// <summary>家族の病気や症状にふれている。</summary>
    FamilyIllness,

    /// <summary>本人の心身の不調、家庭内の暴力、死にたいという言葉がある。</summary>
    Distress,
}

/// <summary>いまの答えの読み取り。画面には出さない。</summary>
public sealed record TurnReading(IReadOnlySet<AnswerSignal> Signals)
{
    public bool Has(AnswerSignal signal) => Signals.Contains(signal);
}
