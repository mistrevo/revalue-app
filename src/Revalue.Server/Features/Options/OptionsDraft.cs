namespace Revalue.Server.Features.Options;

/// <summary>「選ぶ」の AI の答え。作らないときは <paramref name="Made"/> が false。コード（<see cref="OptionsValidator"/>）が照らし合わせるまでは使わない。</summary>
public sealed record ChooseDraft(bool Made, string OccupationId, IReadOnlyList<string> TaskIds, string Ability, string Reason);

/// <summary>「組み合わせる」の AI の答え。</summary>
public sealed record CombineDraft(bool Made, IReadOnlyList<string> TaskIds, string RoleName, string Ability, string Reason);

/// <summary>「創る」の AI の答え。<paramref name="Quotes"/> は使った力の根拠の本人の言葉。</summary>
public sealed record CreateDraft(
    bool Made,
    string Title,
    string Who,
    string Trouble,
    string Summary,
    string Ability,
    IReadOnlyList<string> Quotes,
    int HoursPerWeek,
    string Place,
    IReadOnlyList<string> TimeSlots,
    string Reason);

/// <summary>AI が返す 3 枚のカードの下書き。</summary>
public sealed record OptionsDraft(ChooseDraft Choose, CombineDraft Combine, CreateDraft Create);
