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
    /// <summary>いまの条件に収まる登録の業務がない。</summary>
    [JsonStringEnumMemberName("noFit")]
    NoFit,

    /// <summary>条件に収まる登録の業務はあるが、どれも本人が使える力を使わない。</summary>
    [JsonStringEnumMemberName("noAbilityMatch")]
    NoAbilityMatch,

    /// <summary>AI が作らないと答えたか、AI の答えが照らし合わせに通らなかった。または保存したカードの業務が、いまの登録にない。</summary>
    [JsonStringEnumMemberName("rejected")]
    Rejected,

    /// <summary>カードの力を本人が外した。</summary>
    [JsonStringEnumMemberName("excluded")]
    Excluded,

    /// <summary>
    /// カードの力の状態か根拠の言葉が、いまの記録と合わなくなった。訂正で場面を読み直したときや、場面に力の確かめに使わない印
    /// （つらい状態のサイン）が付いたときに起きる。
    /// </summary>
    [JsonStringEnumMemberName("changed")]
    Changed,
}

/// <summary>カードの業務。<paramref name="TimeSlots"/> は、業務の時間帯のうち本人の時間帯に入るもの。見せるときは、いまの条件で計算し直す。</summary>
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

/// <summary>カードの理由に使った力と、その根拠の本人の言葉。カードを作ったときの力の状態と根拠の写し。</summary>
public sealed record CardAbility(Ability Ability, AbilityState State, IReadOnlyList<Evidence> Quotes)
{
    /// <summary>
    /// いまの記録で、この力と根拠の言葉をそのまま見せられないときの理由。見せられるなら null（05-options.md の「作り直す」と「本人が選ぶ」）。
    /// 本人が外していれば <see cref="MissingReason.Excluded"/>。使える力でなくなった、状態が変わった、根拠の言葉がいまの根拠にない、
    /// のどれかなら <see cref="MissingReason.Changed"/>。根拠のない力や、確かめに使わない場面の言葉を出さないため（製品の芯 1）。
    /// 根拠の言葉は、画面に出す中身（言葉、選んだ答えか、結びついた言葉）で比べる。どれも元の記録の指紋（<see cref="OptionsInputsReader.Basis"/>）に
    /// 入るので、ここで見せられないカードは、いつも作り直す対象になる。
    /// </summary>
    public MissingReason? ProblemIn(OptionsInputs inputs)
    {
        if (inputs.Excluded.Contains(Ability))
        {
            return MissingReason.Excluded;
        }

        if (inputs.Abilities.FirstOrDefault(a => a.Ability == Ability) is not { } now || now.State != State)
        {
            return MissingReason.Changed;
        }

        return Quotes.All(q => now.Quotes.Any(e => e.Quote == q.Quote && e.FromChoice == q.FromChoice && e.LinkedQuote == q.LinkedQuote))
            ? null
            : MissingReason.Changed;
    }
}

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
