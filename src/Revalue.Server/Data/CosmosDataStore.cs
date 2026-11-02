using System.Net;
using System.Text;
using System.Text.Json;
using Microsoft.Azure.Cosmos;

namespace Revalue.Server.Data;

/// <summary>
/// Cosmos DB for NoSQL の保存先。コンテナ 1 つ、パーティションキーは /userKey。
/// アイテムの JSON は自分で作り（camelCase、利用者のアイテムには ttl）、ストリームの API で送る。
/// </summary>
public sealed class CosmosDataStore(Container container) : IDataStore
{
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

    public async Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item
    {
        using var body = ToStream(Serialize(item));
        using var response = await container.UpsertItemStreamAsync(body, new PartitionKey(item.UserKey), cancellationToken: ct);
        response.EnsureSuccessStatusCode();
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

    public async Task DeleteAllAsync(string userKey, CancellationToken ct)
    {
        InMemoryDataStore.EnsureNotGlobal(userKey);
        // 「パーティションキーで全部消す」はプレビューで、アカウントの設定が要るので使わない（Claude の判断）。
        // その人のアイテムは多くないので、id を集めて 1 件ずつ消す。
        var ids = new List<string>();
        await foreach (var document in QueryAsync(userKey, new QueryDefinition("SELECT VALUE c.id FROM c"), ct))
        {
            ids.Add(document.GetString()!);
        }

        var partitionKey = new PartitionKey(userKey);
        foreach (var id in ids)
        {
            using var response = await container.DeleteItemStreamAsync(id, partitionKey, cancellationToken: ct);
            if (response.StatusCode != HttpStatusCode.NotFound)
            {
                response.EnsureSuccessStatusCode();
            }
        }
    }

    public async Task TouchAllAsync(string userKey, CancellationToken ct)
    {
        // 書き直すと最終更新時刻（_ts）が新しくなり、TTL がそこから数え直しになる
        var partitionKey = new PartitionKey(userKey);
        await foreach (var document in QueryAsync(userKey, new QueryDefinition("SELECT * FROM c"), ct))
        {
            using var body = ToStream(document.GetRawText());
            using var response = await container.UpsertItemStreamAsync(body, partitionKey, cancellationToken: ct);
            response.EnsureSuccessStatusCode();
        }
    }

    public async Task<long> IncrementAsync(string userKey, string id, string type, int? ttl, CancellationToken ct)
    {
        var partitionKey = new PartitionKey(userKey);
        for (var attempt = 0; attempt < 3; attempt++)
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

    public IAsyncEnumerable<string> DumpRawJsonAsync(CancellationToken ct) =>
        throw new NotSupportedException("DumpRawJsonAsync is only for the in-memory store.");

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
}
