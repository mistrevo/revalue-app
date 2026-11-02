using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;

namespace Revalue.Server.Tests;

/// <summary>
/// 決めた書き込みの直前に、一度だけほかの操作（「全部消す」など）を割り込ませる保存先。
/// 要求が重なったときの順番を、毎回同じに起こして確かめるために使う。
/// </summary>
public sealed class InterruptingDataStore(IDataStore inner) : IDataStore
{
    private readonly Lock _gate = new();
    private string? _deleteAllBefore;
    private (Func<string, bool> Match, Func<IDataStore, Task> Action)? _beforeWriting;

    /// <summary>テスト用の保存先に差し替える。</summary>
    public static void Install(IServiceCollection services) =>
        services.AddSingleton<IDataStore>(sp => new InterruptingDataStore(new InMemoryDataStore(sp.GetRequiredService<TimeProvider>())));

    /// <summary>次に operation（メソッド名）で利用者のパーティションに書くとき、その直前に一度だけ、その人のデータを全部消す。</summary>
    public void DeleteAllOnceBefore(string operation) => Volatile.Write(ref _deleteAllBefore, operation);

    /// <summary>
    /// 次に id のアイテムを書くか消すとき（どの書き方でも）、その直前に一度だけ action を割り込ませる。
    /// action には中の保存先を渡すので、action の中の書き込みには割り込まない。
    /// </summary>
    public void RunOnceBeforeWriting(string id, Func<IDataStore, Task> action) => RunOnceBeforeWriting(i => i == id, action);

    /// <summary>次に id のアイテムを書くか消すとき、その直前に一度だけ、API などほかの要求を割り込ませる（中の保存先は渡さない）。</summary>
    public void RunOnceBeforeWriting(string id, Func<Task> action) => RunOnceBeforeWriting(id, _ => action());

    /// <summary>
    /// 次に match に合う id のアイテムを書くか消すとき、その直前に一度だけ、API などほかの要求を割り込ませる。
    /// まだ id の分からない、これから作るアイテムの直前に割り込ませるときに使う。
    /// </summary>
    public void RunOnceBeforeWriting(Func<string, bool> match, Func<Task> action) => RunOnceBeforeWriting(match, _ => action());

    private void RunOnceBeforeWriting(Func<string, bool> match, Func<IDataStore, Task> action)
    {
        lock (_gate)
        {
            _beforeWriting = (match, action);
        }
    }

    public Task<T?> GetAsync<T>(string userKey, string id, CancellationToken ct) where T : Item => inner.GetAsync<T>(userKey, id, ct);

    public Task<Versioned<T>?> GetVersionedAsync<T>(string userKey, string id, CancellationToken ct) where T : Item =>
        inner.GetVersionedAsync<T>(userKey, id, ct);

    public async Task<bool> TryReplaceAsync<T>(T item, string etag, CancellationToken ct) where T : Item
    {
        await InterruptAsync(nameof(TryReplaceAsync), item.UserKey, ct);
        await BeforeWritingAsync(item.Id);
        return await inner.TryReplaceAsync(item, etag, ct);
    }

    public async Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item
    {
        await InterruptAsync(nameof(UpsertAsync), item.UserKey, ct);
        await BeforeWritingAsync(item.Id);
        await inner.UpsertAsync(item, ct);
    }

    public async Task<bool> TryCreateAsync<T>(T item, CancellationToken ct) where T : Item
    {
        await InterruptAsync(nameof(TryCreateAsync), item.UserKey, ct);
        await BeforeWritingAsync(item.Id);
        return await inner.TryCreateAsync(item, ct);
    }

    public Task<IReadOnlyList<T>> ListByTypeAsync<T>(string userKey, string type, CancellationToken ct) where T : Item =>
        inner.ListByTypeAsync<T>(userKey, type, ct);

    public Task<int> CountAllAsync(string userKey, CancellationToken ct) => inner.CountAllAsync(userKey, ct);

    public async Task DeleteAsync(string userKey, string id, CancellationToken ct)
    {
        await BeforeWritingAsync(id);
        await inner.DeleteAsync(userKey, id, ct);
    }

    public async Task<bool> TryDeleteAsync(string userKey, string id, string etag, CancellationToken ct)
    {
        await BeforeWritingAsync(id);
        return await inner.TryDeleteAsync(userKey, id, etag, ct);
    }

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

    private async Task BeforeWritingAsync(string id)
    {
        Func<IDataStore, Task>? action = null;
        lock (_gate)
        {
            if (_beforeWriting is { } hook && hook.Match(id))
            {
                action = hook.Action;
                _beforeWriting = null;
            }
        }

        if (action is not null)
        {
            await action(inner);
        }
    }

    private async Task InterruptAsync(string operation, string userKey, CancellationToken ct)
    {
        if (userKey != DataConstants.GlobalPartition
            && Interlocked.CompareExchange(ref _deleteAllBefore, null, operation) == operation)
        {
            await inner.DeleteAllAsync(userKey, ct);
        }
    }
}
