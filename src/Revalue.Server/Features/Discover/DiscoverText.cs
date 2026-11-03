namespace Revalue.Server.Features.Discover;

/// <summary>
/// 裏側が決める、利用者に見せる言葉。AI を呼ばずに出す言葉は、すべてここに置く（Claude の判断。voice-reviewer が点検する）。
/// 使わない言葉（src/shared/forbidden-words.json）を含まないことを、テストで確かめる。
/// </summary>
public static class DiscoverText
{
    /// <summary>新しい場面の最初の問い。最近の具体的な一日を一つ尋ねる（discover-1）。</summary>
    public const string Opening =
        "最近のある一日のことを、聞かせてください。たとえば昨日、朝起きてから夜までに、どんなことがありましたか？";

    /// <summary>
    /// 本人が答えた話し終えた場面がすでにある人の、新しい場面の最初の問い（discover-1）。同じ言葉で聞いて、前の話を覚えていないように見せない（Claude の判断）。
    /// </summary>
    public const string OpeningAnotherDay =
        "前に話してくれた日とは別の、最近のある一日のことを、聞かせてください。その日の朝起きてから夜までに、どんなことがありましたか？";

    /// <summary>最初の問いの選択肢。特定の力の核となる行動に寄らない、中立な出来事にする（誘導しない）。</summary>
    public static readonly IReadOnlyList<string> OpeningChoices =
    [
        "家族と出かけた",
        "家で過ごした",
        "人と会った",
    ];

    /// <summary>
    /// 「この話は飛ばす」のあとの問い。最初の問いとは違う、負担の軽い具体的な場面を尋ねる（discover-5）。
    /// 飛ばした理由が負担の重い日だったかもしれないので、重い日へ話を戻さない。
    /// </summary>
    public const string AfterSkip =
        "では、別の日のことにしましょう。最近のある日の夕方、ごはんの前後は、どんなふうに過ごしましたか？";

    /// <summary>飛ばしたあとの問いの選択肢。特定の力に寄らないものにする。</summary>
    public static readonly IReadOnlyList<string> AfterSkipChoices =
    [
        "ごはんの用意をしていた",
        "家族とゆっくり過ごした",
        "出かけていて、外にいた",
    ];

    /// <summary>AI の返事から選択肢を読み取れなかったときに補う 3 つ（discover-3）。</summary>
    public static readonly IReadOnlyList<string> FallbackChoices =
    [
        "もう少しくわしく話す",
        "別の日の話にする",
        "よく覚えていない",
    ];

    /// <summary>つらい状態のサインが出たときの言葉。AI の返事の代わりに出す（discover-10）。</summary>
    public const string DistressText =
        "話してくれて、ありがとうございます。いまの気持ちを、ひとりで抱えなくて大丈夫です。" +
        "話を聞いてくれる相談先があります。このあとどうするかは、あなたが選べます。";

    /// <summary>厚生労働省「まもろうよ こころ」。電話や SNS の相談窓口の一覧があるページ。電話番号そのものは書かない。</summary>
    public const string SupportLinkUrl = "https://www.mhlw.go.jp/mamorouyokokoro/";

    public const string SupportLinkLabel = "まもろうよ こころ（厚生労働省の相談窓口のページ）";

    /// <summary>
    /// つらい状態のサインのあと、問いの代わりに出す 3 つの続け方。
    /// 「消えたい」と書いた直後にも出るので、「消す」という言葉を重ねない。
    /// </summary>
    public static readonly IReadOnlyList<string> DistressActions =
    [
        "続けて話す",
        "今日はここで区切る",
        "この話は残さずに、別の話にする",
    ];

    /// <summary>
    /// 読み取りに失敗したときと、返事を AI が断ったとき（どちらも、つらい状態のサインを見落としているかもしれない）に、
    /// 念のため小さく添える言葉。
    /// </summary>
    public const string PrecautionSupportNote = "つらいときは、こちらの相談先も使えます。";
}
