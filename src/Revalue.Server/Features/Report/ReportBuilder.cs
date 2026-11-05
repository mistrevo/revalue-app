using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Revalue.Server.Data;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Report;

/// <summary>
/// 可能性レポートの中身を、いまの記録から組み立てる（07-report.md の「まとめる中身」）。AI は呼ばない。
/// まとめるだけで、新しい見立てや言い切りの文は作らない（report-4（決めつけない））。
/// </summary>
public static class ReportBuilder
{
    /// <summary>話し終えた場面がなければ <c>(false, null)</c>。案を選んでいなくても、保留していても組み立てる（report-5（保留しても開ける））。</summary>
    public static async Task<(bool Ready, ReportContent? Content, bool AbilitiesExcluded)> BuildAsync(
        IDataStore store, string userKey, JobCatalog catalog, CancellationToken ct)
    {
        var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
        if (!episodes.Any(e => e.Status == EpisodeStatus.Finished))
        {
            return (false, null, false);
        }

        var book = await store.GetAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);
        var profile = await store.GetAsync<ProfileItem>(userKey, ProfileItem.ItemId, ct);
        var options = await store.GetAsync<OptionsItem>(userKey, OptionsItem.ItemId, ct);
        var deepen = await store.GetAsync<DeepenItem>(userKey, DeepenItem.ItemId, ct);

        var views = AbilityBook.View(episodes, book);
        var inputs = OptionsInputsReader.From(profile, episodes, views, book);
        var (_, target) = DeepenTargetReader.From(options, inputs.Conditions, catalog);
        // 深めた中身は、いまの選んだ案のものだけを使う（選び直したあとの古い中身は出さない）
        var deepened = target is not null && deepen?.Content is { } c && c.Basis == target.Basis ? c : null;

        var abilities = views
            .Where(v => !v.Excluded && ShownInAbilities(v))
            .Select(v => new ReportAbility(v.Ability, v.State, v.Shown))
            .ToList();

        var content = new ReportContent(
            abilities,
            NotYet(views, target, deepened, inputs),
            new ReportRecords(profile?.Preferences ?? [], profile?.Wants ?? [], profile?.Conditions, profile?.Agency),
            Choice(options, inputs, catalog),
            deepened is null ? null : Thinking(deepened, deepen!),
            deepened is null ? null : Steps(deepened, deepen!, target!, inputs.Conditions!));
        // 外していなければ「できること」の欄に出ていた力を、本人が外しているか（欄が空のときに添える一言のため。版には残さない）
        return (true, content, views.Any(v => v.Excluded && ShownInAbilities(v)));
    }

    /// <summary>「できること」の欄に出る力か（外していなければ）: 根拠ありか確かめ中で、見せる根拠がある。</summary>
    private static bool ShownInAbilities(AbilityView v) =>
        v.State is AbilityState.Confirmed or AbilityState.NeedsCheck && v.Shown.Count > 0;

    /// <summary>
    /// 欄ごとの指紋。画面に出す中身を決まった順の JSON にして SHA-256 の 16 進にする。根拠の言葉も入れる（根拠の言葉だけが変わったときも、
    /// 変わった欄が分かるように）。根拠は画面に出す中身（言葉、選んだ答えか、結びついた言葉）だけを入れ、読み取りの番号などは入れない。
    /// 元に戻せない値なので、版に残してよい。
    /// </summary>
    public static IReadOnlyDictionary<ReportSection, string> SectionHashes(ReportContent content) =>
        new Dictionary<ReportSection, string>
        {
            [ReportSection.Abilities] = Fingerprint(content.Abilities.Select(Canonical)),
            [ReportSection.NotYet] = Fingerprint(content.NotYet),
            [ReportSection.Records] = Fingerprint(new
            {
                preferences = content.Records.Preferences,
                wants = content.Records.Wants,
                conditions = content.Records.Conditions is { } c
                    ? new { timeSlots = c.TimeSlots.Distinct().Order(), c.HoursPerWeek, c.Place, c.MonthlyIncome }
                    : null,
                agency = content.Records.Agency,
            }),
            [ReportSection.Choice] = Fingerprint(new
            {
                choice = content.Choice with { Ability = null },
                ability = content.Choice.Ability is { } a ? Canonical(a) : null,
            }),
            [ReportSection.Thinking] = Fingerprint(content.Thinking),
            [ReportSection.Steps] = Fingerprint(content.Steps),
        };

    /// <summary>全体の指紋。欄の順に、欄の名前と指紋をつないで SHA-256 の 16 進にする。</summary>
    public static string Hash(IReadOnlyDictionary<ReportSection, string> sections) =>
        Sha256(string.Join("\n", Enum.GetValues<ReportSection>().Select(s => $"{s}={sections[s]}")));

    private static ReportNotYet NotYet(
        IReadOnlyList<AbilityView> views, DeepenTarget? target, DeepenContent? deepened, OptionsInputs inputs)
    {
        var checking = views.Where(v => !v.Excluded && v.State == AbilityState.NeedsCheck).Select(v => v.Ability).ToList();

        // 業務は、いまの選んだ案のものだけ。「創る」と本人が書いた仕事の見立ての業務は、深めた中身があるときだけ（保留中とまだ選んでいないときは空）
        IReadOnlyList<TaskLight> lights = target is null ? []
            : deepened is not null ? DeepenLighting.Light(target, deepened, inputs)
            : target.Drafts ? []
            : DeepenLighting.Light(target, null, inputs);

        var hasExcluded = false;
        var gaps = new List<ReportTaskGap>();
        foreach (var light in lights)
        {
            // まだ確かめていない力は主な力だけ（補助の力は並べない）。準備中の力と辞書から消えた力は名前を出さない
            Ability? ability = null;
            if (!light.MainUsable && AbilityCatalog.IsActive(light.Ability))
            {
                if (inputs.Excluded.Contains(light.Ability))
                {
                    // 外した力の名前は出さず、外した見立てはここに出していないとだけ伝える
                    hasExcluded = true;
                }
                else
                {
                    ability = light.Ability;
                }
            }

            var knowledge = light.Knowledge.Where(k => !string.IsNullOrWhiteSpace(k)).ToList();
            var checks = light.Checks.Where(c => !string.IsNullOrWhiteSpace(c)).ToList();
            if (ability is not null || knowledge.Count > 0 || checks.Count > 0)
            {
                gaps.Add(new ReportTaskGap(light.Name, ability, knowledge, checks));
            }
        }

        return new ReportNotYet(checking, gaps, hasExcluded);
    }

    private static ReportChoice Choice(OptionsItem? options, OptionsInputs inputs, JobCatalog catalog)
    {
        var cardsStale = options?.Cards is { } cards && cards.Basis != OptionsInputsReader.Basis(inputs);
        var none = new ReportChoice(null, null, null, null, [], null, null, null, false, false, cardsStale, []);

        switch (options?.Choice)
        {
            case null:
                return none;

            case { Kind: ChoiceKind.Hold }:
                return none with { Kind = ChoiceKind.Hold };

            case { Kind: ChoiceKind.Own, OwnJobId: { } id }:
                return options.OwnJobs.FirstOrDefault(j => j.Id == id) is { } own
                    ? none with { Kind = ChoiceKind.Own, Title = own.Title, Summary = own.Note }
                    : none;

            case { Kind: ChoiceKind.Card, Card: { } kind } choice:
                var problem = choice.AbilityProblem(inputs);
                var outside = inputs.Conditions is { } conditions && !OptionsValidator.ChosenFits(choice, conditions, catalog);
                var (title, summary, cardTasks, reason) = choice switch
                {
                    { Choose: { } c } => (c.OccupationName, (string?)c.Summary, c.Tasks, c.Reason),
                    { Combine: { } c } => (c.RoleName, null, c.Tasks, c.Reason),
                    { Create: { } c } => (c.Title, CreateSummary(c), [], c.Reason),
                    _ => (null as string, null as string, (IReadOnlyList<CardTask>)[], null as string),
                };
                if (title is null)
                {
                    return none;
                }

                var ability = problem is null && choice.ChosenAbility() is { } a ? new ReportAbility(a.Ability, a.State, a.Quotes) : null;
                return new ReportChoice(
                    ChoiceKind.Card, kind, title, summary, cardTasks.Select(t => t.Name).ToList(),
                    problem is null ? reason : null, ability, problem, outside, kind == CardKind.Create, cardsStale,
                    ability is null ? [] : Scenes(cardTasks, ability.Ability, catalog));

            default:
                return none;
        }
    }

    /// <summary>
    /// 選んだ案の業務のうち、カードに使った力を主な力に持つ業務の力が生きる場面（05-options.md の options-10（力が生きる場面を添える）と同じ決め方）。
    /// 業務の名前はカードの写しの名前で、場面はいまの業務マスターから引く。話から確かめる力でない力（保存データの古い id など）なら添えない。
    /// </summary>
    private static List<ReportScene> Scenes(IReadOnlyList<CardTask> tasks, Ability ability, JobCatalog catalog) =>
        AbilityCatalog.IsActive(ability)
            ? tasks
                .Select(t => (Card: t, Registered: catalog.FindTask(t.TaskId)))
                .Where(x => x.Registered is { } r && r.Abilities.Main == ability)
                .Select(x => new ReportScene(x.Card.Name, x.Registered!.Scene))
                .ToList()
            : [];

    /// <summary>
    /// 「創る」の誰の、困りごと、中身をつないだ文。言葉を足さずに、読点と句点だけでつなぐ（言い切りの言葉を入れないため。Claude の判断）。
    /// </summary>
    private static string CreateSummary(CreateCard card) => $"{card.Who}、{card.Trouble}。{card.Summary}";

    /// <summary>答えのある問いだけ、問いの順に。</summary>
    private static List<ReportThought> Thinking(DeepenContent content, DeepenItem item) =>
        content.Questions
            .Select(q => (Question: q, Answer: item.Answers.FirstOrDefault(a => a.QuestionId == q.Id)))
            .Where(x => x.Answer is not null)
            .Select(x => new ReportThought(x.Question.Situation, x.Answer!.Text, x.Answer.FromChoice))
            .ToList();

    /// <summary>選んだ候補（06 で画面に出す順）と、書いた一歩。</summary>
    private static List<ReportStep> Steps(DeepenContent content, DeepenItem item, DeepenTarget target, ProfileConditions conditions) =>
        [
            .. DeepenSteps.Visible(content, item.ChosenStepIds, target.Kind, conditions)
                .Where(v => v.Chosen)
                .Select(v => new ReportStep(v.Step.Text, false, v.Fits)),
            .. item.OwnSteps.Select(text => new ReportStep(text, true, true)),
        ];

    private static object Canonical(ReportAbility ability) => new
    {
        ability = ability.Ability,
        state = ability.State,
        quotes = ability.Quotes.Select(q => new { quote = q.Quote, fromChoice = q.FromChoice, linkedQuote = q.LinkedQuote }),
    };

    private static string Fingerprint(object? value) => Sha256(JsonSerializer.Serialize(value, DataConstants.Json));

    private static string Sha256(string text) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(text))).ToLowerInvariant();
}
