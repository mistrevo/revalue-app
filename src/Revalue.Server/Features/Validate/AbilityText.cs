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
    /// 続きを話すときの、行動ごとの問い（Claude の判断）。本人がその行動をしたことを前提にせず、「ありましたか」「いましたか」で聞く。
    /// どの問いにも同じ選択肢（<see cref="ResumeChoices"/>）が自然な答えになるよう、問いの形をそろえる。一度に一つだけ求める。
    /// 前の場面は、問いの前の映し返しで本人の言葉を示すので、「その日」で指す。
    /// </summary>
    private static readonly IReadOnlyDictionary<Ability, string[]> Questions = new Dictionary<Ability, string[]>
    {
        [Ability.Noticing] =
        [
            "その日、いつもと違うと気づいたことはありましたか？",
            "その日、いつもと違うと思ったことがあれば、そのとき目に入ったことや耳にしたことはありましたか？",
            "その日の様子を、いつもや前のときと比べたことはありましたか？",
        ],
        [Ability.Coordinating] =
        [
            "その日、あなたのほかに、予定や都合が関わっていた人はいましたか？",
            "その日、だれかに声をかけたり、頼んだりしたことはありましたか？",
            "その日、みんなの都合を合わせたり、別の案を出したりしたことはありましたか？",
        ],
        [Ability.Prioritizing] =
        [
            "その日、重なっていた用事はありましたか？",
            "その日の用事の中で、先にしたことや、後に回したことはありましたか？",
            "その日、どれを先にするか決めるときに、気にしていたことはありましたか？",
        ],
    };

    /// <summary>
    /// 続きの選択肢のうち、「していない」を値打ちを下げずに言える答え。続きの問いへの答えにこれを選んだら、
    /// その問いで聞いた行動を、聞いた回数の上限に届いたものとして扱い、聞き直さない（<see cref="Discover.ValidationContext.From"/>。Claude の判断）。
    /// </summary>
    public const string ResumeChoiceNone = "とくに思い当たりません";

    /// <summary>
    /// 続きの選択肢のうち、その日のほかのことを話したい答え。続きの問いへの答えにこれを選んだら、次の一手は足りない行動ではなく、
    /// その日にしたことを聞く（<see cref="Discover.NextMovePolicy.Decide"/>。Claude の判断）。
    /// </summary>
    public const string ResumeChoiceOtherThings = "その日のほかのことを話したい";

    /// <summary>続きを話すときの選択肢（Claude の判断）。「していない」を、値打ちを下げずに言える答えを一つ入れる。</summary>
    public static IReadOnlyList<string> ResumeChoices { get; } = ["思い当たることがあります", ResumeChoiceNone, ResumeChoiceOtherThings];

    /// <summary>
    /// 根拠が一般論だけの力の手がかり（「もう少し聞かせてほしいこと」）。一般論だけでは根拠ありにしないので、足りない行動ではなく、
    /// 具体的な出来事を一つ求める（validate-10（一般論には具体的な出来事を聞く）。Claude の判断）。
    /// </summary>
    public const string ConcreteDayHint = "いつものことの中から、最近のある一日の出来事";

    /// <summary>
    /// 根拠が一般論だけの場面の、続きの問い（Claude の判断）。一般論の場面には指せる「その日」がないため、行動ごとの問いは使わない。
    /// 「毎週同じで、この日というのは浮かばない」人がつまずかないよう、特別な日でなくてよいことを先に伝え、日を選ばせずに「いちばん最近」を聞く。
    /// 「いつものことの中から」は手がかり（<see cref="ConcreteDayHint"/>）と同じ言葉で、映し返しの文の形に頼らない。
    /// </summary>
    public const string ResumeConcreteAsk = "特別な日でなくてかまいません。いつものことの中から、いちばん最近の一日のことを、聞かせてもらえますか？";

    /// <summary>一般論だけの場面の続きの選択肢（Claude の判断）。日が浮かばない人も選べる答えを一つ入れる。</summary>
    public static IReadOnlyList<string> ConcreteDayChoices { get; } = ["今週のことを話したい", "先週のことを話したい", "すぐには浮かばない"];

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
        ResumeLead + (string.IsNullOrWhiteSpace(quote) ? NoMirrorAnchor : ResumeMirror(quote)) + (action is null ? ResumeOpenAsk : ResumeAsk(action));

    /// <summary>
    /// 根拠が一般論だけの場面の、続きの最初の問い。受け止めの一文、一般論の映し返し、最近の一日を一つ聞く問い（<see cref="ResumeConcreteAsk"/>）の順。
    /// </summary>
    public static string ResumeOpeningForGeneral(string? quote) => ResumeLead + MirrorOrEmpty(quote) + ResumeConcreteAsk;

    private static string MirrorOrEmpty(string? quote) => string.IsNullOrWhiteSpace(quote) ? "" : ResumeMirror(quote);

    /// <summary>
    /// 映し返す言葉がないときに、行動ごとの問いの「その日」が指す日を示す一文。要確認の力には根拠があるので、ほぼ使わない（Claude の判断）。
    /// </summary>
    public const string NoMirrorAnchor = "前に話してくれた日のことです。";

    /// <summary>続きを話すときの、行動ごとの問い。番号が 1〜3 でなければ <see cref="ArgumentOutOfRangeException"/>。</summary>
    public static string ResumeAsk(ActionRef action) => Pick(Questions, action);

    /// <summary>
    /// 続きを話すときの、本人の言葉の映し返し。根拠の本人の言葉を「」で囲み、一字一句そのまま示す。
    /// ただし文末の句読点だけは外す（「」の中に「。」「、」を残さない書き方に合わせる。保存した根拠は変えない。Claude の判断）。
    /// どの日のことを聞くかを、問いの「その日」より先に示す。
    /// </summary>
    public static string ResumeMirror(string quote) => $"前に「{quote.Trim().TrimEnd('。', '．', '、', '，')}」と話してくれましたね。";

    /// <summary>
    /// 続きを話すときの、手がかりを添えない問い。足りない行動をどれも 2 回聞いたときや、訂正で打ち消されたときなどに使う
    /// （同じ行動を 3 回聞かない。Claude の判断）。
    /// </summary>
    public const string ResumeOpenAsk = "その日のことで、ほかに覚えていることはありますか？";

    /// <summary>
    /// 続きを話すときの、決まった受け止めの一文。本人が続きを選んだことを、そのまま受け止める。区切った直後に押しても、日をおいて戻っても合うよう、
    /// 「また」「来てくれて」のように時間を前提にした言い方をしない。「話そうとして」のように、まだしていないとも読める言い方もしない。
    /// 問いは後ろの一つだけにするので、ここでは何も求めない（Claude の判断。開発者が確かめる）。
    /// </summary>
    public const string ResumeLead = "続きの話を選んでくれて、ありがとうございます。";

    private static string Pick(IReadOnlyDictionary<Ability, string[]> texts, ActionRef action) =>
        action.Number is >= 1 and <= ActionRef.ActionsPerAbility
            ? texts[action.Ability][action.Number - 1]
            : throw new ArgumentOutOfRangeException(nameof(action));
}
