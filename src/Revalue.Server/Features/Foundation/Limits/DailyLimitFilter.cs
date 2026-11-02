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
/// 1 人 1 日とアプリ全体 1 日の送信回数を数え、上限を超えたら 429 を返す。
/// 1 日の区切りは日本時間の 0 時。
/// </summary>
public sealed class DailyLimitFilter(IDataStore store, TimeProvider time, IOptions<LimitOptions> options) : IEndpointFilter
{
    /// <summary>その人のその日の送信回数。id は日付を含まない 1 件で、日が変わったら 1 から数え直す。</summary>
    public const string UsageId = "usage";

    public const string UsageType = "usage";

    /// <summary>アプリ全体の数は 2 日で消える（日付ごとに別のアイテムなので十分）。</summary>
    private const int TotalTtlSeconds = 172800;

    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var ct = context.HttpContext.RequestAborted;
        var userKey = context.HttpContext.User.GetUserKey()!;
        var date = Jst.Today(time).ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);

        // 読んで比べてから増やすと、同時に来た要求がどれも上限の手前の数を読んで通ってしまう。
        // 先に増やし、増やしたあとの値で比べる。断った分も数に残る（日本時間の 0 時に数え直す）
        var userCount = await store.IncrementDailyAsync(userKey, UsageId, UsageType, date, null, ct);
        if (userCount > options.Value.MessagesPerDay)
        {
            return LimitReached();
        }

        // 1 人の上限で断った要求は、アプリ全体の数を増やさない。1 人が送り続けても、ほかの人の分を使わないため
        var totalCount = await store.IncrementAsync(
            DataConstants.GlobalPartition, $"usage-total-{date}", "usage-total", TotalTtlSeconds, ct);
        if (totalCount > options.Value.MessagesPerDayTotal)
        {
            return LimitReached();
        }

        return await next(context);
    }

    private IResult LimitReached()
    {
        var resetAt = Jst.NextMidnight(time).ToString("yyyy-MM-dd'T'HH:mm:sszzz", CultureInfo.InvariantCulture);
        return Problems.Create(
            StatusCodes.Status429TooManyRequests,
            Problems.DailyLimit,
            "Daily limit reached.",
            new Dictionary<string, object?> { ["resetAt"] = resetAt });
    }
}

public static class DailyLimitExtensions
{
    /// <summary>Claude を呼ぶ API に付ける。RequireConsent のあとに付ける。</summary>
    public static TBuilder RequireDailyLimit<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.AddEndpointFilter<TBuilder, DailyLimitFilter>();
}
