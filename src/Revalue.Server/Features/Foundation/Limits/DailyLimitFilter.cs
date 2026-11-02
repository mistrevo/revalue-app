using System.Globalization;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Microsoft.Extensions.Options;

namespace Revalue.Server.Features.Foundation.Limits;

/// <summary>送信回数の上限。設定 <c>Limits</c> から読む。</summary>
public sealed class LimitOptions
{
    public int MessagesPerDay { get; set; } = 100;
    public int MessagesPerDayTotal { get; set; } = 1000;
}

/// <summary>
/// 1 人 1 日とアプリ全体 1 日の送信回数を数え、上限に達していたら 429 を返す。
/// 1 日の区切りは日本時間の 0 時。
/// </summary>
public sealed class DailyLimitFilter(IDataStore store, TimeProvider time, IOptions<LimitOptions> options) : IEndpointFilter
{
    /// <summary>アプリ全体の数は 2 日で消える（日付ごとに別のアイテムなので十分）。</summary>
    private const int TotalTtlSeconds = 172800;

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var ct = context.HttpContext.RequestAborted;
        var userKey = context.HttpContext.User.GetUserKey()!;
        var date = Jst.Today(time).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        var userId = $"usage-{date}";
        var totalId = $"usage-total-{date}";

        var userCount = (await store.GetAsync<CountItem>(userKey, userId, ct))?.Count ?? 0;
        var totalCount = (await store.GetAsync<CountItem>(DataConstants.GlobalPartition, totalId, ct))?.Count ?? 0;
        if (userCount >= options.Value.MessagesPerDay || totalCount >= options.Value.MessagesPerDayTotal)
        {
            var resetAt = Jst.NextMidnight(time).ToString("yyyy-MM-dd'T'HH:mm:sszzz", CultureInfo.InvariantCulture);
            return Problems.Create(
                StatusCodes.Status429TooManyRequests,
                Problems.DailyLimit,
                "Daily limit reached.",
                new Dictionary<string, object?> { ["resetAt"] = resetAt });
        }

        await store.IncrementAsync(userKey, userId, "usage", null, ct);
        await store.IncrementAsync(DataConstants.GlobalPartition, totalId, "usage-total", TotalTtlSeconds, ct);
        return await next(context);
    }
}

public static class DailyLimitExtensions
{
    /// <summary>Claude を呼ぶ API に付ける。RequireConsent のあとに付ける。</summary>
    public static TBuilder RequireDailyLimit<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.AddEndpointFilter<TBuilder, DailyLimitFilter>();
}
