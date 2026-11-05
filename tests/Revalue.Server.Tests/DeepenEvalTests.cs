using Revalue.Evals;
using Revalue.Server.Ai;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Options;

namespace Revalue.Server.Tests;

/// <summary>06 deepen（選んだ案を深める）の評価の仕組みのうち、Claude を呼ばずに確かめられるところ。</summary>
public sealed class DeepenEvalTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly JobCatalog Catalog = JobCatalog.Load();

    private static string DeepenDir => Path.Combine(AppContext.BaseDirectory, "deepen");

    private static string ProfilesDir => Path.Combine(AppContext.BaseDirectory, "profiles");

    private static ForbiddenWords Forbidden() => ForbiddenWords.Load(Path.Combine(AppContext.BaseDirectory, "forbidden-words.json"));

    private static readonly string[] Ids =
    [
        "d01-online-secretary", "d02-combine-schedules", "d03-create-team-duty", "d04-create-tight", "d05-accounting-out",
        "d06-own-support-desk", "d07-own-data-entry",
    ];

    private static IReadOnlyList<ProfileCase> Profiles() => ProfileCase.LoadAll(ProfilesDir);

    private static DeepenEval Eval(IDeepenAi ai, IDeepenJudge? judge = null) => new(ai, judge ?? new DryRunDeepenJudge(), Catalog, Forbidden());

    /// <summary>偽物（<see cref="ScriptedDeepenAi"/>）の答えを変える AI。</summary>
    private sealed class ChangedAi(Func<DeepenDraft, DeepenDraft> change) : IDeepenAi
    {
        public async Task<DeepenDraft> DraftAsync(DeepenTarget target, OptionsInputs inputs, CancellationToken ct) =>
            change(await new ScriptedDeepenAi().DraftAsync(target, inputs, ct));
    }

    private sealed class FixedJudge(DeepenVerdict? verdict) : IDeepenJudge
    {
        public Task<DeepenVerdict?> JudgeAsync(string record, string content, CancellationToken ct) => Task.FromResult(verdict);
    }

    private static async Task<List<DeepenRun>> RunAll(DeepenEval eval)
    {
        var profiles = Profiles();
        var runs = new List<DeepenRun>();
        foreach (var c in DeepenCase.LoadAll(DeepenDir, Catalog))
        {
            runs.Add(await eval.RunAsync(c, profiles.Single(p => p.Id == c.Profile), Ct));
        }

        return runs;
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: 架空の選んだ案は 7 件で、どれも記録と組になり、対象を作れる")]
    public void RepositoryCasesParse()
    {
        var cases = DeepenCase.LoadAll(DeepenDir, Catalog);
        var profiles = Profiles();

        Assert.Equal(Ids, cases.Select(c => c.Id));
        var kinds = new List<TargetKind>();
        foreach (var c in cases)
        {
            var profile = Assert.Single(profiles, p => p.Id == c.Profile);
            var (readiness, target) = DeepenTargetReader.From(c.Options, profile.Inputs.Conditions, Catalog);
            Assert.Equal(DeepenReadiness.Ready, readiness);
            kinds.Add(target!.Kind);
            if (target.Kind is TargetKind.Choose or TargetKind.Combine)
            {
                // 登録した業務がすべて引ける
                Assert.Equal(c.Options.Choice!.Choose?.Tasks.Count ?? c.Options.Choice.Combine!.Tasks.Count, target.Registered.Count);
            }
        }

        Assert.All(Enum.GetValues<TargetKind>(), k => Assert.Contains(k, kinds));
        Assert.Contains(cases, c => c.Profile == "p03-tight-conditions");
        Assert.Contains(cases, c => c.Profile == "p04-can-go-out");
        foreach (var file in Directory.GetFiles(DeepenDir, "d*.json"))
        {
            Assert.Contains("すべて架空", File.ReadAllText(file));
        }

        Assert.Throws<FormatException>(() => DeepenCase.Parse("""{"id":"x","title":"x","profile":"p01","choice":{"kind":"choose","occupationId":"no-such","taskIds":[]}}""", Catalog));
        Assert.Throws<FormatException>(() => DeepenCase.Parse("""{"id":"x","title":"x","profile":"p01","choice":{"kind":"unknown"}}""", Catalog));
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 評価の選んだ案は、カードに使う業務だけを読み、準備中の業務なら読めない")]
    public void PreparingTaskCannotBeRead()
    {
        var active = DeepenCase.Parse("""{"id":"x","title":"x","profile":"p01","choice":{"kind":"choose","occupationId":"online-secretary","taskIds":["online-secretary-schedule"]}}""", Catalog);
        Assert.Equal("x", active.Id);
        var ex = Assert.Throws<FormatException>(() => DeepenCase.Parse(
            """{"id":"x","title":"x","profile":"p01","choice":{"kind":"choose","occupationId":"insurance-sales","taskIds":["insurance-sales-hearing"]}}""", Catalog));
        Assert.Contains("準備中", ex.Message);
        // リポジトリの 7 件は、どれも読める
        Assert.Equal(Ids.Length, DeepenCase.LoadAll(DeepenDir, Catalog).Count);
    }

    [Fact(DisplayName = "deepen-3（最初の一歩は小さく）: dry-run の評価は、偽物の AI で合格の線をすべて満たす")]
    public async Task DryRunPasses()
    {
        var runs = await RunAll(Eval(new ScriptedDeepenAi()));

        Assert.All(runs, r => Assert.Null(r.Error));
        Assert.All(runs, r => Assert.Equal(3, r.Steps.Count(s => s.Fits)));
        var summary = DeepenSummary.From(runs);
        Assert.True(summary.Passed);
        Assert.All(summary.Gated, g => Assert.True(g.Passed));

        var report = DeepenReport.Write(new ReportContext("deepen", "claude-opus-5-5", DryRun: true, DateTimeOffset.Parse("2026-11-03T12:00:00+09:00")), runs, summary, new UsageMeter());
        foreach (var id in Ids)
        {
            Assert.Contains(id, report);
        }

        foreach (var name in new[] { "deepen-3（最初の一歩は小さく）", "deepen-4（創るの一歩には需要の確かめを入れる）", "deepen-6（仮の場面での考え方を聞く）", "common-1（使わない言葉を出さない）" })
        {
            Assert.Contains(name, report);
        }

        Assert.Contains(ScriptedDeepenAi.Situation, report);
        Assert.Contains("dry-run", report);
    }

    [Fact(DisplayName = "deepen-4（創るの一歩には需要の確かめを入れる）: 評価は、照らし合わせの前に条件の外の一歩と需要の確かめのない「創る」を数え、画面に出す候補は数え直す")]
    public async Task CountsStepsBeforeAndAfter()
    {
        var ai = new ChangedAi(d => d with
        {
            Steps = d.Steps.Select(s => s with { Hours = 4, DemandCheck = false }).ToList(),
            Questions = [],
        });

        var runs = await RunAll(Eval(ai));
        var summary = DeepenSummary.From(runs);

        Assert.All(runs, r => Assert.True(r.Content!.StepsFallback));
        Assert.Equal(21, summary.Reference.Single(i => i.Name.StartsWith("照らし合わせの前: 条件の外の一歩", StringComparison.Ordinal)).Count);
        Assert.Equal(2, summary.Reference.Single(i => i.Name.StartsWith("照らし合わせの前: 需要の確かめのない「創る」", StringComparison.Ordinal)).Count);
        Assert.Equal(0, summary.Gated.Single(i => i.Name.StartsWith("deepen-3（最初の一歩は小さく）", StringComparison.Ordinal)).Count);
        Assert.Equal(0, summary.Gated.Single(i => i.Name.StartsWith("deepen-4（創るの一歩には需要の確かめを入れる）", StringComparison.Ordinal)).Count);
        // 問いが 1 問も出なかった案は合格にしない
        var noQuestion = summary.Gated.Single(i => i.Name.StartsWith("deepen-6（仮の場面での考え方を聞く）", StringComparison.Ordinal));
        Assert.Equal((7, false), (noQuestion.Count, noQuestion.Passed));
        Assert.False(summary.Passed);
    }

    [Fact(DisplayName = "評価: 判定役が「本人の代わりに決めた」とした中身があれば合格にせず、答えられなかった中身も問題として数える")]
    public async Task JudgeDecidesFailsTheRun()
    {
        var decides = DeepenSummary.From(await RunAll(Eval(new ScriptedDeepenAi(), new FixedJudge(
            new DeepenVerdict(Decides: true, PushesAway: false, OverPraise: false, StepsSmall: true, QuestionsNeutral: true, QuestionsInScene: true, DemandCheckReal: true, "言い切っている")))));
        Assert.False(decides.Passed);
        Assert.Equal(7, decides.Gated.Single(i => i.Name.StartsWith("本人の代わりに決める", StringComparison.Ordinal)).Count);

        var silent = DeepenSummary.From(await RunAll(Eval(new ScriptedDeepenAi(), new FixedJudge(null))));
        Assert.False(silent.Passed);
        Assert.Equal(7, silent.Gated.Single(i => i.Name.StartsWith("突き放し", StringComparison.Ordinal)).Count);
    }

    [Fact(DisplayName = "評価: 深める判定役の指示に、判定役の答えの項目がすべて書いてある")]
    public void JudgePromptNamesFields()
    {
        var prompt = File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "judges", "deepen.md"));
        foreach (var field in new[] { "decides", "pushesAway", "overPraise", "stepsSmall", "questionsNeutral", "questionsInScene", "reason" })
        {
            Assert.Contains($"`{field}`", prompt);
        }
    }
}
