using System.Globalization;
using System.Text.Json.Serialization;

namespace Revalue.Server.Features.Validate;

/// <summary>見る力。並びはこの順（表示と、同じ数のときの選び方に使う）。</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Ability>))]
public enum Ability
{
    /// <summary>見立てる力。</summary>
    [JsonStringEnumMemberName("noticing")]
    Noticing,

    /// <summary>調整する力。</summary>
    [JsonStringEnumMemberName("coordinating")]
    Coordinating,

    /// <summary>優先順位をつける力。</summary>
    [JsonStringEnumMemberName("prioritizing")]
    Prioritizing,
}

/// <summary>力の状態。画面には呼び名を出さない（00-common.md の「言葉」）。</summary>
[JsonConverter(typeof(JsonStringEnumConverter<AbilityState>))]
public enum AbilityState
{
    /// <summary>未確認: 根拠のある行動がない。</summary>
    [JsonStringEnumMemberName("notYet")]
    NotYet,

    /// <summary>要確認: 根拠のある行動が一つ以上あるが、根拠ありには届かない。</summary>
    [JsonStringEnumMemberName("needsCheck")]
    NeedsCheck,

    /// <summary>根拠あり: 同じ出来事の中で、一般論でない根拠が 3 つの行動すべてにそろった。</summary>
    [JsonStringEnumMemberName("confirmed")]
    Confirmed,
}

/// <summary>核となる行動の一つ。<see cref="Number"/> は 1〜3。文字にすると <c>coordinating.3</c> の形。</summary>
public sealed record ActionRef(Ability Ability, int Number)
{
    /// <summary>力ごとの核となる行動の数。</summary>
    public const int ActionsPerAbility = 3;

    public static string Key(Ability ability) => ability switch
    {
        Ability.Noticing => "noticing",
        Ability.Coordinating => "coordinating",
        Ability.Prioritizing => "prioritizing",
        _ => throw new ArgumentOutOfRangeException(nameof(ability)),
    };

    /// <summary><c>noticing</c> などの名前を力にする。知らない名前なら false。大文字と小文字は区別する。</summary>
    public static bool TryParseAbility(string? key, out Ability ability)
    {
        foreach (var candidate in Enum.GetValues<Ability>())
        {
            if (string.Equals(Key(candidate), key, StringComparison.Ordinal))
            {
                ability = candidate;
                return true;
            }
        }

        ability = default;
        return false;
    }

    /// <summary><c>coordinating.3</c> の形を読む。形が違う、知らない力、番号が 1〜3 でなければ null。</summary>
    public static ActionRef? Parse(string? text)
    {
        var dot = text?.IndexOf('.') ?? -1;
        if (text is null || dot <= 0)
        {
            return null;
        }

        return TryParseAbility(text[..dot], out var ability)
            && int.TryParse(text.AsSpan(dot + 1), NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            && number is >= 1 and <= ActionsPerAbility
                ? new ActionRef(ability, number)
                : null;
    }

    public override string ToString() => $"{Key(Ability)}.{Number}";
}
