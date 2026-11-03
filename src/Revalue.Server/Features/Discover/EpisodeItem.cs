using System.Text.Json.Serialization;
using Revalue.Server.Data;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Discover;

/// <summary>利用者の答えが、選択肢を選んだものか、自由に書いたものか、話し終えた場面への訂正か。</summary>
[JsonConverter(typeof(JsonStringEnumConverter<AnswerKind>))]
public enum AnswerKind
{
    [JsonStringEnumMemberName("free")]
    Free,

    [JsonStringEnumMemberName("choice")]
    Choice,

    /// <summary>話し終えた場面の読み取りを、本人が直した言葉。前の答えより優先する。</summary>
    [JsonStringEnumMemberName("correction")]
    Correction,
}

public static class TurnRoles
{
    public const string Assistant = "assistant";
    public const string User = "user";
}

public static class EpisodeStatus
{
    public const string Talking = "talking";
    public const string Finished = "finished";
}

/// <summary>やりとりの 1 ターン。assistant は問いや返事、user は利用者の答え。</summary>
public sealed record Turn
{
    /// <summary><see cref="TurnRoles.Assistant"/> か <see cref="TurnRoles.User"/>。</summary>
    public required string Role { get; init; }

    public required string Text { get; init; }

    /// <summary>assistant のターンで、答えの選択肢（3 つ）。締めの返事やつらい状態のサインへの言葉では null。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? Choices { get; init; }

    /// <summary>user のターンで、選んだ答えか書いた答えか。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public AnswerKind? AnswerKind { get; init; }

    /// <summary>assistant のターンで、どの一手として出した言葉か（最初の問いは "opening"、飛ばしたあとは "afterSkip"）。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Move { get; init; }

    /// <summary>
    /// assistant のターンで、聞いた核となる行動（<c>coordinating.3</c> の形）。足りない行動を聞く一手と、続きを話すときの問いだけ。
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public string? Target { get; init; }

    /// <summary>
    /// 訂正のターン（<see cref="AnswerKind.Correction"/>）で、訂正で打ち消された行動（<c>coordinating.2</c> の形）。
    /// 訂正の読み直しで根拠が消えた行動。本人がもう答えたことを聞き直さないよう、聞いた回数の上限に届いたものとして扱う（03-validate.md の「訂正」）。
    /// 打ち消された行動がなければ null。
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public IReadOnlyList<string>? Withdrawn { get; init; }

    public required DateTimeOffset At { get; init; }
}

/// <summary>続きを話す前の、話し終えた場面の姿。</summary>
/// <param name="TurnCount">続きの問いを足す前のターンの数。</param>
/// <param name="ResumedAt">続きを始めた日時（続きの問いを足さずに開いたときも）。続きを話している途中で飛ばしたときに、これより後に作ったレポートの版を捨てる
/// （07-report.md の「版を残す」）。この項目を持たない前の保存では null。</param>
public sealed record ResumePoint(
    int TurnCount, DateTimeOffset? FinishedAt, int TurnLimit, IReadOnlyList<Evidence> Evidence, DateTimeOffset? ResumedAt = null);

/// <summary>
/// エピソード（話した一つの場面）。始めたときから保存し、やりとりのターンをすべて持つ。
/// 状態は <see cref="EpisodeStatus.Talking"/>（話している途中）と <see cref="EpisodeStatus.Finished"/>（話し終えた）。
/// </summary>
public sealed record EpisodeItem : Item
{
    public const string ItemType = "episode";
    public const string IdPrefix = "episode-";

    public required string Status { get; init; }

    public required DateTimeOffset StartedAt { get; init; }

    public DateTimeOffset? FinishedAt { get; init; }

    public IReadOnlyList<Turn> Turns { get; init; } = [];

    /// <summary>力の確かめに使わない印。つらい状態のサインが出た場面に付ける。</summary>
    public bool ExcludedFromValidation { get; init; }

    /// <summary>この場面の往復の上限。この数の答えへの返事で場面を締める。続きを話すときに増やす。</summary>
    public int TurnLimit { get; init; } = NextMovePolicy.MaxUserTurns;

    /// <summary>
    /// この場面で確かめた、核となる行動の根拠（照らし合わせを通ったもの）。会話の途中では足していき、訂正のときだけ読み直した結果で置き換える。
    /// </summary>
    public IReadOnlyList<Evidence> Evidence { get; init; } = [];

    /// <summary>
    /// 続きを話す前の姿（03-validate.md の「続きを話す」）。続きを話している途中で飛ばしたときに、ここへ戻す
    /// （続きで足したやりとりと根拠だけを残さず、前に話し終えていた分は残す）。続きを話したことのない場面では null。
    /// </summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public ResumePoint? BeforeResume { get; init; }

    /// <summary>利用者が答えた数（往復の数）。</summary>
    [JsonIgnore]
    public int UserTurnCount => Turns.Count(t => t.Role == TurnRoles.User);

    public static string NewId() => IdPrefix + Guid.NewGuid().ToString("N");

    /// <summary>エピソードの id の形か。了解の記録などほかのアイテムの id で読まないために使う。</summary>
    public static bool IsEpisodeId(string id) => id.StartsWith(IdPrefix, StringComparison.Ordinal) && id.Length > IdPrefix.Length;

    /// <summary>コードが決めた問いで始まる、新しい場面を作る。</summary>
    public static EpisodeItem Start(string userKey, DateTimeOffset now, string question, IReadOnlyList<string> choices, string move) => new()
    {
        Id = NewId(),
        UserKey = userKey,
        Type = ItemType,
        Status = EpisodeStatus.Talking,
        StartedAt = now,
        Turns = [new Turn { Role = TurnRoles.Assistant, Text = question, Choices = choices, Move = move, At = now }],
    };
}
