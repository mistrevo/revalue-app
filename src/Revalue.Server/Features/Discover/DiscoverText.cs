namespace Revalue.Server.Features.Discover;

/// <summary>
/// 裏側が決める、利用者に見せる言葉。AI を呼ばずに出す言葉は、すべてここに置く（Claude の判断。voice-reviewer が点検する）。
/// 使わない言葉（src/shared/forbidden-words.json）を含まないことを、テストで確かめる。
/// </summary>
public static class DiscoverText
{
    /// <summary>
    /// 初めて話す人の、新しい場面の最初の問い。最近の、気持ちが動いた日を一つ尋ねる（discover-1）。
    /// 「最近の一日」より「〜と感じた日」と聞くほうが、うまくいった経験や乗り越えた経験を話しやすいため（PRD の 4-rules.md の「最初の問い」）。
    /// </summary>
    public const string Opening =
        "最近、気持ちが動いた日のことを、一つ聞かせてください。どんな日でしたか？";

    /// <summary>
    /// 本人が答えた話し終えた場面がすでにある人の、新しい場面の最初の問い（discover-1）。いつもと同じ問い（<see cref="Opening"/>）で聞くと、
    /// 前の話を覚えていないように見えるため（Claude の判断）。前に話した日を指さず、「別の日」も求めない。前の場面が一般論だけの人もいるため。
    /// いちばん新しい話し終えた場面がつらい状態のサインの場面なら、これではなく <see cref="OpeningAfterDistress"/> を使う。
    /// </summary>
    public const string OpeningAnotherDay =
        "また、最近、気持ちが動いた日のことを、一つ聞かせてください。どんな日でしたか？";

    /// <summary>
    /// 最初の問い（<see cref="Opening"/> と <see cref="OpeningAnotherDay"/>）の選択肢。気持ちの向きで分け、特定の力の核となる行動に寄せない（誘導しない）。
    /// 成功の話だけを求めず、うまくいかなかった日も同じ重さで並べる。「私には何もない」と思っている人が答えにくくならないようにするため。
    /// 選んだだけでは根拠にしない（validate-5）。
    /// </summary>
    public static readonly IReadOnlyList<string> OpeningChoices =
    [
        "うまくいったと感じた日",
        "大変だったけど、乗り切った日",
        "思うようにいかなかった日",
    ];

    /// <summary>
    /// いちばん新しい話し終えた場面が、つらい状態のサインで力の確かめに使わない場面だった人の、新しい場面の最初の問い（discover-1）。
    /// 気持ちが動いた日は聞かず、ふだんの一日を聞く。重い日に話を戻さないため（PRD の 4-rules.md の「別の日の入口」）。
    /// 前の話にふれず、問いの前に、特別な日でなくてよいと伝える。
    /// つらい状態のサインが出た場面を飛ばしたあとも、<see cref="AfterSkip"/> ではなくこれを使う（discover-5。DiscoverEndpoints.ChooseAfterSkip）。
    /// </summary>
    public const string OpeningAfterDistress =
        "また、最近のある一日のことを、聞かせてください。特別な日でなくてかまいません。その日の朝起きてから夜までに、どんなことがありましたか？";

    /// <summary>
    /// <see cref="OpeningAfterDistress"/> の選択肢。気持ちの向きではなく、特定の力に寄らない中立な出来事の種類にする。
    /// 「思うようにいかなかった日」のような、重い日を思わせる選択肢を出さないため。
    /// 家族や家も前提にしない。つらい状態のサインには家庭内の暴力や暴言も入るので、打ち明けたあとの入口で「家族と」「家で」と出すと、
    /// 重い場面へ戻すきっかけになりうるため（Claude の判断。言葉は開発者と協力者に確かめる）。
    /// </summary>
    public static readonly IReadOnlyList<string> OpeningAfterDistressChoices =
    [
        "買い物に行った",
        "外を歩いた",
        "ひとりで過ごした",
    ];

    /// <summary>
    /// 「この話は飛ばす」のあとの問い。最初の問いとは違う、負担の軽い具体的な場面を尋ねる（discover-5）。
    /// 飛ばした理由が負担の重い日だったかもしれないので、重い日へ話を戻さない。
    /// 飛ばした場面につらい状態のサインが出ていたら、これではなく <see cref="OpeningAfterDistress"/> を使う。
    /// 夕方のごはんの前後と、選択肢の「家族とゆっくり過ごした」は家族や家の中を思わせるため（DiscoverEndpoints.ChooseAfterSkip）。
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
