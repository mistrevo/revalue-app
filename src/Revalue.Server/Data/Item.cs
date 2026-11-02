using System.Text.Json;
using System.Text.Json.Serialization;

namespace Revalue.Server.Data;

/// <summary>
/// 保存する 1 件ずつのデータ（アイテム）の基底。利用者キーで分けて置き、種類は Type で分ける。
/// </summary>
public abstract record Item
{
    public required string Id { get; init; }

    /// <summary>利用者キー。人と結びつかない数などは <see cref="DataConstants.GlobalPartition"/>。</summary>
    public required string UserKey { get; init; }

    public required string Type { get; init; }

    /// <summary>自動で消えるまでの秒数。null なら、利用者のアイテムは保存するときに 30 日になる。</summary>
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public int? Ttl { get; init; }
}

/// <summary>数のアイテム。<see cref="IDataStore.IncrementAsync"/> が増やす。</summary>
public sealed record CountItem : Item
{
    public long Count { get; init; }
}

/// <summary>
/// その日の数のアイテム。<see cref="IDataStore.IncrementDailyAsync"/> が増やし、日が変わったら 1 から数え直す。
/// id は日付を含まない 1 件なので、前の日の数は残らない。
/// </summary>
public sealed record DailyCountItem : Item
{
    /// <summary>数えている日（日本時間、yyyy-MM-dd）。</summary>
    public required string Date { get; init; }

    public long Count { get; init; }
}

/// <summary>
/// 了解の記録がないので、その人のパーティションに書かなかった。
/// 全部消したあとに遅れて届いた書き込みや、了解の記録が先に消えたあとの書き込みで起きる。
/// </summary>
public sealed class ConsentMissingException()
    : InvalidOperationException("The user's partition has no consent record, so nothing was written.");

public static class DataConstants
{
    /// <summary>利用者のアイテムが自動で消えるまでの秒数（30 日）。</summary>
    public const int UserTtlSeconds = 2592000;

    /// <summary>利用者キーと重ならない、人と結びつかない数とアプリ全体の数を置くパーティション。</summary>
    public const string GlobalPartition = "global";

    /// <summary>
    /// 了解の記録の id。その人のパーティションの入口で、これがある間だけ、ほかのアイテムを書ける。
    /// 全部消すときは、これを最初に消す。
    /// </summary>
    public const string ConsentId = "consent";

    /// <summary>書くのに了解の記録が要るか。利用者のパーティションの、了解の記録以外のアイテムが当たる。</summary>
    public static bool RequiresConsent(string userKey, string id) => userKey != GlobalPartition && id != ConsentId;

    /// <summary>保存する JSON の形（camelCase）。インメモリと Cosmos DB で同じものを使う。</summary>
    public static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>利用者のアイテムで TTL がなければ 30 日にする。global のアイテムは渡したまま。</summary>
    public static Item WithDefaultTtl(Item item) =>
        item.UserKey != GlobalPartition && item.Ttl is null ? item with { Ttl = UserTtlSeconds } : item;

    public static string Serialize(Item item) =>
        JsonSerializer.Serialize(WithDefaultTtl(item), item.GetType(), Json);
}
