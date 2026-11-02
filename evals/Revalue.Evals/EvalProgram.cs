using Anthropic;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using Revalue.Server.Ai;
using Revalue.Server.Features.Foundation;

namespace Revalue.Evals;

/// <summary>
/// 評価を回す。
/// <c>dotnet run --project evals/Revalue.Evals -- --unit discover [--dry-run] [--out &lt;フォルダ&gt;]</c>
/// 終了コード: 0 合格、1 不合格、2 回せなかった（引数や鍵の不足など）。
/// </summary>
public static class EvalProgram
{
    private static readonly string[] Units = ["discover"];

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
                    Console.Error.WriteLine("使い方: dotnet run --project evals/Revalue.Evals -- --unit discover [--dry-run] [--out <フォルダ>]");
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
        if (dryRun)
        {
            ai = new ScriptedConversationAi();
            judge = new DryRunJudge();
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
            judge = new ClaudeJudge(client, claude.Model, File.ReadAllText(Path.Combine(baseDir, "judges", unit + ".md")).Trim(), usage);
        }

        var runner = new EvalRunner(ai, judge, forbidden);
        var runs = new List<EpisodeRun>();
        foreach (var script in scripts)
        {
            Console.WriteLine($"{script.Id} {script.Title} を流しています");
            runs.Add(await runner.RunAsync(script, cancel.Token));
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
        return summary.Passed ? 0 : 1;
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
