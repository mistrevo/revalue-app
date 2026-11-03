using System.Diagnostics;
using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Options;

namespace Revalue.Server.Features.Home;

/// <summary>/api/next-step の API（00-common.md の「次にできること」）。AI は呼ばないので、1 日の送信回数は使わない。</summary>
public static class NextStepEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/next-step", async (
            HttpContext http, IDataStore store, JobCatalog catalog, ILoggerFactory loggers, CancellationToken ct) =>
        {
            var watch = Stopwatch.StartNew();
            var result = await NextStep.ReadAsync(store, http.User.GetUserKey()!, catalog, ct);

            // 時間だけを書く。どこまで進んだかと場面の id は書かない
            loggers.CreateLogger(typeof(NextStepEndpoints)).LogInformation(
                "Next step decided in {ElapsedMs} ms.", watch.ElapsedMilliseconds);
            return TypedResults.Ok(result);
        }).RequireConsent();
    }
}
