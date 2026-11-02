namespace Revalue.Server.Features.Validate;

/// <summary>
/// 力の名前と、核となる行動を普通の言葉にした手がかり（03-validate.md の表）。裏側の言葉の 1 か所で、画面へは API で渡す。
/// 聞き手の AI には、核となる行動の一覧ではなく、この手がかりだけを渡す。
/// </summary>
public static class AbilityText
{
    private static readonly IReadOnlyDictionary<Ability, string> Names = new Dictionary<Ability, string>
    {
        [Ability.Noticing] = "見立てる力",
        [Ability.Coordinating] = "調整する力",
        [Ability.Prioritizing] = "優先順位をつける力",
    };

    /// <summary>
    /// 手がかりの言葉。画面の「もう少し聞かせてほしいこと」に、前の文脈なしで並ぶので、「そう」のように前を指す言葉を使わず、それだけで意味が通る形にする。
    /// </summary>
    private static readonly IReadOnlyDictionary<Ability, string[]> Hints = new Dictionary<Ability, string[]>
    {
        [Ability.Noticing] =
        [
            "いつもと違うことに、自分で気づいたこと",
            "何を見たり聞いたりして、いつもと違うと思ったか",
            "いつもの様子や、前のときと比べたこと",
        ],
        [Ability.Coordinating] =
        [
            "ほかに関わっていた人と、その人たちの都合",
            "あなたから声をかけたり、頼んだりしたこと",
            "みんなの都合を合わせたり、別の案を出したりしたこと",
        ],
        [Ability.Prioritizing] =
        [
            "その日に重なっていた用事",
            "何を先にして、何を後に回したか",
            "先にすること、後に回すことを、どう考えて決めたか",
        ],
    };

    /// <summary>
    /// 続きを話すときの、行動ごとの問い（Claude の判断）。本人がその行動をしたことを前提にせず、「ありましたか」「あれば」で聞く。
    /// 前の場面は、問いの前の映し返しで本人の言葉を示すので、「その日」で指す。
    /// </summary>
    private static readonly IReadOnlyDictionary<Ability, string[]> Questions = new Dictionary<Ability, string[]>
    {
        [Ability.Noticing] =
        [
            "その日、いつもと違うと気づいたことはありましたか？",
            "その日、いつもと違うと思ったことがあれば、何を見たり聞いたりしてそう思ったかを、聞かせてもらえますか？",
            "その日の様子を、いつもや前のときと比べて、思ったことはありましたか？",
        ],
        [Ability.Coordinating] =
        [
            "その日のことに、ほかに関わっていた人がいれば、その人たちの都合も聞かせてもらえますか？",
            "その日、だれかに声をかけたり、頼んだりしたことはありましたか？",
            "その日、みんなの都合を合わせたり、別の案を出したりしたことはありましたか？",
        ],
        [Ability.Prioritizing] =
        [
            "その日、重なっていた用事はありましたか？",
            "その日の用事の中で、先にしたことや、後に回したことはありましたか？",
            "その日、用事の順番を決めたことがあれば、どう考えて決めたかを聞かせてもらえますか？",
        ],
    };

    /// <summary>続きを話すときの選択肢（Claude の判断）。「していない」を、値打ちを下げずに言える答えを一つ入れる。</summary>
    public static IReadOnlyList<string> ResumeChoices { get; } = ["少し覚えています", "とくになかったと思います", "その日のほかのことを話したい"];

    public static string Name(Ability ability) => Names[ability];

    /// <summary>行動の手がかり。番号が 1〜3 でなければ <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string Hint(ActionRef action) => Pick(Hints, action);

    /// <summary>
    /// 続きを話すときの、コードが決めた最初の問い（Claude の判断）。4-rules.md の「対話の決まり」のとおり、
    /// 決まった受け止めの一文（<see cref="ResumeLead"/>）、本人の言葉の映し返し（<see cref="ResumeMirror"/>）、問い一つ、の順。
    /// 問いは、聞く行動があればその行動の問い（<see cref="ResumeAsk"/>）、なければ手がかりを添えない問い（<see cref="ResumeOpenAsk"/>）。
    /// 映し返す言葉（<paramref name="quote"/>）がなければ、映し返しを書かない。番号が 1〜3 でなければ <see cref="ArgumentOutOfRangeException"/>。
    /// </summary>
    public static string ResumeOpening(ActionRef? action, string? quote) =>
        ResumeLead + (string.IsNullOrWhiteSpace(quote) ? "" : ResumeMirror(quote)) + (action is null ? ResumeOpenAsk : ResumeAsk(action));

    /// <summary>続きを話すときの、行動ごとの問い。番号が 1〜3 でなければ <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string ResumeAsk(ActionRef action) => Pick(Questions, action);

    /// <summary>
    /// 続きを話すときの、本人の言葉の映し返し。根拠の本人の言葉を「」で囲み、一字一句そのまま示す（Claude の判断）。
    /// どの日のことを聞くかを、問いの「その日」より先に示す。
    /// </summary>
    public static string ResumeMirror(string quote) => $"前に「{quote}」と話してくれましたね。";

    /// <summary>
    /// 続きを話すときの、手がかりを添えない問い。足りない行動をどれも 2 回聞いたときや、訂正で打ち消されたときなどに使う
    /// （同じ行動を 3 回聞かない。Claude の判断）。
    /// </summary>
    public const string ResumeOpenAsk = "その日のことで、ほかに覚えていることはありますか？";

    /// <summary>続きを話すときの、決まった受け止めの一文。続きを話しに戻ってきたことを受け止める（Claude の判断）。</summary>
    public const string ResumeLead = "また話しに来てくれて、ありがとうございます。";

    private static string Pick(IReadOnlyDictionary<Ability, string[]> texts, ActionRef action) =>
        action.Number is >= 1 and <= ActionRef.ActionsPerAbility
            ? texts[action.Ability][action.Number - 1]
            : throw new ArgumentOutOfRangeException(nameof(action));
}
