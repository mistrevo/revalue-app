using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Azure.Cosmos;

namespace Revalue.Server.Data;

/// <summary>
/// Cosmos DB for NoSQL の保存先。コンテナ 1 つ、パーティションキーは /userKey。
/// アイテムの JSON は自分で作り（camelCase、利用者のアイテムには ttl）、ストリームの API で送る。
/// 利用者のパーティションに書くときは、了解の記録を読む操作を同じトランザクション（TransactionalBatch）に入れる。
/// 了解の記録がなければトランザクション全体が失敗し、何も書かない。
/// </summary>
public sealed class CosmosDataStore(Container container) : IDataStore
{
    /// <summary>ほかの要求が先に書いて条件が外れたときに、読み直してやり直す回数。</summary>
    private const int MaxAttempts = 5;

    /// <summary>Cosmos DB に送る JSON を作る。利用者のアイテムには ttl を付ける。</summary>
    internal static string Serialize<T>(T item) where T : Item => DataConstants.Serialize(item);

    public async Task<T?> GetAsync<T>(string userKey, string id, CancellationToken ct) where T : Item
    {
        using var response = await container.ReadItemStreamAsync(id, new PartitionKey(userKey), cancellationToken: ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        return await JsonSerializer.DeserializeAsync<T>(response.Content, DataConstants.Json, ct);
    }

    public async Task<Versioned<T>?> GetVersionedAsync<T>(string userKey, string id, CancellationToken ct) where T : Item
    {
        using var response = await container.ReadItemStreamAsync(id, new PartitionKey(userKey), cancellationToken: ct);
        if (response.StatusCode == HttpStatusCode.NotFound)
        {
            return null;
        }

        response.EnsureSuccessStatusCode();
        var item = await JsonSerializer.DeserializeAsync<T>(response.Content, DataConstants.Json, ct);
        return item is null ? null : new Versioned<T>(item, response.Headers.ETag);
    }

    public async Task<bool> TryReplaceAsync<T>(T item, string etag, CancellationToken ct) where T : Item
    {
        // 置き換え（Replace）は、ないアイテムを作らない。IfMatchEtag で、読んだときから変わっていないときだけ書く
        using var body = ToStream(Serialize(item));
        var result = await WriteAsync(item.UserKey, item.Id, batch =>
            batch.ReplaceItemStream(item.Id, body, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag }), ct);
        if (result.Status is HttpStatusCode.NotFound or HttpStatusCode.PreconditionFailed)
        {
            // 消えたか、ほかの要求が先に書いた
            return false;
        }

        result.EnsureSucceeded();
        return true;
    }

    public async Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item
    {
        using var body = ToStream(Serialize(item));
        var result = await WriteAsync(item.UserKey, item.Id, batch => batch.UpsertItemStream(body), ct);
        result.EnsureSucceeded();
    }

    public async Task<bool> TryCreateAsync<T>(T item, CancellationToken ct) where T : Item
    {
        using var body = ToStream(Serialize(item));
        var result = await WriteAsync(item.UserKey, item.Id, batch => batch.CreateItemStream(body), ct);
        if (result.Status == HttpStatusCode.Conflict)
        {
            // もうある（ほかの要求が先に作った）
            return false;
        }

        result.EnsureSucceeded();
        return true;
    }

    public async Task<IReadOnlyList<T>> ListByTypeAsync<T>(string userKey, string type, CancellationToken ct) where T : Item
    {
        var query = new QueryDefinition("SELECT * FROM c WHERE c.type = @type").WithParameter("@type", type);
        var result = new List<T>();
        await foreach (var document in QueryAsync(userKey, query, ct))
        {
            result.Add(document.Deserialize<T>(DataConstants.Json)!);
        }

        return result;
    }

    public async Task<int> CountAllAsync(string userKey, CancellationToken ct)
    {
        var count = 0;
        await foreach (var document in QueryAsync(userKey, new QueryDefinition("SELECT VALUE COUNT(1) FROM c"), ct))
        {
            count += document.GetInt32();
        }

        return count;
    }

    public async Task DeleteAsync(string userKey, string id, CancellationToken ct)
    {
        InMemoryDataStore.EnsureNotGlobal(userKey);
        await DeleteIgnoringMissingAsync(id, new PartitionKey(userKey), null, ct);
    }

    public async Task DeleteAllAsync(string userKey, CancellationToken ct)
    {
        InMemoryDataStore.EnsureNotGlobal(userKey);
        var partitionKey = new PartitionKey(userKey);

        // 了解の記録を最初に消す。これで、この人のパーティションへの書き込みはすべて断られるので、
        // このあと集める id のほかに、新しいアイテムは増えない
        await DeleteIgnoringMissingAsync(DataConstants.ConsentId, partitionKey, null, ct);

        // 「パーティションキーで全部消す」はプレビューで、アカウントの設定が要るので使わない（Claude の判断）。
        // その人のアイテムは多くないので、id を集めて 1 件ずつ消す。
        var ids = new List<string>();
        await foreach (var document in QueryAsync(userKey, new QueryDefinition("SELECT VALUE c.id FROM c"), ct))
        {
            ids.Add(document.GetString()!);
        }

        foreach (var id in ids)
        {
            await DeleteIgnoringMissingAsync(id, partitionKey, null, ct);
        }
    }

    public async Task DeleteLeftoversAsync(string userKey, CancellationToken ct)
    {
        InMemoryDataStore.EnsureNotGlobal(userKey);
        var partitionKey = new PartitionKey(userKey);
        using (var consent = await container.ReadItemStreamAsync(DataConstants.ConsentId, partitionKey, cancellationToken: ct))
        {
            if (consent.IsSuccessStatusCode)
            {
                return;
            }

            if (consent.StatusCode != HttpStatusCode.NotFound)
            {
                consent.EnsureSuccessStatusCode();
            }
        }

        var leftovers = new List<(string Id, string Etag)>();
        await foreach (var document in QueryAsync(userKey, new QueryDefinition("SELECT c.id, c._etag FROM c"), ct))
        {
            var id = document.GetProperty("id").GetString()!;
            if (id == DataConstants.ConsentId)
            {
                // たったいま了解し直した。もう残りではない
                return;
            }

            leftovers.Add((id, document.GetProperty("_etag").GetString()!));
        }

        // 読んだときのまま（_etag が同じ）のものだけを消す。了解し直したあとに書かれたものは消さない
        foreach (var (id, etag) in leftovers)
        {
            await DeleteIgnoringMissingAsync(id, partitionKey, etag, ct);
        }
    }

    public async Task TouchAllAsync(string userKey, CancellationToken ct)
    {
        var documents = new List<JsonElement>();
        await foreach (var document in QueryAsync(userKey, new QueryDefinition("SELECT * FROM c"), ct))
        {
            documents.Add(document);
        }

        // 書き直すと最終更新時刻（_ts）が新しくなり、TTL がそこから数え直しになる。
        // 読んだときのまま（_etag が同じ）のものだけを置き換える。置き換えは、ないアイテムを作らないので、
        // 全部消すのと重なっても作り直さない。あとから書かれた新しい中身を、古い中身で上書きもしない
        var partitionKey = new PartitionKey(userKey);
        foreach (var document in documents)
        {
            var options = new ItemRequestOptions { IfMatchEtag = document.GetProperty("_etag").GetString() };
            using var body = ToStream(document.GetRawText());
            using var response = await container.ReplaceItemStreamAsync(
                body, document.GetProperty("id").GetString()!, partitionKey, options, ct);
            if (response.StatusCode is HttpStatusCode.NotFound or HttpStatusCode.PreconditionFailed)
            {
                // 消えたか、ほかの要求が先に書き直した（TTL はもう数え直されている）
                continue;
            }

            response.EnsureSuccessStatusCode();
        }
    }

    public async Task<long> IncrementAsync(string userKey, string id, string type, int? ttl, CancellationToken ct)
    {
        if (userKey != DataConstants.GlobalPartition)
        {
            // 利用者のパーティションは、了解の記録を確かめながら書く
            var counted = await UpdateAsync<CountItem>(
                userKey, id, current => new CountItem { Id = id, UserKey = userKey, Type = type, Ttl = ttl, Count = (current?.Count ?? 0) + 1 }, ct);
            return counted.Count;
        }

        // global は、部分更新（Patch）の Increment で一度に増やす。混み合っても読み直さずに済む
        var partitionKey = new PartitionKey(userKey);
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            using (var patched = await container.PatchItemStreamAsync(
                       id, partitionKey, [PatchOperation.Increment("/count", 1)], cancellationToken: ct))
            {
                if (patched.IsSuccessStatusCode)
                {
                    return await ReadCountAsync(patched, ct);
                }

                if (patched.StatusCode != HttpStatusCode.NotFound)
                {
                    patched.EnsureSuccessStatusCode();
                }
            }

            var item = new CountItem { Id = id, UserKey = userKey, Type = type, Ttl = ttl, Count = 1 };
            using var body = ToStream(Serialize(item));
            using var created = await container.CreateItemStreamAsync(body, partitionKey, cancellationToken: ct);
            if (created.IsSuccessStatusCode)
            {
                return 1;
            }

            // 同時に作られたときは、もう一度増やす
            if (created.StatusCode != HttpStatusCode.Conflict)
            {
                created.EnsureSuccessStatusCode();
            }
        }

        throw new InvalidOperationException("Could not increment the count.");
    }

    public async Task<long> IncrementDailyAsync(string userKey, string id, string type, string date, int? ttl, CancellationToken ct)
    {
        var counted = await UpdateAsync<DailyCountItem>(userKey, id, current => new DailyCountItem
        {
            Id = id,
            UserKey = userKey,
            Type = type,
            Ttl = ttl,
            Date = date,
            Count = current?.Date == date ? current.Count + 1 : 1,
        }, ct);
        return counted.Count;
    }

    public IAsyncEnumerable<string> DumpRawJsonAsync(CancellationToken ct) =>
        throw new NotSupportedException("DumpRawJsonAsync is only for the in-memory store.");

    /// <summary>
    /// 1 件を読み、新しい中身を作って書く。読んだときから変わっていたら（ほかの要求が先に作った、書き換えた、消した）、
    /// 読み直してやり直す。だから、同時に来た要求が同じ値を読んで同じ値を書くことはない。
    /// </summary>
    private async Task<T> UpdateAsync<T>(string userKey, string id, Func<T?, T> change, CancellationToken ct) where T : Item
    {
        var partitionKey = new PartitionKey(userKey);
        for (var attempt = 0; attempt < MaxAttempts; attempt++)
        {
            T? current = null;
            string? etag = null;
            using (var read = await container.ReadItemStreamAsync(id, partitionKey, cancellationToken: ct))
            {
                if (read.IsSuccessStatusCode)
                {
                    etag = read.Headers.ETag;
                    current = await JsonSerializer.DeserializeAsync<T>(read.Content, DataConstants.Json, ct);
                }
                else if (read.StatusCode != HttpStatusCode.NotFound)
                {
                    read.EnsureSuccessStatusCode();
                }
            }

            var next = change(current);
            using var body = ToStream(Serialize(next));
            var result = await WriteAsync(userKey, id, batch =>
            {
                if (etag is null)
                {
                    batch.CreateItemStream(body);
                }
                else
                {
                    batch.ReplaceItemStream(id, body, new TransactionalBatchItemRequestOptions { IfMatchEtag = etag });
                }
            }, ct);
            if (result.Succeeded)
            {
                return next;
            }

            if (result.Status is not (HttpStatusCode.Conflict or HttpStatusCode.PreconditionFailed or HttpStatusCode.NotFound))
            {
                result.EnsureSucceeded();
            }
        }

        throw new InvalidOperationException($"Could not update the item after {MaxAttempts} attempts.");
    }

    /// <summary>
    /// 1 件を書く操作をトランザクションで実行し、その操作の結果を返す。
    /// 利用者のパーティション（了解の記録そのものを除く）では、了解の記録を読む操作を先に入れる。
    /// トランザクションの中の操作が一つでも失敗すると、どれも書かれない。了解の記録がなければ
    /// <see cref="ConsentMissingException"/> を投げる。
    /// </summary>
    private async Task<WriteResult> WriteAsync(string userKey, string id, Action<TransactionalBatch> addWrite, CancellationToken ct)
    {
        var gated = DataConstants.RequiresConsent(userKey, id);
        var batch = container.CreateTransactionalBatch(new PartitionKey(userKey));
        if (gated)
        {
            batch.ReadItem(DataConstants.ConsentId);
        }

        addWrite(batch);
        using var response = await batch.ExecuteAsync(ct);
        var writeIndex = gated ? 1 : 0;
        if (response.Count <= writeIndex)
        {
            // 操作ごとの結果がない失敗（混み合い、サービスのエラーなど）
            throw new InvalidOperationException($"Cosmos DB transactional batch failed with status {(int)response.StatusCode}.");
        }

        if (gated && response[0].StatusCode == HttpStatusCode.NotFound)
        {
            throw new ConsentMissingException();
        }

        return new WriteResult(response[writeIndex].StatusCode);
    }

    private async Task DeleteIgnoringMissingAsync(string id, PartitionKey partitionKey, string? etag, CancellationToken ct)
    {
        var options = etag is null ? null : new ItemRequestOptions { IfMatchEtag = etag };
        using var response = await container.DeleteItemStreamAsync(id, partitionKey, options, ct);
        if (response.StatusCode is HttpStatusCode.NotFound || (etag is not null && response.StatusCode is HttpStatusCode.PreconditionFailed))
        {
            return;
        }

        response.EnsureSuccessStatusCode();
    }

    private async IAsyncEnumerable<JsonElement> QueryAsync(
        string userKey,
        QueryDefinition query,
        [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken ct)
    {
        var options = new QueryRequestOptions { PartitionKey = new PartitionKey(userKey) };
        using var iterator = container.GetItemQueryStreamIterator(query, requestOptions: options);
        while (iterator.HasMoreResults)
        {
            using var response = await iterator.ReadNextAsync(ct);
            response.EnsureSuccessStatusCode();
            using var page = await JsonDocument.ParseAsync(response.Content, cancellationToken: ct);
            foreach (var document in page.RootElement.GetProperty("Documents").EnumerateArray())
            {
                yield return document.Clone();
            }
        }
    }

    private static async Task<long> ReadCountAsync(ResponseMessage response, CancellationToken ct)
    {
        using var document = await JsonDocument.ParseAsync(response.Content, cancellationToken: ct);
        return document.RootElement.GetProperty("count").GetInt64();
    }

    private static MemoryStream ToStream(string json) => new(Encoding.UTF8.GetBytes(json));

    private readonly record struct WriteResult(HttpStatusCode Status)
    {
        public bool Succeeded => (int)Status is >= 200 and < 300;

        public void EnsureSucceeded()
        {
            if (!Succeeded)
            {
                throw new InvalidOperationException($"Cosmos DB write failed with status {(int)Status}.");
            }
        }
    }
}
