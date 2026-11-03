using Revalue.Evals;
using Revalue.Server.Ai;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

/// <summary>05 options（仕事の選択肢）の評価の仕組みのうち、Claude を呼ばずに確かめられるところ。</summary>
public sealed class OptionsEvalTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly JobCatalog Catalog = JobCatalog.Load();

    private static string ProfilesDir => Path.Combine(AppContext.BaseDirectory, "profiles");

    private static ForbiddenWords Forbidden() => ForbiddenWords.Load(Path.Combine(AppContext.BaseDirectory, "forbidden-words.json"));

    private static ProfileCase Case(string id) => ProfileCase.LoadAll(ProfilesDir).Single(c => c.Id == id);

    /// <summary>偽物（<see cref="ScriptedOptionsAi"/>）の答えを変える AI。</summary>
    private sealed class ChangedAi(Func<OptionsDraft, OptionsDraft> change) : IOptionsAi
    {
        public async Task<OptionsDraft> DraftAsync(OptionsInputs inputs, OptionCandidates candidates, CancellationToken ct) =>
            change(await new ScriptedOptionsAi().DraftAsync(inputs, candidates, ct));
    }

    private static OptionsEval Eval(IOptionsAi ai) =>
        new(ai, new DryRunOptionsJudge(), new DryRunGenericAssistant(), new DryRunGenericOptionsReader(), Catalog, Forbidden());

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 評価は、照らし合わせの前に登録にない ID を返した数を数える")]
    public async Task CountsUnregisteredBeforeValidation()
    {
        var ai = new ChangedAi(d => d with { Choose = d.Choose with { OccupationId = "no-such-occupation" } });

        var run = await Eval(ai).RunAsync(Case("p01-coordinating-seen"), Ct);

        Assert.Null(run.Error);
        Assert.Equal(1, run.Before.Unregistered);
        Assert.Equal(0, run.Before.OverConditions);
        Assert.Null(run.Cards!.Choose);
        Assert.All(run.Shown, s => Assert.False(s.Unregistered));
        Assert.Contains(new CardRejection(CardKind.Choose, "unknownId"), run.Rejections);

        var summary = OptionsSummary.From([run]);
        Assert.Equal(1, summary.Reference.Single(i => i.Name.StartsWith("照らし合わせの前: 登録していない職種", StringComparison.Ordinal)).Count);
        var gated = summary.Gated.Single(i => i.Name.StartsWith("options-2（選ぶは登録した職種から）", StringComparison.Ordinal));
        Assert.Equal((0, true), (gated.Count, gated.Passed));
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 評価は、条件を超える案を照らし合わせの前とあとで分けて数える")]
    public async Task CountsOverConditionsBeforeAndAfter()
    {
        // 創るの時間を本人の時間より多くし、選ぶには登録にあるが条件に合わない（外に出る）業務を返す
        var ai = new ChangedAi(d => d with
        {
            Create = d.Create with { HoursPerWeek = 99 },
            Choose = d.Choose with { OccupationId = "accounting-clerk", TaskIds = ["accounting-cash"] },
        });

        var run = await Eval(ai).RunAsync(Case("p01-coordinating-seen"), Ct);

        Assert.Equal(2, run.Before.OverConditions);
        Assert.Equal(0, run.Before.Unregistered);
        Assert.Null(run.Cards!.Create);
        Assert.Null(run.Cards.Choose);
        Assert.All(run.Shown, s => Assert.False(s.OverConditions));

        var summary = OptionsSummary.From([run]);
        Assert.Equal(2, summary.Reference.Single(i => i.Name.StartsWith("照らし合わせの前: 条件を超える案", StringComparison.Ordinal)).Count);
        Assert.Equal(0, summary.Gated.Single(i => i.Name.StartsWith("options-5（条件の範囲だけ）", StringComparison.Ordinal)).Count);
    }

    [Fact(DisplayName = "options-5（条件の範囲だけ）: 評価は、画面に出すカードが条件を超えていたら数え直して合格にしない")]
    public void RecountsShownCards()
    {
        var c = Case("p01-coordinating-seen");
        var conditions = c.Inputs.Conditions!;
        var ability = new CardAbility(Ability.Coordinating, AbilityState.Confirmed, c.Inputs.Abilities[0].Quotes);
        // 照らし合わせを通らずに作ったカード（週 99 時間、外に出る、本人の根拠にない引用）
        var create = new CreateCard("題", "誰の", "困りごと", "中身", 99, TaskPlace.Out, conditions.TimeSlots, "理由です。「本人が言っていない言葉」",
            ability with { Quotes = [new Evidence(Ability.Coordinating, 1, "本人が言っていない言葉", 1, 1, false, false, null)] });

        var check = OptionsEval.CheckShown(create, c.Inputs, Catalog, Forbidden());

        Assert.True(check.OverConditions);
        Assert.True(check.NoEvidence);
        Assert.NotEmpty(check.QuoteMismatches);
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 架空の 5 つの記録は 8 件読み込め、根拠の言葉はどれも架空エピソードの本人の答えに一字一句含まれる")]
    public void RepositoryProfilesParse()
    {
        var cases = ProfileCase.LoadAll(ProfilesDir);

        Assert.Equal(
            ["p01-coordinating-seen", "p02-checking-only", "p03-tight-conditions", "p04-can-go-out", "p05-high-income", "p06-excluded", "p07-three-seen", "p08-choice-linked"],
            cases.Select(c => c.Id));
        Assert.All(cases, c =>
        {
            Assert.NotNull(c.Inputs.Conditions);
            Assert.True(c.Inputs.HasFinishedEpisode);
            Assert.NotEmpty(c.Inputs.Abilities);
            Assert.Equal(Readiness.Ready, OptionsInputsReader.Check(c.Inputs));
        });

        var episodes = Path.Combine(AppContext.BaseDirectory, "episodes");
        var answers = EpisodeScript.LoadAll(episodes, "discover").Concat(EpisodeScript.LoadAll(episodes, "validate"))
            .SelectMany(s => s.Answers).Select(a => a.Text).ToList();
        foreach (var quote in cases.SelectMany(c => c.Inputs.Abilities).SelectMany(a => a.Quotes))
        {
            Assert.Contains(answers, a => a.Contains(quote.Quote, StringComparison.Ordinal));
            if (quote.LinkedQuote is { } linked)
            {
                Assert.Contains(answers, a => a.Contains(linked, StringComparison.Ordinal));
            }
        }

        // 根拠ありの力がまだない人の例と、外した力がある例、選んだ答えの根拠がある例がある
        Assert.All(cases.Where(c => c.Id is "p02-checking-only" or "p06-excluded"), c => Assert.All(c.Inputs.Abilities, a => Assert.Equal(AbilityState.NeedsCheck, a.State)));
        Assert.NotEmpty(Case("p06-excluded").Inputs.Excluded);
        Assert.Contains(Case("p08-choice-linked").Inputs.Abilities.SelectMany(a => a.Quotes), q => q.FromChoice && q.LinkedQuote is not null);
        Assert.Equal(3, Case("p07-three-seen").Inputs.Abilities.Count);
        foreach (var file in Directory.GetFiles(ProfilesDir, "p*.json"))
        {
            Assert.Contains("すべて架空", File.ReadAllText(file));
        }
    }

    [Fact(DisplayName = "options-1（3 枚を同じ重さで示す）: 偽物の AI で流すと、どの記録も途中で終えず、結果のファイルに呼び名とカードを書く")]
    public async Task DryRunOverAllProfiles()
    {
        var eval = Eval(new ScriptedOptionsAi());
        var runs = new List<OptionsRun>();
        foreach (var c in ProfileCase.LoadAll(ProfilesDir))
        {
            runs.Add(await eval.RunAsync(c, Ct));
        }

        Assert.All(runs, r => Assert.Null(r.Error));
        // 週 1 時間、夜だけの人には、選ぶと組み合わせるの候補がない
        var tight = runs.Single(r => r.Case.Id == "p03-tight-conditions");
        Assert.False(tight.Candidates.CanChoose);
        Assert.Contains(new MissingCard(CardKind.Choose, MissingReason.NoFit), tight.Cards!.Missing);
        // 外にも出られる人には、外に出る業務も候補に入る
        Assert.Contains(runs.Single(r => r.Case.Id == "p04-can-go-out").Candidates.Tasks, t => t.Place == TaskPlace.Out);

        var summary = OptionsSummary.From(runs);
        Assert.True(summary.Passed);
        Assert.NotNull(summary.Comparison);

        var report = OptionsReport.Write(new ReportContext("options", "claude-opus-5-5", DryRun: true, DateTimeOffset.Parse("2026-11-03T12:00:00+09:00")), runs, summary, new UsageMeter());
        foreach (var name in new[] { "options-2（選ぶは登録した職種から）", "options-4（創るは根拠を引けるときだけ）", "options-5（条件の範囲だけ）", "options-7（1 場面で進める）", "options-8（理由は本人の言葉とつなぐ）" })
        {
            Assert.Contains(name, report);
        }

        Assert.Contains("p03-tight-conditions", report);
        Assert.Contains(ScriptedOptionsAi.RoleName, report);
        Assert.Contains("dry-run", report);
        Assert.Contains(OptionsEval.GenericQuestion, report);
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 評価は、根拠ありの力がまだない人でカードが確かめ中と示されなければ合格にしない")]
    public async Task NeedsCheckCasesMustShowCheckingCards()
    {
        // 確かめ中の人のカードを、どれも作らない AI
        var ai = new ChangedAi(d => d with
        {
            Choose = d.Choose with { Made = false },
            Combine = d.Combine with { Made = false },
            Create = d.Create with { Made = false },
        });

        var run = await Eval(ai).RunAsync(Case("p02-checking-only"), Ct);
        var summary = OptionsSummary.From([run]);

        var gated = summary.Gated.Single(i => i.Name.StartsWith("options-7（1 場面で進める）", StringComparison.Ordinal));
        Assert.Equal((1, false), (gated.Count, gated.Passed));
        Assert.False(summary.Passed);
    }

    [Fact(DisplayName = "評価: 判定役が「本人の代わりに決めた」としたカードがあれば合格にせず、答えられなかったカードも問題として数える")]
    public async Task JudgeDecidesFailsTheRun()
    {
        var judge = new FixedJudge(new CardVerdict(Decides: true, OverPraise: false, PushesAway: false, Grounded: true, "言い切っている"));
        var eval = new OptionsEval(new ScriptedOptionsAi(), judge, new DryRunGenericAssistant(), new DryRunGenericOptionsReader(), Catalog, Forbidden());

        var summary = OptionsSummary.From([await eval.RunAsync(Case("p01-coordinating-seen"), Ct)]);
        Assert.False(summary.Passed);
        Assert.Equal(3, summary.Gated.Single(i => i.Name.StartsWith("本人の代わりに決める", StringComparison.Ordinal)).Count);

        var silent = new OptionsEval(new ScriptedOptionsAi(), new FixedJudge(null), new DryRunGenericAssistant(), new DryRunGenericOptionsReader(), Catalog, Forbidden());
        var silentSummary = OptionsSummary.From([await silent.RunAsync(Case("p01-coordinating-seen"), Ct)]);
        Assert.Equal(3, silentSummary.Gated.Single(i => i.Name.StartsWith("突き放し", StringComparison.Ordinal)).Count);
    }

    [Fact(DisplayName = "評価: 汎用の AI との比較は、条件を超える案、言い切り、順位、本人の言葉にない引用を数え、合格の線には入れない")]
    public async Task GenericComparisonCounts()
    {
        var reader = new FixedGenericReader(new GenericOptionsReading(
            [
                new GenericOption("在宅の事務", OverConditions: false, Decides: true, Ranked: true, ["両方の家に順番に声をかけて"]),
                new GenericOption("現地の受付", OverConditions: true, Decides: false, Ranked: true, ["本人が言っていない言葉"]),
            ],
            ""));
        var eval = new OptionsEval(new ScriptedOptionsAi(), new DryRunOptionsJudge(), new DryRunGenericAssistant(), reader, Catalog, Forbidden());

        var summary = OptionsSummary.From([await eval.RunAsync(Case("p01-coordinating-seen"), Ct)]);

        var comparison = summary.Comparison!;
        Assert.Equal((2, 1, 1, 2, 2, 1), (comparison.GenericOptions, comparison.GenericOverConditions, comparison.GenericDecides, comparison.GenericRanked, comparison.GenericQuotes, comparison.GenericQuoteMismatches));
        Assert.True(summary.Passed);
        Assert.Contains(OptionsEval.GenericQuestion, OptionsEval.GenericPrompt(Case("p01-coordinating-seen").Inputs));
    }

    [Fact(DisplayName = "評価: 判定役の指示に、判定役の答えの項目がすべて書いてある")]
    public void JudgePromptsNameFields()
    {
        var judges = Path.Combine(AppContext.BaseDirectory, "judges");
        var options = File.ReadAllText(Path.Combine(judges, "options.md"));
        foreach (var field in new[] { "decides", "overPraise", "pushesAway", "grounded", "reason" })
        {
            Assert.Contains($"`{field}`", options);
        }

        var generic = File.ReadAllText(Path.Combine(judges, "generic-options.md"));
        foreach (var field in new[] { "options", "title", "overConditions", "decides", "ranked", "quotes", "reason" })
        {
            Assert.Contains($"`{field}`", generic);
        }

        Assert.Contains(OptionsEval.GenericQuestion, generic);
    }

    private sealed class FixedJudge(CardVerdict? verdict) : IOptionsJudge
    {
        public Task<CardVerdict?> JudgeAsync(string record, string card, CancellationToken ct) => Task.FromResult(verdict);
    }

    private sealed class FixedGenericReader(GenericOptionsReading reading) : IGenericOptionsReader
    {
        public Task<GenericOptionsReading?> ReadAsync(string record, string answer, CancellationToken ct) => Task.FromResult<GenericOptionsReading?>(reading);
    }
}
