using System.Text;
using System.Text.RegularExpressions;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Options;

/// <summary>
/// AI が書いた 3 枚のカードの下書きを、コードで照らし合わせてカードにする（05-options.md の「AI が書いた中身をコードで確かめる」）。
/// 規則のどれかに当たったカードと、AI が作らないと答えたカードは出さず、<see cref="MissingReason.Rejected"/> と規則の名前を返す。
/// </summary>
public static partial class OptionsValidator
{
    public const int MaxReason = 300;
    public const int MaxRoleName = 30;
    public const int MaxTitle = 40;
    public const int MaxWho = 60;
    public const int MaxTrouble = 120;
    public const int MaxCreateSummary = 300;

    private const int MaxTasksPerCard = 3;
    private const int MinCombineTasks = 2;
    private const int MaxCreateQuotes = 3;

    /// <summary>見た目の上限に対する、中身（UTF-16）の長さの上限の倍率。</summary>
    private const int Utf16Factor = 4;

    /// <summary>
    /// 仕事のカードの文に限って照らし合わせる、言い切りと順位の言葉（05-options.md の「AI が書いた中身をコードで確かめる」）。
    /// 本人が選ぶ前に、AI が適職や順番を決めたように読めるため。「」で引いた本人の言葉の中は数えない（Claude の判断）。
    /// </summary>
    public static readonly IReadOnlyList<string> AssertiveWords =
    [
        "向いています", "向いている", "向いてる", "向いていそう", "向いてそう", "ぴったり", "最適", "適任", "最良", "ベスト",
        "いちばん", "一番", "おすすめ", "オススメ", "お勧め", "お薦め", "イチオシ", "一押し", "最も",
    ];

    /// <summary>
    /// 理由のほかの文（役割の名前、「創る」の題、誰の、困りごと、中身）に書かせない括弧。「」は理由の中で根拠の言葉を引くときだけ使う。
    /// 理由の中でも、「」のほかの括弧（『』や “” など）と、閉じていない「」は使わせない。照らし合わせを括弧の種類を変えて抜けられないため。
    /// </summary>
    private static readonly char[] QuoteMarks = ['「', '」', '『', '』', '“', '”', '‘', '’', '"', '＂', '〝', '〟'];

    /// <summary>
    /// 根拠の言葉を写したと見なす長さ（空白と句読点・記号を除いた文字の数。Claude の判断）。理由の「」の外や、理由のほかの文に、
    /// 根拠の言葉の一部がこの長さ以上そのまま入っていたら、「」なしで写したと見なす。
    /// </summary>
    public const int MinCopiedLetters = 8;

    [GeneratedRegex("「([^」]*)」")]
    private static partial Regex BracketPattern();

    /// <summary>
    /// 仕事のカードの文に限って照らし合わせる、大げさな褒め言葉（05-options.md の「AI が書いた中身をコードで確かめる」）。
    /// 本人がしたことを具体的に書かずに、褒め言葉で埋めないため（製品の芯 1）。「得意先」の「得意」と、「プロジェクト」のように
    /// カタカナが続く「プロ」は数えない。「」で引いた本人の言葉の中も数えない（Claude の判断）。
    /// </summary>
    [GeneratedRegex("すばらし|素晴らし|素敵|すてき|達人|天才|得意(?!先)|プロフェッショナル|プロ(?![ァ-ヺー])|見事|完璧|さすが|抜群")]
    private static partial Regex PraisePattern();

    /// <summary>
    /// お金の額。数字（漢数字を含む）のあとの「円」「えん」、「¥」のあとの数字、数字か「数」のあとの「万」、時給や収入などのお金の言葉のすぐあとの数字。
    /// 収入の目安はコードが登録の業務から計算して出し、「創る」は出さないので、AI が書いた文には額を書かせない
    /// （05-options.md の「AI が書いた中身をコードで確かめる」。Claude の判断）。
    /// </summary>
    [GeneratedRegex(@"[0-9０-９〇一二三四五六七八九十百千万億][\s,，.．]*(円|えん)|[¥￥]\s*[0-9０-９]|[0-9０-９数][\s,，.．]*万|(時給|日給|月給|年収|月収|報酬|単価|売上|売り上げ|収入|稼ぎ|料金|値段|価格)[^。\n0-9０-９]{0,4}[0-9０-９]")]
    private static partial Regex MoneyPattern();

    /// <summary>文の中の、最初に見つかった言い切りと順位の言葉。「」の中は除いて探す。なければ null。</summary>
    public static string? AssertiveIn(string text)
    {
        var outside = BracketPattern().Replace(text, "");
        return AssertiveWords.FirstOrDefault(word => outside.Contains(word, StringComparison.Ordinal));
    }

    /// <summary>文の中の、最初に見つかった大げさな褒め言葉。「」の中は除いて探す。なければ null。</summary>
    public static string? PraiseIn(string text) =>
        PraisePattern().Match(BracketPattern().Replace(text, "")) is { Success: true } match ? match.Value : null;

    /// <summary>文の中に、お金の額があるか。「」で引いた本人の言葉の中は数えない。</summary>
    public static bool HasMoneyAmount(string text) => MoneyPattern().IsMatch(BracketPattern().Replace(text, ""));

    /// <summary>空白と句読点・記号を除いた文字の並び。</summary>
    private static string LettersOnly(string text)
    {
        var sb = new StringBuilder(text.Length);
        foreach (var rune in text.EnumerateRunes())
        {
            if (Rune.IsLetterOrDigit(rune))
            {
                sb.Append(rune.ToString());
            }
        }

        return sb.ToString();
    }

    /// <summary>
    /// <paramref name="text"/> に、<paramref name="words"/> のどれかの一部が <see cref="MinCopiedLetters"/> 文字以上そのまま入っているか
    /// （空白と句読点・記号を除いて比べる）。<paramref name="allowed"/> のどれかにも含まれる部分は数えない。
    /// </summary>
    private static bool CopiesWords(string text, IEnumerable<string> words, IReadOnlyList<string> allowed)
    {
        var target = LettersOnly(text);
        if (target.Length < MinCopiedLetters)
        {
            return false;
        }

        var permitted = allowed.Select(LettersOnly).ToList();
        foreach (var word in words.Select(LettersOnly))
        {
            for (var i = 0; i + MinCopiedLetters <= word.Length; i++)
            {
                var part = word.Substring(i, MinCopiedLetters);
                if (target.Contains(part, StringComparison.Ordinal)
                    && !permitted.Any(p => p.Contains(part, StringComparison.Ordinal)))
                {
                    return true;
                }
            }
        }

        return false;
    }

    /// <summary>根拠の言葉（言葉と、選んだ答えに結びついた言葉）。</summary>
    private static IEnumerable<string> WordsOf(IEnumerable<Evidence> evidence) =>
        evidence.SelectMany(q => new[] { q.Quote, q.LinkedQuote }).OfType<string>().Where(w => w.Length > 0);

    public static (OptionCards Cards, IReadOnlyList<CardRejection> Rejections) Build(
        OptionsDraft draft,
        OptionCandidates candidates,
        OptionsInputs inputs,
        JobCatalog catalog,
        ForbiddenWordList forbidden,
        DateTimeOffset now)
    {
        var rejections = new List<CardRejection>();
        var missing = new List<MissingCard>();
        var basis = OptionsInputsReader.Basis(inputs);

        if (inputs.Conditions is not { } conditions)
        {
            return (new OptionCards(now, basis, null, null, null, Enum.GetValues<CardKind>().Select(k => new MissingCard(k, MissingReason.NoFit)).ToList()), rejections);
        }

        var checker = new Checker(candidates, inputs, conditions, catalog, forbidden);

        ChooseCard? choose = null;
        if (candidates.ChooseBlocked is { } chooseBlocked)
        {
            missing.Add(new MissingCard(CardKind.Choose, chooseBlocked));
        }
        else if (!draft.Choose.Made)
        {
            // 候補はあるのに作らなかった。条件のせいではないので、照らし合わせに通らなかったときと同じ理由で返す
            rejections.Add(new CardRejection(CardKind.Choose, "notMade"));
            missing.Add(new MissingCard(CardKind.Choose, MissingReason.Rejected));
        }
        else if (checker.Choose(draft.Choose, out choose) is { } chooseRule)
        {
            rejections.Add(new CardRejection(CardKind.Choose, chooseRule));
            missing.Add(new MissingCard(CardKind.Choose, MissingReason.Rejected));
        }

        CombineCard? combine = null;
        if (candidates.CombineBlocked is { } combineBlocked)
        {
            missing.Add(new MissingCard(CardKind.Combine, combineBlocked));
        }
        else if (!draft.Combine.Made)
        {
            rejections.Add(new CardRejection(CardKind.Combine, "notMade"));
            missing.Add(new MissingCard(CardKind.Combine, MissingReason.Rejected));
        }
        else if (checker.Combine(draft.Combine, out combine) is { } combineRule)
        {
            rejections.Add(new CardRejection(CardKind.Combine, combineRule));
            missing.Add(new MissingCard(CardKind.Combine, MissingReason.Rejected));
        }

        CreateCard? create = null;
        if (!draft.Create.Made)
        {
            // 進める条件で、根拠の言葉のある使える力がいつもある。作らなかったのは AI の判断なので、本人の話が足りないとは返さない
            rejections.Add(new CardRejection(CardKind.Create, "notMade"));
            missing.Add(new MissingCard(CardKind.Create, MissingReason.Rejected));
        }
        else if (checker.Create(draft.Create, out create) is { } createRule)
        {
            rejections.Add(new CardRejection(CardKind.Create, createRule));
            missing.Add(new MissingCard(CardKind.Create, MissingReason.Rejected));
        }

        return (new OptionCards(now, basis, choose, combine, create, missing), rejections);
    }

    /// <summary>
    /// 保存したカードを、いまの記録で見せられるものだけにする。外した力、使えなくなった力、力の状態か根拠の言葉がいまの記録と合わなくなった力
    /// （<see cref="CardAbility.ProblemIn"/>）、いまの条件に収まらなくなった業務のカードは出さず、理由を <see cref="OptionCards.Missing"/> に足す。
    /// 業務の時間帯と幅は、いまの条件で計算し直す。
    /// </summary>
    public static OptionCards ForDisplay(OptionCards cards, OptionsInputs inputs, JobCatalog catalog)
    {
        var missing = cards.Missing.ToList();
        void Hide(CardKind kind, MissingReason reason)
        {
            missing.RemoveAll(m => m.Kind == kind);
            missing.Add(new MissingCard(kind, reason));
        }

        if (inputs.Conditions is not { } c)
        {
            foreach (var (kind, present) in new[]
            {
                (CardKind.Choose, cards.Choose is not null),
                (CardKind.Combine, cards.Combine is not null),
                (CardKind.Create, cards.Create is not null),
            })
            {
                if (present)
                {
                    Hide(kind, MissingReason.NoFit);
                }
            }

            return Sorted(cards with { Choose = null, Combine = null, Create = null }, missing);
        }

        var choose = cards.Choose;
        if (choose is not null)
        {
            if (choose.Ability.ProblemIn(inputs) is { } reason)
            {
                Hide(CardKind.Choose, reason);
                choose = null;
            }
            else if (Resolve(choose.Tasks, catalog) is not { } tasks)
            {
                Hide(CardKind.Choose, MissingReason.Rejected);
                choose = null;
            }
            else if (!tasks.All(t => ConditionFit.Fits(t, c)))
            {
                Hide(CardKind.Choose, MissingReason.NoFit);
                choose = null;
            }
            else
            {
                choose = choose with { Tasks = WithUsableSlots(choose.Tasks, tasks, c), Range = ConditionFit.ChooseRange(tasks, c) };
            }
        }

        var combine = cards.Combine;
        if (combine is not null)
        {
            if (combine.Ability.ProblemIn(inputs) is { } reason)
            {
                Hide(CardKind.Combine, reason);
                combine = null;
            }
            else if (Resolve(combine.Tasks, catalog) is not { } tasks)
            {
                Hide(CardKind.Combine, MissingReason.Rejected);
                combine = null;
            }
            else if (!ConditionFit.CombineFits(tasks, c))
            {
                Hide(CardKind.Combine, MissingReason.NoFit);
                combine = null;
            }
            else
            {
                combine = combine with { Tasks = WithUsableSlots(combine.Tasks, tasks, c), Range = ConditionFit.CombineRange(tasks, c) };
            }
        }

        var create = cards.Create;
        if (create is not null)
        {
            if (create.Ability.ProblemIn(inputs) is { } reason)
            {
                Hide(CardKind.Create, reason);
                create = null;
            }
            else if (!CreateFits(create, c))
            {
                Hide(CardKind.Create, MissingReason.NoFit);
                create = null;
            }
        }

        return Sorted(cards with { Choose = choose, Combine = combine, Create = create }, missing);
    }

    /// <summary>
    /// 選んだカードの写しが、いまの条件に収まるか（05-options.md の「本人が選ぶ」）。選んだ案は選んだときの中身のまま残すので、
    /// 条件を変えたあとに収まらなくなったことを、画面と 06 deepen が知らせるために使う。業務がいまの登録にないときも、収まらないとする。
    /// </summary>
    public static bool ChosenFits(OptionChoice choice, ProfileConditions conditions, JobCatalog catalog) => choice switch
    {
        { Choose: { } c } => Resolve(c.Tasks, catalog) is { } tasks && tasks.All(t => ConditionFit.Fits(t, conditions)),
        { Combine: { } c } => Resolve(c.Tasks, catalog) is { } tasks && ConditionFit.CombineFits(tasks, conditions),
        { Create: { } c } => CreateFits(c, conditions),
        _ => true,
    };

    private static bool CreateFits(CreateCard create, ProfileConditions c) =>
        create.HoursPerWeek <= c.HoursPerWeek
        && ConditionFit.PlaceFits(create.Place, c.Place)
        && create.TimeSlots.Count > 0
        && create.TimeSlots.All(c.TimeSlots.Contains);

    private static OptionCards Sorted(OptionCards cards, List<MissingCard> missing) =>
        cards with { Missing = missing.OrderBy(m => m.Kind).ToList() };

    /// <summary>カードの業務の時間帯を、いまの条件で本人の時間帯に入るものにする。<paramref name="tasks"/> は <paramref name="cardTasks"/> と同じ順の登録の業務。</summary>
    private static List<CardTask> WithUsableSlots(IReadOnlyList<CardTask> cardTasks, IReadOnlyList<JobTask> tasks, ProfileConditions c) =>
        cardTasks.Select((t, i) => t with { TimeSlots = ConditionFit.UsableSlots(tasks[i], c) }).ToList();

    private static List<JobTask>? Resolve(IReadOnlyList<CardTask> cardTasks, JobCatalog catalog)
    {
        var tasks = cardTasks.Select(t => catalog.FindTask(t.TaskId)).ToList();
        return tasks.Any(t => t is null) ? null : tasks.Select(t => t!).ToList();
    }

    /// <summary>1 回の照らし合わせの道具。規則に当たったら、その名前を返す。通ったら null を返し、カードを作る。</summary>
    private sealed class Checker(
        OptionCandidates candidates, OptionsInputs inputs, ProfileConditions conditions, JobCatalog catalog, ForbiddenWordList forbidden)
    {
        public string? Choose(ChooseDraft d, out ChooseCard? card)
        {
            card = null;
            var occupation = candidates.Occupations.FirstOrDefault(o => o.Id == d.OccupationId);
            var tasks = d.TaskIds.Select(id => candidates.Tasks.FirstOrDefault(t => t.Id == id)).ToList();
            if (occupation is null || tasks.Any(t => t is null))
            {
                return "unknownId";
            }

            var found = tasks.Select(t => t!).ToList();
            if (found.Any(t => occupation.Tasks.All(o => o.Id != t.Id)))
            {
                return "wrongOccupation";
            }

            if (found.Count is < 1 or > MaxTasksPerCard || found.Select(t => t.Id).Distinct().Count() != found.Count)
            {
                return "taskCount";
            }

            if (UsableAbilityOf(d.Ability) is not { } ability)
            {
                return "abilityNotUsable";
            }

            if (found.All(t => t.Ability != ability.Ability))
            {
                return "abilityNotInTasks";
            }

            if (TextProblem([(d.Reason, MaxReason)], d.Reason, [], ability.Quotes) is { } problem)
            {
                return problem;
            }

            card = new ChooseCard(
                occupation.Id,
                occupation.Name,
                occupation.Summary,
                found.Select(CardTaskOf).ToList(),
                ConditionFit.ChooseRange(found, conditions),
                d.Reason.Trim(),
                new CardAbility(ability.Ability, ability.State, ability.Quotes));
            return null;
        }

        public string? Combine(CombineDraft d, out CombineCard? card)
        {
            card = null;
            var tasks = d.TaskIds.Select(id => candidates.Tasks.FirstOrDefault(t => t.Id == id)).ToList();
            if (tasks.Any(t => t is null))
            {
                return "unknownId";
            }

            var found = tasks.Select(t => t!).ToList();
            if (found.Count is < MinCombineTasks or > MaxTasksPerCard || found.Select(t => t.Id).Distinct().Count() != found.Count)
            {
                return "taskCount";
            }

            if (found.Select(t => catalog.OccupationOf(t).Id).Distinct().Count() < 2)
            {
                return "singleOccupation";
            }

            if (!ConditionFit.CombineFits(found, conditions))
            {
                return "overHours";
            }

            if (UsableAbilityOf(d.Ability) is not { } ability)
            {
                return "abilityNotUsable";
            }

            if (found.All(t => t.Ability != ability.Ability))
            {
                return "abilityNotInTasks";
            }

            if (TextProblem([(d.RoleName, MaxRoleName), (d.Reason, MaxReason)], d.Reason, [d.RoleName], ability.Quotes) is { } problem)
            {
                return problem;
            }

            card = new CombineCard(
                d.RoleName.Trim(),
                found.Select(CardTaskOf).ToList(),
                ConditionFit.CombineRange(found, conditions),
                d.Reason.Trim(),
                new CardAbility(ability.Ability, ability.State, ability.Quotes));
            return null;
        }

        public string? Create(CreateDraft d, out CreateCard? card)
        {
            card = null;
            if (UsableAbilityOf(d.Ability) is not { } ability)
            {
                return "abilityNotUsable";
            }

            var drawn = new List<Evidence>();
            if (d.Quotes.Count is < 1 or > MaxCreateQuotes)
            {
                return "quoteNotVerbatim";
            }

            foreach (var quote in d.Quotes)
            {
                var trimmed = quote.Trim();
                var match = ability.Quotes.FirstOrDefault(e => trimmed.Length > 0 && string.Equals(e.Quote.Trim(), trimmed, StringComparison.Ordinal));
                if (match is null)
                {
                    return "quoteNotVerbatim";
                }

                if (!drawn.Contains(match))
                {
                    drawn.Add(match);
                }
            }

            if (d.HoursPerWeek < 1 || d.HoursPerWeek > conditions.HoursPerWeek)
            {
                return "overHours";
            }

            if (d.Place is not ("home" or "out") || !ConditionFit.PlaceFits(d.Place == "out" ? TaskPlace.Out : TaskPlace.Home, conditions.Place))
            {
                return "outsideConditions";
            }

            var slots = new List<TimeSlot>();
            foreach (var name in d.TimeSlots)
            {
                if (SlotOf(name) is not { } slot || !conditions.TimeSlots.Contains(slot))
                {
                    return "outsideConditions";
                }

                if (!slots.Contains(slot))
                {
                    slots.Add(slot);
                }
            }

            if (slots.Count == 0)
            {
                return "outsideConditions";
            }

            // 理由が引いてよいのは、カードに添える根拠の言葉（引いた言葉）だけ。添えない言葉は、あとで記録が変わっても見張れないため
            if (TextProblem(
                [(d.Title, MaxTitle), (d.Who, MaxWho), (d.Trouble, MaxTrouble), (d.Summary, MaxCreateSummary), (d.Reason, MaxReason)],
                d.Reason,
                [d.Title, d.Who, d.Trouble, d.Summary],
                drawn) is { } problem)
            {
                return problem;
            }

            card = new CreateCard(
                d.Title.Trim(),
                d.Who.Trim(),
                d.Trouble.Trim(),
                d.Summary.Trim(),
                d.HoursPerWeek,
                d.Place == "out" ? TaskPlace.Out : TaskPlace.Home,
                slots.Order().ToList(),
                d.Reason.Trim(),
                new CardAbility(ability.Ability, ability.State, drawn));
            return null;
        }

        private UsableAbility? UsableAbilityOf(string key) =>
            ActionRef.TryParseAbility(key, out var ability) ? inputs.Abilities.FirstOrDefault(a => a.Ability == ability) : null;

        private CardTask CardTaskOf(JobTask task)
        {
            var occupation = catalog.OccupationOf(task);
            return new CardTask(
                task.Id, occupation.Id, occupation.Name, task.Name, task.Detail, task.Ability,
                ConditionFit.UsableSlots(task, conditions), task.Place, task.Knowledge);
        }

        /// <summary>
        /// 空、長すぎる、使わない言葉、言い切りと順位の言葉、褒め言葉、お金の額、理由のほかの文の括弧、理由の「」のほかの括弧、
        /// 「」なしで写した根拠の言葉、理由の「」の言葉（カードに添える根拠の言葉の一部を一字一句そのまま引いていない、短すぎる）、
        /// の順に見て、当たった規則の名前を返す。
        /// <paramref name="others"/> は理由のほかの、AI が書いた文。<paramref name="evidence"/> はカードに添える根拠の言葉（<see cref="CardAbility.Quotes"/>）。
        /// 理由の「」をこれに限るのは、作ったあとで見せてよいかを確かめる <see cref="CardAbility.ProblemIn"/> が見張るのが、この言葉だけだから。
        /// ほかの力の言葉を引けると、その力の場面を確かめに使わなくなったあとも、理由に言葉が残る（製品の芯 1）。
        /// </summary>
        private string? TextProblem(IEnumerable<(string Text, int Max)> limits, string reason, IReadOnlyList<string> others, IReadOnlyList<Evidence> evidence)
        {
            foreach (var (text, max) in limits)
            {
                var trimmed = text.Trim();
                if (!ProfileEndpoints.HasVisibleText(trimmed))
                {
                    return "empty";
                }

                if (!ProfileEndpoints.FitsIn(trimmed, max, max * Utf16Factor))
                {
                    return "tooLong";
                }
            }

            List<string> all = [reason, .. others];
            if (all.Any(s => forbidden.FirstIn(s) is not null))
            {
                return "forbiddenWord";
            }

            if (all.Any(s => AssertiveIn(s) is not null))
            {
                return "assertiveWord";
            }

            if (all.Any(s => PraiseIn(s) is not null))
            {
                return "praiseWord";
            }

            if (all.Any(HasMoneyAmount))
            {
                return "moneyAmount";
            }

            // 根拠の言葉を引いてよいのは理由だけ。選んだあとで力を外したとき、理由は出さなくなるが、ほかの文は案の中身として残るため
            if (others.Any(s => s.IndexOfAny(QuoteMarks) >= 0))
            {
                return "bracketOutsideReason";
            }

            // 理由で使える括弧は、閉じた「」だけ。『』や “” で引くと、カードの力の根拠に限る照らし合わせを抜けられるため
            if (BracketPattern().Replace(reason, "").IndexOfAny(QuoteMarks) >= 0)
            {
                return "bracketKind";
            }

            // 根拠の言葉を「」なしで写さない。理由のほかの文は、選んだあとで力を外したり場面を飛ばしたりしても案の中身として残るので、
            // どの力の根拠の言葉も写させない。理由の「」の外は、カードに添える根拠の言葉のほかを写させない（must: 05-options.md の「AI が書いた中身をコードで確かめる」）
            var own = WordsOf(evidence).ToList();
            var usable = WordsOf(inputs.Abilities.SelectMany(a => a.Quotes)).ToList();
            if (others.Any(s => CopiesWords(s, usable, []))
                || CopiesWords(BracketPattern().Replace(reason, ""), usable.Where(w => !own.Contains(w)), own))
            {
                return "evidenceCopied";
            }

            var words = own;
            foreach (Match match in BracketPattern().Matches(reason))
            {
                var inside = match.Groups[1].Value;
                if (inside.Length == 0 || !words.Any(w => w.Contains(inside, StringComparison.Ordinal)))
                {
                    return "bracketNotVerbatim";
                }

                // 根拠として使える言葉と同じ下限。「家族」だけのような切り取りでは、何の話か分からないため（Claude の判断）
                if (EvidenceChecker.Letters(inside) < EvidenceChecker.MinQuoteLetters)
                {
                    return "bracketTooShort";
                }
            }

            return null;
        }

        private static TimeSlot? SlotOf(string name) => name switch
        {
            "morning" => TimeSlot.Morning,
            "daytime" => TimeSlot.Daytime,
            "evening" => TimeSlot.Evening,
            "night" => TimeSlot.Night,
            _ => null,
        };
    }
}
