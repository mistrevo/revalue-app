using System.Globalization;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Revalue.Server.Features.Validate;

/// <summary>
/// 見る力。能力辞書（<see cref="AbilityCatalog"/>。<c>src/shared/abilities.json</c>）の力の id で表す。JSON では id の文字列。
/// 並びは辞書の順（表示と、同じ数のときの選び方に使う）。辞書にない id（古いデータなど）も値としては持てるが、
/// 判定に使う力（<see cref="AbilityCatalog.Active"/>）にないので、どこでも数えない。
/// </summary>
[JsonConverter(typeof(AbilityJsonConverter))]
public readonly record struct Ability(string Id) : IComparable<Ability>
{
    // 移る間だけ残す決め打ちの力。辞書の力に置き換えるときに消す
    /// <summary>見立てる力。</summary>
    public static readonly Ability Noticing = new("noticing");

    /// <summary>調整する力。</summary>
    public static readonly Ability Coordinating = new("coordinating");

    /// <summary>優先順位をつける力。</summary>
    public static readonly Ability Prioritizing = new("prioritizing");

    public int CompareTo(Ability other)
    {
        var byOrder = AbilityCatalog.Current.OrderOf(this).CompareTo(AbilityCatalog.Current.OrderOf(other));
        return byOrder != 0 ? byOrder : string.CompareOrdinal(Id, other.Id);
    }

    public override string ToString() => Id;
}

/// <summary>力を id の文字列で読み書きする。空でない文字列ならどの id も読む（辞書にあるかは使うところで確かめる）。辞書のキーにも使える。</summary>
public sealed class AbilityJsonConverter : JsonConverter<Ability>
{
    public override Ability Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        reader.TokenType == JsonTokenType.String ? FromName(reader.GetString()) : throw new JsonException("An ability must be a string.");

    public override void Write(Utf8JsonWriter writer, Ability value, JsonSerializerOptions options) => writer.WriteStringValue(NameOf(value));

    public override Ability ReadAsPropertyName(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options) =>
        FromName(reader.GetString());

    public override void WriteAsPropertyName(Utf8JsonWriter writer, Ability value, JsonSerializerOptions options) =>
        writer.WritePropertyName(NameOf(value));

    private static Ability FromName(string? name) =>
        string.IsNullOrEmpty(name) ? throw new JsonException("An ability must not be empty.") : new Ability(name);

    private static string NameOf(Ability value) =>
        string.IsNullOrEmpty(value.Id) ? throw new JsonException("An ability must not be empty.") : value.Id;
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

/// <summary>核となる行動の一つ。<see cref="Number"/> は 1 から、その力の行動の数まで。文字にすると <c>coordinating.3</c> の形。</summary>
public sealed record ActionRef(Ability Ability, int Number)
{
    public static string Key(Ability ability) => ability.Id;

    /// <summary>
    /// <c>noticing</c> などの id を、判定に使う力にする。辞書にない id と準備中の力は false。大文字と小文字は区別する。
    /// AI の答えや送られた値の力の id は、ここで確かめる。
    /// </summary>
    public static bool TryParseAbility(string? key, out Ability ability)
    {
        if (AbilityCatalog.Find(key) is { IsActive: true } entry)
        {
            ability = entry.Ability;
            return true;
        }

        ability = default;
        return false;
    }

    /// <summary><c>coordinating.3</c> の形を読む。形が違う、判定に使う力でない、番号が 1〜行動の数でなければ null。</summary>
    public static ActionRef? Parse(string? text)
    {
        var dot = text?.IndexOf('.') ?? -1;
        if (text is null || dot <= 0)
        {
            return null;
        }

        return TryParseAbility(text[..dot], out var ability)
            && int.TryParse(text.AsSpan(dot + 1), NumberStyles.None, CultureInfo.InvariantCulture, out var number)
            && number >= 1 && number <= AbilityCatalog.ActionCount(ability)
                ? new ActionRef(ability, number)
                : null;
    }

    public override string ToString() => $"{Key(Ability)}.{Number}";
}
