using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;

namespace Revalue.Server.Tests;

/// <summary>
/// 決めた書き込みの直前に、一度だけ「全部消す」を割り込ませる保存先。
/// 要求が重なったときの順番を、毎回同じに起こして確かめるために使う。
/// </summary>
public sealed class InterruptingDataStore(IDataStore inner) : IDataStore
{
    private string? _deleteAllBefore;

    /// <summary>テスト用の保存先に差し替える。</summary>
    public static void Install(IServiceCollection services) =>
        services.AddSingleton<IDataStore>(sp => new InterruptingDataStore(new InMemoryDataStore(sp.GetRequiredService<TimeProvider>())));

    /// <summary>次に operation（メソッド名）で利用者のパーティションに書くとき、その直前に一度だけ、その人のデータを全部消す。</summary>
    public void DeleteAllOnceBefore(string operation) => Volatile.Write(ref _deleteAllBefore, operation);

    public Task<T?> GetAsync<T>(string userKey, string id, CancellationToken ct) where T : Item => inner.GetAsync<T>(userKey, id, ct);

    public async Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item
    {
        await InterruptAsync(nameof(UpsertAsync), item.UserKey, ct);
        await inner.UpsertAsync(item, ct);
    }

    public Task<IReadOnlyList<T>> ListByTypeAsync<T>(string userKey, string type, CancellationToken ct) where T : Item =>
        inner.ListByTypeAsync<T>(userKey, type, ct);

    public Task<int> CountAllAsync(string userKey, CancellationToken ct) => inner.CountAllAsync(userKey, ct);

    public Task DeleteAllAsync(string userKey, CancellationToken ct) => inner.DeleteAllAsync(userKey, ct);

    public Task DeleteLeftoversAsync(string userKey, CancellationToken ct) => inner.DeleteLeftoversAsync(userKey, ct);

    public async Task TouchAllAsync(string userKey, CancellationToken ct)
    {
        await InterruptAsync(nameof(TouchAllAsync), userKey, ct);
        await inner.TouchAllAsync(userKey, ct);
    }

    public async Task<long> IncrementAsync(string userKey, string id, string type, int? ttl, CancellationToken ct)
    {
        await InterruptAsync(nameof(IncrementAsync), userKey, ct);
        return await inner.IncrementAsync(userKey, id, type, ttl, ct);
    }

    public async Task<long> IncrementDailyAsync(string userKey, string id, string type, string date, int? ttl, CancellationToken ct)
    {
        await InterruptAsync(nameof(IncrementDailyAsync), userKey, ct);
        return await inner.IncrementDailyAsync(userKey, id, type, date, ttl, ct);
    }

    public IAsyncEnumerable<string> DumpRawJsonAsync(CancellationToken ct) => inner.DumpRawJsonAsync(ct);

    private async Task InterruptAsync(string operation, string userKey, CancellationToken ct)
    {
        if (userKey != DataConstants.GlobalPartition
            && Interlocked.CompareExchange(ref _deleteAllBefore, null, operation) == operation)
        {
            await inner.DeleteAllAsync(userKey, ct);
        }
    }
}
