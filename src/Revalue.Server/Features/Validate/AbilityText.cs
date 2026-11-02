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
    /// 前の場面のやりとりは画面の上に出ているので、「その日」で指す。
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
    /// 続きを話すときの、コードが決めた最初の問い（Claude の判断）。決まった受け止めの一文のあとに、行動ごとの問いを一つ。
    /// 番号が 1〜3 でなければ <see cref="ArgumentOutOfRangeException"/>。
    /// </summary>
    public static string ResumeQuestion(ActionRef action) => ResumeLead + Pick(Questions, action);

    /// <summary>
    /// 続きを話すときの、手がかりを添えない問い。足りない行動をどれも 2 回聞いたときなどに使う（同じ行動を 3 回聞かない。Claude の判断）。
    /// </summary>
    public const string ResumeOpenQuestion = ResumeLead + "その日のことで、ほかに覚えていることはありますか？";

    /// <summary>続きを話すときの、決まった受け止めの一文。続きを話しに戻ってきたことを受け止める（Claude の判断）。</summary>
    public const string ResumeLead = "また話しに来てくれて、ありがとうございます。";

    private static string Pick(IReadOnlyDictionary<Ability, string[]> texts, ActionRef action) =>
        action.Number is >= 1 and <= ActionRef.ActionsPerAbility
            ? texts[action.Ability][action.Number - 1]
            : throw new ArgumentOutOfRangeException(nameof(action));
}
