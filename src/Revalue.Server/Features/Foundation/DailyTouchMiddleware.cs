using System.Globalization;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;

namespace Revalue.Server.Features.Foundation;

/// <summary>使った記録。最後に使った日（日本時間、yyyy-MM-dd）を持つ。</summary>
public sealed record ActivityItem : Item
{
    public const string ItemId = "activity";
    public const string ItemType = "activity";

    public required string LastActiveDate { get; init; }
}

/// <summary>
/// ログインした人が日本時間でその日に初めて使ったとき、その人のアイテムをすべて書き直して 30 日を数え直す。
/// </summary>
public sealed class DailyTouchMiddleware(RequestDelegate next)
{
    public async Task InvokeAsync(HttpContext context, IDataStore store, TimeProvider time)
    {
        var userKey = context.User.GetUserKey();
        if (userKey is not null)
        {
            var ct = context.RequestAborted;
            var today = Jst.Today(time).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
            var activity = await store.GetAsync<ActivityItem>(userKey, ActivityItem.ItemId, ct);
            if (activity?.LastActiveDate != today)
            {
                await store.TouchAllAsync(userKey, ct);
                await store.UpsertAsync(
                    new ActivityItem { Id = ActivityItem.ItemId, UserKey = userKey, Type = ActivityItem.ItemType, LastActiveDate = today },
                    ct);
            }
        }

        await next(context);
    }
}
