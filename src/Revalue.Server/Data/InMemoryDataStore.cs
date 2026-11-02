using System.Runtime.CompilerServices;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Revalue.Server.Data;

/// <summary>
/// メモリの中だけに置く保存先。止めると消える。TimeProvider で Cosmos DB の TTL を再現する
/// （書いた時刻から ttl 秒たったアイテムは見えなくなる）。
/// </summary>
public sealed class InMemoryDataStore(TimeProvider time) : IDataStore
{
    private readonly record struct Entry(string Json, string Type, int? Ttl, DateTimeOffset WrittenAt);

    private readonly Dictionary<(string UserKey, string Id), Entry> _items = new();
    private readonly Lock _gate = new();

    public Task<T?> GetAsync<T>(string userKey, string id, CancellationToken ct) where T : Item
    {
        lock (_gate)
        {
            var result = TryGetLive(userKey, id, out var entry) ? Deserialize<T>(entry.Json) : null;
            return Task.FromResult(result);
        }
    }

    public Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item
    {
        var stored = DataConstants.WithDefaultTtl(item);
        var json = JsonSerializer.Serialize(stored, stored.GetType(), DataConstants.Json);
        lock (_gate)
        {
            _items[(stored.UserKey, stored.Id)] = new Entry(json, stored.Type, stored.Ttl, time.GetUtcNow());
        }

        return Task.CompletedTask;
    }

    public Task<IReadOnlyList<T>> ListByTypeAsync<T>(string userKey, string type, CancellationToken ct) where T : Item
    {
        lock (_gate)
        {
            IReadOnlyList<T> result = LiveEntries(userKey)
                .Where(e => e.Value.Type == type)
                .Select(e => Deserialize<T>(e.Value.Json)!)
                .ToList();
            return Task.FromResult(result);
        }
    }

    public Task<int> CountAllAsync(string userKey, CancellationToken ct)
    {
        lock (_gate)
        {
            return Task.FromResult(LiveEntries(userKey).Count());
        }
    }

    public Task DeleteAllAsync(string userKey, CancellationToken ct)
    {
        EnsureNotGlobal(userKey);
        lock (_gate)
        {
            foreach (var key in _items.Keys.Where(k => k.UserKey == userKey).ToList())
            {
                _items.Remove(key);
            }
        }

        return Task.CompletedTask;
    }

    public Task TouchAllAsync(string userKey, CancellationToken ct)
    {
        lock (_gate)
        {
            var now = time.GetUtcNow();
            foreach (var (key, entry) in LiveEntries(userKey).ToList())
            {
                _items[key] = entry with { WrittenAt = now };
            }
        }

        return Task.CompletedTask;
    }

    public Task<long> IncrementAsync(string userKey, string id, string type, int? ttl, CancellationToken ct)
    {
        lock (_gate)
        {
            var now = time.GetUtcNow();
            if (TryGetLive(userKey, id, out var entry))
            {
                // Cosmos DB の部分更新と同じく、ほかの値はそのまま count だけ増やし、書いた時刻を新しくする
                var node = JsonNode.Parse(entry.Json)!.AsObject();
                var count = node["count"]!.GetValue<long>() + 1;
                node["count"] = count;
                _items[(userKey, id)] = entry with { Json = node.ToJsonString(DataConstants.Json), WrittenAt = now };
                return Task.FromResult(count);
            }

            var created = (CountItem)DataConstants.WithDefaultTtl(
                new CountItem { Id = id, UserKey = userKey, Type = type, Ttl = ttl, Count = 1 });
            _items[(userKey, id)] = new Entry(
                JsonSerializer.Serialize(created, DataConstants.Json), type, created.Ttl, now);
            return Task.FromResult(1L);
        }
    }

    public async IAsyncEnumerable<string> DumpRawJsonAsync([EnumeratorCancellation] CancellationToken ct)
    {
        List<string> all;
        lock (_gate)
        {
            all = _items.Values.Select(e => e.Json).ToList();
        }

        foreach (var json in all)
        {
            await Task.Yield();
            yield return json;
        }
    }

    internal static void EnsureNotGlobal(string userKey)
    {
        if (userKey == DataConstants.GlobalPartition)
        {
            throw new ArgumentException("The global partition cannot be deleted.", nameof(userKey));
        }
    }

    private bool IsLive(Entry entry) =>
        entry.Ttl is not { } ttl || time.GetUtcNow() < entry.WrittenAt.AddSeconds(ttl);

    private bool TryGetLive(string userKey, string id, out Entry entry) =>
        _items.TryGetValue((userKey, id), out entry) && IsLive(entry);

    private IEnumerable<KeyValuePair<(string UserKey, string Id), Entry>> LiveEntries(string userKey) =>
        _items.Where(e => e.Key.UserKey == userKey && IsLive(e.Value));

    private static T? Deserialize<T>(string json) where T : Item => JsonSerializer.Deserialize<T>(json, DataConstants.Json);
}
