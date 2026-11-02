using System.Collections.Frozen;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Revalue.Server.Data;

/// <summary>
/// 列挙を、名前（<see cref="JsonStringEnumMemberNameAttribute"/> の言葉）だけで読み書きする。
/// 名前と値の固定の対応表と完全に一致する文字列だけを読み、それ以外（数の値、数を書いた文字列、前後の空白、大文字小文字の違い、
/// カンマでつないだ名前、null）は <see cref="JsonException"/> で断る。利用者が選んだ値を受け取る列挙にはこちらを付ける。
/// <see cref="JsonStringEnumConverter{TEnum}"/> は、カンマでつないだ名前を値のビット和として読み（"daytime, evening" → night）、
/// 前後の空白も落として読むので、本人が選んでいない値が定義のある値に化けて通ってしまう。そのため使わない。
/// </summary>
public sealed class NamedEnumConverter<TEnum> : JsonConverter<TEnum>
    where TEnum : struct, Enum
{
    /// <summary>名前と値の対応表。列挙のどの値にも <see cref="JsonStringEnumMemberNameAttribute"/> が要る。</summary>
    private static readonly (string Name, TEnum Value)[] Names =
    [
        .. typeof(TEnum).GetFields(BindingFlags.Public | BindingFlags.Static).Select(field => (
            field.GetCustomAttribute<JsonStringEnumMemberNameAttribute>()?.Name
                ?? throw new InvalidOperationException($"{typeof(TEnum).Name}.{field.Name} needs [JsonStringEnumMemberName]."),
            (TEnum)field.GetValue(null)!)),
    ];

    private static readonly FrozenDictionary<string, TEnum> ByName = Names.ToFrozenDictionary(p => p.Name, p => p.Value, StringComparer.Ordinal);

    private static readonly FrozenDictionary<TEnum, string> ByValue = Names.ToFrozenDictionary(p => p.Value, p => p.Name);

    public override TEnum Read(ref Utf8JsonReader reader, Type typeToConvert, JsonSerializerOptions options)
    {
        // 送られた値そのものは例外の文に入れない（ログに書いた内容を出さない）
        if (reader.TokenType == JsonTokenType.String && reader.GetString() is { } name && ByName.TryGetValue(name, out var value))
        {
            return value;
        }

        throw new JsonException($"The value is not one of the names of {typeof(TEnum).Name}.");
    }

    public override void Write(Utf8JsonWriter writer, TEnum value, JsonSerializerOptions options)
    {
        if (!ByValue.TryGetValue(value, out var name))
        {
            throw new JsonException($"The value is not one of the names of {typeof(TEnum).Name}.");
        }

        writer.WriteStringValue(name);
    }
}
