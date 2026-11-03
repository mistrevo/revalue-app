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
    public static readonly IReadOnlyList<string> AssertiveWords = ["向いています", "向いている", "ぴったり", "最適", "いちばん", "一番", "おすすめ", "お勧め", "最も"];

    [GeneratedRegex("「([^」]*)」")]
    private static partial Regex BracketPattern();

    /// <summary>文の中の、最初に見つかった言い切りと順位の言葉。「」の中は除いて探す。なければ null。</summary>
    public static string? AssertiveIn(string text)
    {
        var outside = BracketPattern().Replace(text, "");
        return AssertiveWords.FirstOrDefault(word => outside.Contains(word, StringComparison.Ordinal));
    }

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
            rejections.Add(new CardRejection(CardKind.Create, "notMade"));
            missing.Add(new MissingCard(CardKind.Create, MissingReason.NoEvidence));
        }
        else if (checker.Create(draft.Create, out create) is { } createRule)
        {
            rejections.Add(new CardRejection(CardKind.Create, createRule));
            missing.Add(new MissingCard(CardKind.Create, MissingReason.Rejected));
        }

        return (new OptionCards(now, basis, choose, combine, create, missing), rejections);
    }

    /// <summary>
    /// 保存したカードを、いまの記録で見せられるものだけにする。外した力、使えなくなった力、いまの条件に収まらなくなった業務のカードは出さず、
    /// 理由を <see cref="OptionCards.Missing"/> に足す。業務の時間帯と幅は、いまの条件で計算し直す。力の状態と根拠は保存したまま出す。
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
            if (AbilityProblem(choose.Ability, inputs) is { } reason)
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
            if (AbilityProblem(combine.Ability, inputs) is { } reason)
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
            if (AbilityProblem(create.Ability, inputs) is { } reason)
            {
                Hide(CardKind.Create, reason);
                create = null;
            }
            else if (create.HoursPerWeek > c.HoursPerWeek
                || !ConditionFit.PlaceFits(create.Place, c.Place)
                || create.TimeSlots.Count == 0
                || !create.TimeSlots.All(c.TimeSlots.Contains))
            {
                Hide(CardKind.Create, MissingReason.NoFit);
                create = null;
            }
        }

        return Sorted(cards with { Choose = choose, Combine = combine, Create = create }, missing);
    }

    private static OptionCards Sorted(OptionCards cards, List<MissingCard> missing) =>
        cards with { Missing = missing.OrderBy(m => m.Kind).ToList() };

    private static MissingReason? AbilityProblem(CardAbility ability, OptionsInputs inputs) =>
        inputs.Excluded.Contains(ability.Ability) ? MissingReason.Excluded
        : inputs.Abilities.Any(a => a.Ability == ability.Ability) ? null
        : MissingReason.Rejected;

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
        private readonly List<string> _evidenceWords = inputs.Abilities
            .SelectMany(a => a.Quotes)
            .SelectMany(q => new[] { q.Quote, q.LinkedQuote })
            .Where(w => !string.IsNullOrEmpty(w))
            .Select(w => w!)
            .ToList();

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

            if (TextProblem([(d.Reason, MaxReason)], [d.Reason]) is { } problem)
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

            if (TextProblem([(d.RoleName, MaxRoleName), (d.Reason, MaxReason)], [d.RoleName, d.Reason]) is { } problem)
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

            var sentences = new[] { d.Title, d.Who, d.Trouble, d.Summary, d.Reason };
            if (TextProblem(
                [(d.Title, MaxTitle), (d.Who, MaxWho), (d.Trouble, MaxTrouble), (d.Summary, MaxCreateSummary), (d.Reason, MaxReason)],
                sentences) is { } problem)
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

        /// <summary>空、長すぎる、使わない言葉、言い切りと順位の言葉、本人の根拠にない「」の言葉、の順に見て、当たった規則の名前を返す。</summary>
        private string? TextProblem(IEnumerable<(string Text, int Max)> limits, IEnumerable<string> sentences)
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

            var all = sentences.ToList();
            if (all.Any(s => forbidden.FirstIn(s) is not null))
            {
                return "forbiddenWord";
            }

            if (all.Any(s => AssertiveIn(s) is not null))
            {
                return "assertiveWord";
            }

            foreach (var sentence in all)
            {
                foreach (Match match in BracketPattern().Matches(sentence))
                {
                    var inside = match.Groups[1].Value;
                    if (inside.Length == 0 || !_evidenceWords.Any(w => w.Contains(inside, StringComparison.Ordinal)))
                    {
                        return "bracketNotVerbatim";
                    }
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
