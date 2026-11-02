namespace Revalue.Server.Data;

/// <summary>
/// データの保存先。本番は Cosmos DB、手元とテストはインメモリ。
/// 利用者のアイテムには 30 日の TTL が付き、書き直すとそこから数え直す。
/// 利用者のパーティションに書けるのは、了解の記録（id <see cref="DataConstants.ConsentId"/>）があるときだけ。
/// 了解の記録そのものと global は除く。了解の記録がなければ何も書かずに <see cref="ConsentMissingException"/> を投げる。
/// 全部消したあとに遅れて届いた書き込みで、データを作り直さないため。
/// </summary>
public interface IDataStore
{
    Task<T?> GetAsync<T>(string userKey, string id, CancellationToken ct) where T : Item;

    /// <summary>
    /// 読んだときの版（ETag）と一緒に読む。なければ null。版は <see cref="TryReplaceAsync"/> に渡し、
    /// 読んでから変わっていないときだけ書くために使う。中身を変えない書き直し（<see cref="TouchAllAsync"/>）でも版は変わる。
    /// </summary>
    Task<Versioned<T>?> GetVersionedAsync<T>(string userKey, string id, CancellationToken ct) where T : Item;

    /// <summary>
    /// 版が etag のままのときだけ置き換えて true を返す。消えていた、ほかの要求が先に書いた、のどちらでも、何もせず false を返す。
    /// ないアイテムは作らない（消したものを作り直さない）。確かめて書くまでを一続きで行う。
    /// </summary>
    Task<bool> TryReplaceAsync<T>(T item, string etag, CancellationToken ct) where T : Item;

    /// <summary>保存する。利用者のパーティションでは、Ttl が null なら 30 日にする。</summary>
    Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item;

    /// <summary>
    /// まだなければ作って true を返す。もうあれば何もせず false を返す。確かめて作るまでを一続きで行うので、
    /// 同時に呼ばれても true になるのは 1 回だけ。
    /// </summary>
    Task<bool> TryCreateAsync<T>(T item, CancellationToken ct) where T : Item;

    Task<IReadOnlyList<T>> ListByTypeAsync<T>(string userKey, string type, CancellationToken ct) where T : Item;

    /// <summary>その人のアイテムの数。テストと確認用。</summary>
    Task<int> CountAllAsync(string userKey, CancellationToken ct);

    /// <summary>その人のアイテムを 1 件消す。なければ何もしない。global は消せない。</summary>
    Task DeleteAsync(string userKey, string id, CancellationToken ct);

    /// <summary>その人のアイテムをすべて消す。了解の記録を最初に消し、そのあとの書き込みを止めてから残りを消す。global は消せない。</summary>
    Task DeleteAllAsync(string userKey, CancellationToken ct);

    /// <summary>
    /// 了解の記録がない人のアイテムを消す。TTL は書いた時刻から数えるので、了解の記録が先に消えて、
    /// 同じ日のあとで書いたアイテムだけが残ることがある。了解の記録があれば何もしない。global は消せない。
    /// </summary>
    Task DeleteLeftoversAsync(string userKey, CancellationToken ct);

    /// <summary>その人のアイテムをすべて書き直し、TTL を数え直す。読んだあとに消えたアイテムは作り直さない。</summary>
    Task TouchAllAsync(string userKey, CancellationToken ct);

    /// <summary>数のアイテム（count）を 1 増やして新しい値を返す。なければ 1 で作る。読んで増やすまでを一続きで行う。</summary>
    Task<long> IncrementAsync(string userKey, string id, string type, int? ttl, CancellationToken ct);

    /// <summary>
    /// その日の数のアイテム（date と count）を 1 増やして新しい値を返す。
    /// なければ、または保存した日が date と違えば、1 から数え直す。読んで増やすまでを一続きで行う。
    /// </summary>
    Task<long> IncrementDailyAsync(string userKey, string id, string type, string date, int? ttl, CancellationToken ct);

    /// <summary>保存した生の JSON を全部返す。インメモリだけ（テスト用）。</summary>
    IAsyncEnumerable<string> DumpRawJsonAsync(CancellationToken ct);
}
