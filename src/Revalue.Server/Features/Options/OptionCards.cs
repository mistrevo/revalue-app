using System.Text.Json.Serialization;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Options;

[JsonConverter(typeof(JsonStringEnumConverter<CardKind>))]
public enum CardKind
{
    [JsonStringEnumMemberName("choose")]
    Choose,

    [JsonStringEnumMemberName("combine")]
    Combine,

    [JsonStringEnumMemberName("create")]
    Create,
}

/// <summary>カードを出せない理由。</summary>
[JsonConverter(typeof(JsonStringEnumConverter<MissingReason>))]
public enum MissingReason
{
    /// <summary>条件に合う業務がない、または作らないと答えた。</summary>
    [JsonStringEnumMemberName("noFit")]
    NoFit,

    /// <summary>AI の答えが照らし合わせに通らなかった、または保存したカードをいまは見せられない。</summary>
    [JsonStringEnumMemberName("rejected")]
    Rejected,

    /// <summary>「創る」で本人の根拠の言葉を引けなかった。</summary>
    [JsonStringEnumMemberName("noEvidence")]
    NoEvidence,

    /// <summary>カードの力を本人が外した。</summary>
    [JsonStringEnumMemberName("excluded")]
    Excluded,
}

/// <summary>カードの業務。<paramref name="TimeSlots"/> は作ったときの、本人の時間帯に入るもの。保存のときの中身のまま残す。</summary>
public sealed record CardTask(
    string TaskId,
    string OccupationId,
    string OccupationName,
    string Name,
    string Detail,
    Ability Ability,
    IReadOnlyList<TimeSlot> TimeSlots,
    TaskPlace Place,
    IReadOnlyList<string> Knowledge);

/// <summary>カードの理由に使った力と、その根拠の本人の言葉。</summary>
public sealed record CardAbility(Ability Ability, AbilityState State, IReadOnlyList<Evidence> Quotes);

public sealed record ChooseCard(
    string OccupationId, string OccupationName, string Summary, IReadOnlyList<CardTask> Tasks, WorkRange Range, string Reason, CardAbility Ability);

public sealed record CombineCard(string RoleName, IReadOnlyList<CardTask> Tasks, WorkRange Range, string Reason, CardAbility Ability);

public sealed record CreateCard(
    string Title,
    string Who,
    string Trouble,
    string Summary,
    int HoursPerWeek,
    TaskPlace Place,
    IReadOnlyList<TimeSlot> TimeSlots,
    string Reason,
    CardAbility Ability);

public sealed record MissingCard(CardKind Kind, MissingReason Reason);

/// <summary>3 枚のカード。出せないカードは null で、<paramref name="Missing"/> に理由を持つ。<paramref name="Basis"/> は作ったときの元の記録の指紋。</summary>
public sealed record OptionCards(
    DateTimeOffset GeneratedAt,
    string Basis,
    ChooseCard? Choose,
    CombineCard? Combine,
    CreateCard? Create,
    IReadOnlyList<MissingCard> Missing);

/// <summary>照らし合わせで落としたカードと、当たった規則の名前。評価とログが規則ごとに数える。</summary>
public sealed record CardRejection(CardKind Kind, string Rule);
