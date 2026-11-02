using Revalue.Server.Features.Validate;

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

/// <summary>
/// いまの答えの読み取り。画面には出さない。
/// <see cref="Candidates"/> は、場面のやりとり全体から見つけた核となる行動の根拠の候補。コードが照らし合わせるまでは使わない。
/// null なら候補なしとして扱う。
/// </summary>
public sealed record TurnReading(IReadOnlySet<AnswerSignal> Signals, IReadOnlyList<EvidenceCandidate>? Candidates = null)
{
    public bool Has(AnswerSignal signal) => Signals.Contains(signal);
}

/// <summary>
/// 会話の AI。1 往復ごとに、まず読み取り（答えの種類と根拠の候補）を受け取り、次に、コードが決めた一手を言葉にさせる。
/// テストと開発では偽物（<see cref="ScriptedConversationAi"/>）に差し替える。
/// </summary>
public interface IConversationAi
{
    /// <summary>いまの答えの種類と、場面全体の根拠の候補を読み取る。<paramref name="turns"/> の最後は、いま届いた利用者の答え（訂正のときは訂正）。</summary>
    /// <exception cref="ConversationAiException">AI が断った、または失敗した。</exception>
    Task<TurnReading> ReadAsync(IReadOnlyList<Features.Discover.Turn> turns, CancellationToken ct);

    /// <summary>
    /// 決まった一手を言葉にした返事を、書いた順に少しずつ返す。本文のあとに区切りの行と選択肢を書く（締めの返事を除く）。
    /// <paramref name="turns"/> の最後は、いま届いた利用者の答え。足りない行動を聞く一手では、<see cref="Features.Discover.NextMove.Target"/> の手がかりだけを渡す。
    /// </summary>
    /// <exception cref="ConversationAiException">AI が断った、または失敗した。途中まで返したあとに投げることもある。</exception>
    IAsyncEnumerable<string> StreamReplyAsync(IReadOnlyList<Features.Discover.Turn> turns, Features.Discover.NextMove move, CancellationToken ct);
}

/// <summary>AI の呼び出しがうまくいかなかった。<see cref="Kind"/> は <see cref="Refusal"/>（AI が断った）か <see cref="Failure"/>（不調）。</summary>
public sealed class ConversationAiException(string kind, Exception? inner = null)
    : Exception($"The conversation AI call ended with {kind}.", inner)
{
    public const string Refusal = "refusal";
    public const string Failure = "failure";

    public string Kind { get; } = kind;
}
