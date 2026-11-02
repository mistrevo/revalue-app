using System.Globalization;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Foundation.Limits;

namespace Revalue.Server.Features.Foundation;

/// <summary>使った記録。最後に使った日（日本時間、yyyy-MM-dd）を持つ。</summary>
public sealed record ActivityItem : Item
{
    public const string ItemId = "activity";
    public const string ItemType = "activity";

    public required string LastActiveDate { get; init; }
}

/// <summary>
/// いまの版で了解した人が日本時間でその日に初めて使ったとき、その人のアイテムをすべて書き直して 30 日を数え直す。
/// 了解していない人のアイテムは作らない。全部消したあとに画面が了解の状態を読み直しても、何も残らないようにするため。
/// 了解の記録がない人にアイテムが残っていたら消す。
/// </summary>
public sealed class DailyTouchMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, IDataStore store, TimeProvider time)
    {
        var userKey = context.User.GetUserKey();
        if (userKey is not null)
        {
            await TouchAsync(store, time, userKey, context.RequestAborted);
        }

        await next(context);
    }

    private static async Task TouchAsync(IDataStore store, TimeProvider time, string userKey, CancellationToken ct)
    {
        var today = Jst.Today(time).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var activity = await store.GetAsync<ActivityItem>(userKey, ActivityItem.ItemId, ct);
        if (activity?.LastActiveDate == today)
        {
            return;
        }

        var consent = await store.GetAsync<ConsentItem>(userKey, ConsentItem.ItemId, ct);
        if (consent is null)
        {
            // TTL は書いた時刻から数えるので、了解の記録が先に消えて、同じ日のあとで書いたアイテムだけが残ることがある。
            // 了解のないまま残さず、了解し直したときに古いものが戻らないよう、ここで消す
            await store.DeleteLeftoversAsync(userKey, ct);
            return;
        }

        if (consent.Version != ConsentInfo.CurrentVersion)
        {
            return;
        }

        try
        {
            // 保存するのは「その日の送信回数」だけ。日が変わったら、送らなくても前の日の回数を残さない。
            // 置き直さないと、下の TouchAllAsync が前の日の回数の TTL まで延ばし続ける
            var usage = await store.GetAsync<DailyCountItem>(userKey, DailyLimitFilter.UsageId, ct);
            if (usage is not null && usage.Date != today)
            {
                await store.UpsertAsync(usage with { Date = today, Count = 0 }, ct);
            }

            await store.TouchAllAsync(userKey, ct);
            await store.UpsertAsync(
                new ActivityItem { Id = ActivityItem.ItemId, UserKey = userKey, Type = ActivityItem.ItemType, LastActiveDate = today },
                ct);
        }
        catch (ConsentMissingException)
        {
            // 全部消すのと重なり、了解の記録がもうない。消したあとに作り直さない
        }
    }
}
