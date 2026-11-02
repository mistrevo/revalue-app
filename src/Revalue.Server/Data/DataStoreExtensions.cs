namespace Revalue.Server.Data;

public static class DataStoreExtensions
{
    /// <summary>ほかの要求が先に書いて版が変わったときに、読み直してやり直す回数。</summary>
    public const int MaxUpdateAttempts = 5;

    /// <summary>
    /// 1 件を読み、change で新しい中身を作り、読んだときから変わっていなければ置き換える。
    /// ほかの要求が先に書いていたら、読み直して change をもう一度呼ぶ（change はいまの中身で確かめ直せる）。
    /// ないとき、消えたとき、change が null を返したときは、何も書かずに null を返す。ないアイテムは作らない。
    /// </summary>
    public static async Task<T?> TryUpdateAsync<T>(
        this IDataStore store, string userKey, string id, Func<T, T?> change, CancellationToken ct) where T : Item
    {
        for (var attempt = 0; attempt < MaxUpdateAttempts; attempt++)
        {
            var read = await store.GetVersionedAsync<T>(userKey, id, ct);
            if (read is null)
            {
                return null;
            }

            var next = change(read.Item);
            if (next is null)
            {
                return null;
            }

            if (await store.TryReplaceAsync(next, read.ETag, ct))
            {
                return next;
            }
        }

        throw new InvalidOperationException($"Could not update the item after {MaxUpdateAttempts} attempts.");
    }
}
