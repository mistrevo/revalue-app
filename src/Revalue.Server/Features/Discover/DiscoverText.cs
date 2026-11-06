namespace Revalue.Server.Features.Discover;

/// <summary>
/// 裏側が決める、利用者に見せる言葉。AI を呼ばずに出す言葉は、すべてここに置く（Claude の判断。voice-reviewer が点検する）。
/// 使わない言葉（src/shared/forbidden-words.json）を含まないことを、テストで確かめる。
/// </summary>
public static class DiscoverText
{
    /// <summary>
    /// 初めて話す人の、新しい場面の最初の問い。ここ数日で印象に残っている出来事を、気持ちの種類の選択肢から一つ選んでもらう（discover-1）。
    /// 出来事の中身をいきなり聞かず、気持ちの種類から入るほうが、話しやすい出来事を思い出しやすいため。
    /// 当事者の協力者の案をもとにした（PRD の 4-rules.md の「最初の問い」）。
    /// </summary>
    public const string Opening =
        "最近の一日を振り返ってみましょう。ここ数日の中で、印象に残っている出来事はありますか？ 話しやすいものを一つ選んでください。特別な出来事でなくても大丈夫です。";

    /// <summary>
    /// 本人が答えた話し終えた場面がすでにある人の、新しい場面の最初の問い（discover-1）。いつもと同じ問い（<see cref="Opening"/>）で聞くと、
    /// 前の話を覚えていないように見えるため（Claude の判断）。前に話した日を指さず、「別の日」も求めない。前の場面が一般論だけの人もいるため。
    /// いちばん新しい話し終えた場面がつらい状態のサインの場面なら、これではなく <see cref="OpeningAfterDistress"/> を使う。
    /// </summary>
    public const string OpeningAnotherDay = "また、" + Opening;

    /// <summary>
    /// 最初の問い（<see cref="Opening"/> と <see cref="OpeningAnotherDay"/>）の選択肢 9 つ。気持ちの種類で分け、特定の力の核となる行動に寄せない（誘導しない）。
    /// 成功の話だけを求めず、うまくいかなかった気持ちも同じ重さで並べ、何気ない日常も選べるようにする。「私には何もない」と思っている人が答えにくくならないようにするため。
    /// 選択肢ごとに引き出せる経験が違う。当事者の協力者の案をもとにした（言葉は開発者と協力者に確かめる）。
    /// 選んだだけでは根拠にしない（validate-5）。選んだ気持ちから力を決めない。
    /// </summary>
    public static readonly IReadOnlyList<string> OpeningChoices =
    [
        "うれしかった・楽しかったこと",
        "できた・達成できたこと",
        "ほっとした・安心したこと",
        "困った・大変だったこと",
        "思いどおりにいかなかったこと",
        "迷った・悩んだこと",
        OpeningChoiceAnger,
        "気づいた・考えさせられたこと",
        "何気ない日常の出来事",
    ];

    /// <summary>
    /// 最初の問いの選択肢のうち、腹が立った出来事を選ぶもの。話が相手の人（家族など）のことに向かいやすいので、選んだ場面では
    /// 足りない行動を聞き返さず（<see cref="ValidationContext.AngerOpening"/>）、飛ばしたあとも家族や家を前提にしない問いで始め直す
    /// （<see cref="DiscoverEndpoints.ChooseAfterSkip"/>。Claude の判断）。
    /// </summary>
    public const string OpeningChoiceAnger = "腹が立った・納得できなかったこと";

    /// <summary>
    /// いちばん新しい話し終えた場面が、つらい状態のサインで力の確かめに使わない場面だった人の、新しい場面の最初の問い（discover-1）。
    /// 気持ちの種類は聞かず、ふだんの一日を聞く。重い日に話を戻さないため（PRD の 4-rules.md の「別の日の入口」）。
    /// 前の話にふれず、問いの前に、特別な日でなくてよいと伝える。
    /// つらい状態のサインが出た場面を飛ばしたあとも、<see cref="AfterSkip"/> ではなくこれを使う（discover-5。DiscoverEndpoints.ChooseAfterSkip）。
    /// </summary>
    public const string OpeningAfterDistress =
        "また、最近のある一日のことを、聞かせてください。特別な日でなくてかまいません。その日の朝起きてから夜までに、どんなことがありましたか？";

    /// <summary>
    /// <see cref="OpeningAfterDistress"/> の選択肢。気持ちの向きではなく、特定の力に寄らない中立な出来事の種類にする。
    /// 「思いどおりにいかなかったこと」のような、重い日を思わせる選択肢を出さないため。
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
