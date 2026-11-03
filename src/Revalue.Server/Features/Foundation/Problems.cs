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
    public const string InvalidProfile = "/problems/invalid-profile";

    /// <summary>力の確かめに使わない印のある場面なので、訂正も続きもできない。</summary>
    public const string EpisodeExcluded = "/problems/episode-excluded";

    /// <summary>仕事の選択肢を出す条件がそろっていない。拡張の <c>readiness</c> に、最初に足りないものを入れる。</summary>
    public const string OptionsNotReady = "/problems/options-not-ready";

    /// <summary>見ていたカードが作り直されたか、いまは見せられない。</summary>
    public const string OptionsChanged = "/problems/options-changed";

    /// <summary>選んだ案や本人が書いた仕事の形が合わない。</summary>
    public const string InvalidOption = "/problems/invalid-option";

    /// <summary>選んだ案を深める条件がそろっていない。拡張の <c>readiness</c> に、足りないもの（noChoice、hold、needsConditions）を入れる。</summary>
    public const string DeepenNotReady = "/problems/deepen-not-ready";

    /// <summary>見ていた深めた中身が、選び直しなどで古くなったか、いまの条件ではその候補を出していない。</summary>
    public const string DeepenChanged = "/problems/deepen-changed";

    /// <summary>深める画面からの書き換え（業務、答え、一歩）の形が合わない。</summary>
    public const string InvalidDeepen = "/problems/invalid-deepen";

    /// <summary>AI の呼び出しが失敗したか、AI が断った。拡張の <c>kind</c> に "failure" か "refusal" を入れる。</summary>
    public const string AiUnavailable = "/problems/ai-unavailable";

    public static IResult Create(int status, string type, string title, IDictionary<string, object?>? extensions = null) =>
        TypedResults.Problem(statusCode: status, type: type, title: title, extensions: extensions);
}
