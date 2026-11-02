namespace Revalue.Server.Features.Foundation;

/// <summary>
/// エラーを ProblemDetails（決まった形の JSON）で返すための種類（type）と生成。
/// 利用者に見せる文言は画面側で穏やかな言葉にする。
/// </summary>
public static class Problems
{
    public const string LoginRequired = "/problems/login-required";
    public const string ConsentRequired = "/problems/consent-required";
    public const string DailyLimit = "/problems/daily-limit";
    public const string NotFound = "/problems/not-found";
    public const string EpisodeInProgress = "/problems/episode-in-progress";
    public const string EpisodeFinished = "/problems/episode-finished";
    public const string InvalidAnswer = "/problems/invalid-answer";

    /// <summary>力の確かめに使わない印のある場面なので、訂正も続きもできない。</summary>
    public const string EpisodeExcluded = "/problems/episode-excluded";

    /// <summary>AI の呼び出しが失敗したか、AI が断った。拡張の <c>kind</c> に "failure" か "refusal" を入れる。</summary>
    public const string AiUnavailable = "/problems/ai-unavailable";

    public static IResult Create(int status, string type, string title, IDictionary<string, object?>? extensions = null) =>
        TypedResults.Problem(statusCode: status, type: type, title: title, extensions: extensions);
}
