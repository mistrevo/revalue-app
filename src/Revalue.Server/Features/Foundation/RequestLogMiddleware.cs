using System.Diagnostics;
using Microsoft.AspNetCore.Routing;
using Revalue.Server.Features.Foundation.Auth;

namespace Revalue.Server.Features.Foundation;

/// <summary>
/// 中身を書かないアクセスログ。書くのは、メソッド、経路の型（/api/me のようなもの。実際のパスやクエリは書かない）、
/// 状態コード、かかったミリ秒、利用者キーだけ。リクエストとレスポンスの中身は書かない。
/// </summary>
public sealed class RequestLogMiddleware(RequestDelegate next, ILogger<RequestLogMiddleware> logger)
{
    public async Task InvokeAsync(HttpContext context)
    {
        var started = Stopwatch.GetTimestamp();
        try
        {
            await next(context);
        }
        finally
        {
            var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "-";
            logger.LogInformation(
                "{Method} {Route} {Status} {ElapsedMs}ms {UserKey}",
                context.Request.Method,
                route,
                context.Response.StatusCode,
                (long)Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                context.User.GetUserKey() ?? "-");
        }
    }
}
