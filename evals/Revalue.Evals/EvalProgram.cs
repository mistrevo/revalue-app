using Anthropic;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Revalue.Server.Ai;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;

namespace Revalue.Evals;

/// <summary>
/// 評価を回す。
/// <c>dotnet run --project evals/Revalue.Evals -- --unit discover|validate|options [--dry-run] [--out &lt;フォルダ&gt;]</c>
/// 終了コード: 0 合格、1 不合格、2 回せなかった（引数や鍵の不足など）。
/// dry-run は仕組みが動くかだけを確かめるので、途中で終えた例がなければ 0、あれば 1 を返す（偽物の AI の数字では合否を決めない。Claude の判断）。
/// validate では、同じやりとりを汎用の AI にも渡して比べる（<see cref="GenericComparison"/>）。
/// options は、架空の 5 つの記録（evals/profiles/）から仕事の選択肢を作り、照らし合わせの前とあとを数える（<see cref="OptionsEval"/>）。
/// </summary>
public static class EvalProgram
{
    private static readonly string[] Units = ["discover", "validate", "options"];

    /// <summary>返事の判定役の指示。どのまとまりでも、返事は 02 discover（話す）の決まりで見る。</summary>
    private const string ReplyJudgePrompt = "discover.md";

    public static async Task<int> Main(string[] args)
    {
        string unit = "discover";
        string? outDir = null;
        var dryRun = false;
        for (var i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--unit" when i + 1 < args.Length:
                    unit = args[++i];
                    break;
                case "--out" when i + 1 < args.Length:
                    outDir = args[++i];
                    break;
                case "--dry-run":
                    dryRun = true;
                    break;
                default:
                    Console.Error.WriteLine($"知らない引数です: {args[i]}");
                    Console.Error.WriteLine("使い方: dotnet run --project evals/Revalue.Evals -- --unit discover|validate|options [--dry-run] [--out <フォルダ>]");
                    return 2;
            }
        }

        if (!Units.Contains(unit))
        {
            Console.Error.WriteLine($"まとまり {unit} の評価はまだありません。使えるのは {string.Join("、", Units)} です。");
            return 2;
        }

        using var cancel = new CancellationTokenSource();
        Console.CancelKeyPress += (_, e) =>
        {
            e.Cancel = true;
            cancel.Cancel();
        };

        var baseDir = AppContext.BaseDirectory;
        if (unit == "options")
        {
            return await RunOptionsAsync(baseDir, dryRun, outDir, cancel.Token);
        }

        var scripts = EpisodeScript.LoadAll(Path.Combine(baseDir, "episodes"), unit);
        if (scripts.Count == 0)
        {
            Console.Error.WriteLine($"まとまり {unit} の架空エピソードがありません。");
            return 2;
        }

        var forbidden = ForbiddenWords.Load(Path.Combine(baseDir, "forbidden-words.json"));
        var config = new ConfigurationBuilder().AddEnvironmentVariables().Build();
        var claude = new ClaudeOptions();
        config.GetSection("Claude").Bind(claude);
        var usage = new UsageMeter();

        using var loggers = LoggerFactory.Create(b => b.AddSimpleConsole(o => o.SingleLine = true));
        IConversationAi ai;
        IReplyJudge judge;
        GenericComparison generic;
        if (dryRun)
        {
            ai = new ScriptedConversationAi();
            judge = new DryRunJudge();
            generic = new GenericComparison(new DryRunGenericAssistant(), new DryRunGenericReader());
        }
        else
        {
            var apiKey = config[AiSetup.ApiKeySetting];
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                Console.Error.WriteLine($"本物の AI で回すには {AiSetup.ApiKeySetting} が要ります。仕組みだけを確かめるなら --dry-run を付けてください。");
                return 2;
            }

            var client = new AnthropicClient { ApiKey = apiKey };
            ai = new ClaudeConversationAi(client, Options.Create(claude), loggers.CreateLogger<ClaudeConversationAi>(), usage);
            judge = new ClaudeJudge(client, claude.Model, File.ReadAllText(Path.Combine(baseDir, "judges", ReplyJudgePrompt)).Trim(), usage);
            generic = new GenericComparison(
                new ClaudeGenericAssistant(client, claude.Model, usage),
                new ClaudeGenericReader(client, claude.Model, File.ReadAllText(Path.Combine(baseDir, "judges", "generic.md")).Trim(), usage));
        }

        var runner = new EvalRunner(ai, judge, forbidden);
        var runs = new List<EpisodeRun>();
        foreach (var script in scripts)
        {
            Console.WriteLine($"{script.Id} {script.Title} を流しています");
            var run = await runner.RunAsync(script, cancel.Token);
            if (unit == "validate" && run.Error is null)
            {
                run = run with { Generic = await generic.RunAsync(run, cancel.Token) };
            }

            runs.Add(run);
        }

        var summary = EvalSummary.From(runs);
        var at = DateTimeOffset.UtcNow.ToOffset(Jst.Offset);
        var report = ReportWriter.Write(new ReportContext(unit, claude.Model, dryRun, at), runs, summary, usage);

        var directory = outDir ?? (dryRun ? Path.Combine(Path.GetTempPath(), "revalue-evals") : ResultsDirectory());
        Directory.CreateDirectory(directory);
        var path = UniquePath(directory, $"{at:yyyy-MM-dd}-{unit}");
        await File.WriteAllTextAsync(path, report.ReplaceLineEndings("\n"), cancel.Token);

        foreach (var item in summary.Gated)
        {
            Console.WriteLine($"{(item.Passed == true ? "合格" : "不合格")}: {item.Name}（{item.Count} / {item.Total}、合格の線 {item.Line}）");
        }

        if (summary.Errors > 0)
        {
            Console.WriteLine($"途中で終えた例: {summary.Errors} 件");
        }

        Console.WriteLine($"結果を書きました: {path}");
        if (dryRun)
        {
            return summary.Errors == 0 ? 0 : 1;
        }

        return summary.Passed ? 0 : 1;
    }

    /// <summary>
    /// 仕事の選択肢の評価を回す。本物の AI では、製品と同じ <see cref="ClaudeOptionsAi"/>、判定役（judges/options.md）、
    /// 汎用の AI と、その答えを読む判定役（judges/generic-options.md）を使う。
    /// </summary>
    private static async Task<int> RunOptionsAsync(string baseDir, bool dryRun, string? outDir, CancellationToken ct)
    {
        var cases = ProfileCase.LoadAll(Path.Combine(baseDir, "profiles"));
        if (cases.Count == 0)
        {
            Console.Error.WriteLine("架空の 5 つの記録（profiles）がありません。");
            return 2;
        }

        var forbidden = ForbiddenWords.Load(Path.Combine(baseDir, "forbidden-words.json"));
        var config = new ConfigurationBuilder().AddEnvironmentVariables().Build();
        var claude = new ClaudeOptions();
        config.GetSection("Claude").Bind(claude);
        var usage = new UsageMeter();
        using var loggers = LoggerFactory.Create(b => b.AddSimpleConsole(o => o.SingleLine = true));

        OptionsEval eval;
        if (dryRun)
        {
            eval = new OptionsEval(
                new ScriptedOptionsAi(), new DryRunOptionsJudge(), new DryRunGenericAssistant(), new DryRunGenericOptionsReader(), JobCatalog.Load(), forbidden);
        }
        else
        {
            var apiKey = config[AiSetup.ApiKeySetting];
            if (string.IsNullOrWhiteSpace(apiKey))
            {
                Console.Error.WriteLine($"本物の AI で回すには {AiSetup.ApiKeySetting} が要ります。仕組みだけを確かめるなら --dry-run を付けてください。");
                return 2;
            }

            var client = new AnthropicClient { ApiKey = apiKey };
            string Judge(string name) => File.ReadAllText(Path.Combine(baseDir, "judges", name)).Trim();
            eval = new OptionsEval(
                new ClaudeOptionsAi(client, Options.Create(claude), loggers.CreateLogger<ClaudeOptionsAi>(), usage),
                new ClaudeOptionsJudge(client, claude.Model, Judge("options.md"), usage),
                new ClaudeGenericAssistant(client, claude.Model, usage),
                new ClaudeGenericOptionsReader(client, claude.Model, Judge("generic-options.md"), usage),
                JobCatalog.Load(),
                forbidden);
        }

        var runs = new List<OptionsRun>();
        foreach (var profile in cases)
        {
            Console.WriteLine($"{profile.Id} {profile.Title} を流しています");
            runs.Add(await eval.RunAsync(profile, ct));
        }

        var summary = OptionsSummary.From(runs);
        var at = DateTimeOffset.UtcNow.ToOffset(Jst.Offset);
        var report = OptionsReport.Write(new ReportContext("options", claude.Model, dryRun, at), runs, summary, usage);
        var directory = outDir ?? (dryRun ? Path.Combine(Path.GetTempPath(), "revalue-evals") : ResultsDirectory());
        Directory.CreateDirectory(directory);
        var path = UniquePath(directory, $"{at:yyyy-MM-dd}-options");
        await File.WriteAllTextAsync(path, report.ReplaceLineEndings("\n"), ct);

        foreach (var item in summary.Gated)
        {
            Console.WriteLine($"{(item.Passed == true ? "合格" : "不合格")}: {item.Name}（{item.Count} / {item.Total}、合格の線 {item.Line}）");
        }

        if (summary.Errors > 0)
        {
            Console.WriteLine($"途中で終えた記録: {summary.Errors} 件");
        }

        Console.WriteLine($"結果を書きました: {path}");
        return dryRun ? (summary.Errors == 0 ? 0 : 1) : (summary.Passed ? 0 : 1);
    }

    /// <summary>リポジトリの evals/results。今いるフォルダから上へ Revalue.slnx を探す。</summary>
    private static string ResultsDirectory()
    {
        foreach (var start in new[] { Directory.GetCurrentDirectory(), AppContext.BaseDirectory })
        {
            for (var dir = new DirectoryInfo(start); dir is not null; dir = dir.Parent)
            {
                if (File.Exists(Path.Combine(dir.FullName, "Revalue.slnx")))
                {
                    return Path.Combine(dir.FullName, "evals", "results");
                }
            }
        }

        throw new InvalidOperationException("リポジトリ（Revalue.slnx）が見つかりません。--out で書き出す場所を指定してください。");
    }

    /// <summary>同じ日に何度か回しても、前の結果を上書きしない。</summary>
    private static string UniquePath(string directory, string name)
    {
        var path = Path.Combine(directory, name + ".md");
        for (var n = 2; File.Exists(path); n++)
        {
            path = Path.Combine(directory, $"{name}-{n}.md");
        }

        return path;
    }
}
