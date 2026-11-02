using System.Globalization;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;

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
