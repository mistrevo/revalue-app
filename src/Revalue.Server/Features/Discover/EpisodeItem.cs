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

    public required DateTimeOffset At { get; init; }
}

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
