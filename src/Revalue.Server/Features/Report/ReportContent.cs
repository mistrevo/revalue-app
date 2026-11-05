using System.Text.Json.Serialization;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Report;

/// <summary>レポートの欄。この順が画面の順（07-report.md の「まとめる中身」）。</summary>
[JsonConverter(typeof(JsonStringEnumConverter<ReportSection>))]
public enum ReportSection
{
    /// <summary>確かめた力。</summary>
    [JsonStringEnumMemberName("abilities")]
    Abilities,

    /// <summary>まだ確かめていないこと。</summary>
    [JsonStringEnumMemberName("notYet")]
    NotYet,

    /// <summary>5 つの記録。</summary>
    [JsonStringEnumMemberName("records")]
    Records,

    /// <summary>選んだ案。</summary>
    [JsonStringEnumMemberName("choice")]
    Choice,

    /// <summary>仕事の場面での考え方。</summary>
    [JsonStringEnumMemberName("thinking")]
    Thinking,

    /// <summary>最初の一歩。</summary>
    [JsonStringEnumMemberName("steps")]
    Steps,
}

/// <summary>確かめた力 1 つ。<paramref name="State"/> は根拠ありか要確認。<paramref name="Quotes"/> は根拠の本人の言葉。</summary>
public sealed record ReportAbility(Ability Ability, AbilityState State, IReadOnlyList<Evidence> Quotes);

/// <summary>
/// 選んだ案の業務 1 つで、まだ確かめていないこと。<paramref name="Ability"/> は、業務で使う力が使える力でなく、本人が外してもいないとき。
/// <paramref name="Knowledge"/> は業務に要る知識や道具。
/// </summary>
public sealed record ReportTaskGap(string TaskName, Ability? Ability, IReadOnlyList<string> Knowledge);

/// <summary>
/// まだ確かめていないこと。<paramref name="Checking"/> は確かめ中の力（本人に見せた力だけ）。まだ聞けていない力の名前は並べない（00-common.md の「力」の「見せる力」）。
/// <paramref name="HasExcluded"/> は、選んだ案の業務で使う力を本人が外していて、その名前を出していないか。
/// </summary>
public sealed record ReportNotYet(IReadOnlyList<Ability> Checking, IReadOnlyList<ReportTaskGap> TaskGaps, bool HasExcluded);

/// <summary>5 つの記録。できることは確かめた力の欄と同じ中身なので持たない。</summary>
public sealed record ReportRecords(IReadOnlyList<ProfileEntry> Preferences, IReadOnlyList<ProfileEntry> Wants, ProfileConditions? Conditions, string? Agency);

/// <summary>
/// 選んだ案。<paramref name="Kind"/> が null ならまだ選んでいない。保留なら <paramref name="Title"/> は null。
/// <paramref name="Summary"/> は職種の説明、「創る」の誰の・困りごと・中身をつないだ文、本人が書いた仕事のメモ。
/// <paramref name="Reason"/> と <paramref name="Ability"/> はカードの理由と、もとにした力と根拠の言葉で、いまの記録で使えるときだけ入る。
/// 使えないときは <paramref name="Problem"/> に理由。<paramref name="OutsideConditions"/> は選んだ案がいまの条件に収まらないか（本人が書いた仕事は false）。
/// <paramref name="CardsStale"/> は、05 のカードを作ったあとに元の記録が変わったか。
/// </summary>
public sealed record ReportChoice(
    ChoiceKind? Kind,
    CardKind? Card,
    string? Title,
    string? Summary,
    IReadOnlyList<string> Tasks,
    string? Reason,
    ReportAbility? Ability,
    MissingReason? Problem,
    bool OutsideConditions,
    bool DemandNotChecked,
    bool CardsStale);

/// <summary>仮の場面の問いと、本人の答え。</summary>
public sealed record ReportThought(string Situation, string Answer, bool FromChoice);

/// <summary>最初の一歩。<paramref name="Own"/> は本人が書いた一歩。<paramref name="Fits"/> は選んだ候補がいまの条件に収まるか（書いた一歩は true）。</summary>
public sealed record ReportStep(string Text, bool Own, bool Fits);

/// <summary>
/// 可能性レポートの中身。<paramref name="Thinking"/> と <paramref name="Steps"/> は、いまの選んだ案で深めた中身がなければ null。
/// </summary>
public sealed record ReportContent(
    IReadOnlyList<ReportAbility> Abilities,
    ReportNotYet NotYet,
    ReportRecords Records,
    ReportChoice Choice,
    IReadOnlyList<ReportThought>? Thinking,
    IReadOnlyList<ReportStep>? Steps);
