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

    private static readonly IReadOnlyDictionary<Ability, string[]> Hints = new Dictionary<Ability, string[]>
    {
        [Ability.Noticing] =
        [
            "いつもと違うことに、自分で気づいたこと",
            "そう思った手がかり（何を見て、何を聞いてそう思ったか）",
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
            "そう決めた理由",
        ],
    };

    /// <summary>続きを話すときの選択肢（Claude の判断）。</summary>
    public static IReadOnlyList<string> ResumeChoices { get; } = ["少し覚えています", "よく覚えていません", "その日のほかのことを話したい"];

    public static string Name(Ability ability) => Names[ability];

    /// <summary>行動の手がかり。番号が 1〜3 でなければ <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string Hint(ActionRef action) =>
        action.Number is >= 1 and <= ActionRef.ActionsPerAbility
            ? Hints[action.Ability][action.Number - 1]
            : throw new ArgumentOutOfRangeException(nameof(action));

    /// <summary>続きを話すときの、コードが決めた問い（Claude の判断）。</summary>
    public static string ResumeQuestion(ActionRef action) =>
        ResumeLead + Hint(action) + "について、覚えていることはありますか？";

    /// <summary>
    /// 続きを話すときの、手がかりを添えない問い。足りない行動をどれも 2 回聞いたときなどに使う（同じ行動を 3 回聞かない。Claude の判断）。
    /// </summary>
    public const string ResumeOpenQuestion = ResumeLead + "その日のことで、ほかに覚えていることはありますか？";

    private const string ResumeLead = "この場面の続きを聞かせてください。";
}
