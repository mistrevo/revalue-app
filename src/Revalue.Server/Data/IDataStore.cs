namespace Revalue.Server.Data;

/// <summary>
/// データの保存先。本番は Cosmos DB、手元とテストはインメモリ。
/// 利用者のアイテムには 30 日の TTL が付き、書き直すとそこから数え直す。
/// </summary>
public interface IDataStore
{
    Task<T?> GetAsync<T>(string userKey, string id, CancellationToken ct) where T : Item;

    /// <summary>保存する。利用者のパーティションでは、Ttl が null なら 30 日にする。</summary>
    Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item;

    Task<IReadOnlyList<T>> ListByTypeAsync<T>(string userKey, string type, CancellationToken ct) where T : Item;

    /// <summary>その人のアイテムの数。テストと確認用。</summary>
    Task<int> CountAllAsync(string userKey, CancellationToken ct);

    /// <summary>その人のアイテムをすべて消す。global は消せない。</summary>
    Task DeleteAllAsync(string userKey, CancellationToken ct);

    /// <summary>その人のアイテムをすべて書き直し、TTL を数え直す。</summary>
    Task TouchAllAsync(string userKey, CancellationToken ct);

    /// <summary>数のアイテム（count）を 1 増やして新しい値を返す。なければ 1 で作る。</summary>
    Task<long> IncrementAsync(string userKey, string id, string type, int? ttl, CancellationToken ct);

    /// <summary>保存した生の JSON を全部返す。インメモリだけ（テスト用）。</summary>
    IAsyncEnumerable<string> DumpRawJsonAsync(CancellationToken ct);
}
