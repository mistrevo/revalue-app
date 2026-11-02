using System.Text.Json.Serialization;

namespace Revalue.Server.Data;

/// <summary>
/// 列挙を、名前（<see cref="JsonStringEnumMemberNameAttribute"/> の言葉）だけで読み書きする。
/// <see cref="JsonStringEnumConverter{TEnum}"/> は既定で数の値（<c>9</c> や <c>"9"</c>）も受け取り、定義にない値をそのまま通すので、
/// 利用者が選んだ値を受け取る列挙にはこちらを付ける。
/// </summary>
public sealed class NamedEnumConverter<TEnum>() : JsonStringEnumConverter<TEnum>(namingPolicy: null, allowIntegerValues: false)
    where TEnum : struct, Enum;
