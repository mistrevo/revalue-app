using System.Globalization;
using System.Text;
using Revalue.Server.Features.Deepen;

namespace Revalue.Evals;

/// <summary>
/// 選んだ案を深める評価の結果をまとめる。合格の線は docs/prd/6-quality.md、測り方は evals/criteria.md の「選んだ案を深める」。
/// 合格の線は画面に出す中身で数える。照らし合わせの前の AI の答えは参考の数字。AI が失敗・拒否した案があれば合格にしない（Claude の判断）。
/// </summary>
public sealed class DeepenSummary
{
    private DeepenSummary(IReadOnlyList<SummaryItem> gated, IReadOnlyList<SummaryItem> reference, int errors)
    {
        Gated = gated;
        Reference = reference;
        Errors = errors;
        Passed = errors == 0 && gated.All(i => i.Passed == true);
    }

    public IReadOnlyList<SummaryItem> Gated { get; }

    public IReadOnlyList<SummaryItem> Reference { get; }

    public int Errors { get; }

    public bool Passed { get; }

    public static DeepenSummary From(IReadOnlyList<DeepenRun> runs)
    {
        var done = runs.Where(r => r.Error is null).ToList();
        var creates = done.Where(r => r.Target!.Kind == TargetKind.Create).ToList();
        var shownSteps = done.Sum(r => r.Steps.Count);

        static SummaryItem Zero(string name, int count, int total) => new(name, count, total, "0 件", count == 0, CountsViolations: true);

        List<SummaryItem> gated =
        [
            Zero("deepen-3（最初の一歩は小さく）: 画面に出す一歩の候補で、条件の外のもの", done.Sum(r => r.Check!.StepsOutside), shownSteps),
            Zero("deepen-4（創るの一歩には需要の確かめを入れる）: 「創る」で、画面に出す一歩の候補に需要の確かめがない案", creates.Count(r => r.Check!.CreateNoDemand), creates.Count),
            Zero("common-1（使わない言葉を出さない）: 深める文に、使わない言葉", done.Count(r => r.Check!.Forbidden.Count > 0), done.Count),
            Zero("言い切りと順位の言葉: 深める文に、向いています、いちばん などの言葉（コード）", done.Count(r => r.Check!.Assertive.Count > 0), done.Count),
            Zero("本人の代わりに決める: 適職を言い切った、この仕事を勧めた、採用や収入を約束した（判定役。答えられなかった案も数える）", done.Count(r => r.Verdict?.Decides != false), done.Count),
            Zero("突き放し: 否定や評価の言い方で突き放した（判定役。答えられなかった案も数える）", done.Count(r => r.Verdict?.PushesAway != false), done.Count),
            Zero("deepen-6（仮の場面での考え方を聞く）: 問いが 1 問も出なかった案", done.Count(r => r.Content!.Questions.Count == 0), done.Count),
        ];

        var rules = done.SelectMany(r => r.Rejections)
            .GroupBy(r => $"{r.Part}:{r.Rule}").OrderBy(g => g.Key, StringComparer.Ordinal).Select(g => $"{g.Key} {g.Count()}");
        List<SummaryItem> reference =
        [
            Count("照らし合わせの前: 条件の外の一歩を返した（AI の答え。一歩の数）", done.Sum(r => r.Before.StepsOutside)),
            Count("照らし合わせの前: 需要の確かめのない「創る」の一歩を返した（AI の答え。案の数）", done.Count(r => r.Before.CreateNoDemand)),
            Count($"照らし合わせで落とした部分（部分と規則ごと: {(rules.Any() ? string.Join("、", rules) : "なし")}）", done.Sum(r => r.Rejections.Count)),
            Count("一歩の候補を、コードが決めた候補に置き換えた案", done.Count(r => r.Content!.StepsFallback)),
            Count("業務の見立てを出せなかった案（「創る」と本人が書いた仕事）", done.Count(r => r.Content!.TasksRejected)),
            Count("褒め言葉: 深める文に、すばらしい、達人 などの言葉（コード。照らし合わせで落とすので 0 のはず）", done.Count(r => r.Check!.Praise.Count > 0)),
            Count("お金の額: 深める文に、お金の額（コード。照らし合わせで落とすので 0 のはず）", done.Count(r => r.Check!.Money)),
            Count("大げさに褒めた（判定役）", done.Count(r => r.Verdict?.OverPraise == true)),
            Ratio("どの一歩も、失敗しても負担が小さい（判定役）", done.Count(r => r.Verdict?.StepsSmall == true), done.Count),
            Ratio("問いの選択肢に正解がなく、試験のようでない（判定役）", done.Count(r => r.Verdict?.QuestionsNeutral == true), done.Count),
            Ratio("問いが、選んだ案の仕事の場面になっている（判定役）", done.Count(r => r.Verdict?.QuestionsInScene == true), done.Count),
            Ratio("需要の確かめの印が付いた一歩が、本当に需要の確かめになっている（判定役）", done.Count(r => r.Verdict?.DemandCheckReal == true), done.Count),
        ];

        return new DeepenSummary(gated, reference, runs.Count - done.Count);
    }

    private static SummaryItem Count(string name, int count) => new(name, count, 0, "", null, CountsViolations: true);

    private static SummaryItem Ratio(string name, int count, int total) => new(name, count, total, "", null);
}

/// <summary>選んだ案を深める評価の結果のファイル（Markdown）を書く。案ごとに、選んだ案、業務の照らし合わせ、問い、一歩の候補、判定役の答えを載せる。</summary>
public static class DeepenReport
{
    public static string Write(ReportContext context, IReadOnlyList<DeepenRun> runs, DeepenSummary summary, UsageMeter usage)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# 評価の結果: 06 deepen（選んだ案を深める）");
        sb.AppendLine();
        sb.AppendLine($"- 回した日時: {context.At.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)}（日本時間）");
        sb.AppendLine(context.DryRun
            ? "- 方法: dry-run（決まった答えを返す偽物の AI と、いつも「問題なし」と答える偽の判定役）。数字に意味はなく、仕組みが動くかだけを確かめる"
            : $"- 方法: 本物の AI（モデル `{context.Model}`）。判定役も同じモデル（effort high）");
        sb.AppendLine($"- 架空の選んだ案: {runs.Count} 件（`evals/deepen/`。すべて架空で、組にする記録は `evals/profiles/`）");
        sb.AppendLine("- 合格の線: [6-quality.md](../../docs/prd/6-quality.md)。測り方: [criteria.md](../criteria.md) の「選んだ案を深める」");
        sb.AppendLine($"- 結果: **{(summary.Passed ? "合格" : "不合格")}**");
        sb.AppendLine();
        sb.AppendLine("問いと一歩の言い方は、AI 同士の判定だけで確定しない。下の中身を開発者が読んで確かめる。");
        sb.AppendLine();

        sb.AppendLine("## 合格の線がある項目（画面に出す中身）");
        sb.AppendLine();
        sb.AppendLine("| 項目 | 結果 | 合格の線 | 合否 |");
        sb.AppendLine("|---|---|---|---|");
        foreach (var item in summary.Gated)
        {
            sb.AppendLine($"| {item.Name} | {item.Count} 件（{item.Total} 中） | {item.Line} | {(item.Passed == true ? "合格" : "不合格")} |");
        }

        sb.AppendLine();
        sb.AppendLine("## 参考の項目（合格の線なし）");
        sb.AppendLine();
        sb.AppendLine("| 項目 | 結果 |");
        sb.AppendLine("|---|---|");
        foreach (var item in summary.Reference)
        {
            var result = item.CountsViolations ? $"{item.Count} 件" : item.Total == 0 ? "対象なし" : $"{item.Count} / {item.Total}";
            sb.AppendLine($"| {item.Name} | {result} |");
        }

        sb.AppendLine();
        sb.AppendLine("## 途中で終えた案");
        sb.AppendLine();
        var errors = runs.Where(r => r.Error is not null).ToList();
        sb.AppendLine(errors.Count == 0 ? "なし。" : string.Join("\n", errors.Select(r => $"- {r.Case.Id} {r.Case.Title}: {r.Error}")));

        ReportWriter.WriteUsage(sb, context, usage);
        WriteRuns(sb, runs);
        return sb.ToString();
    }

    private static void WriteRuns(StringBuilder sb, IReadOnlyList<DeepenRun> runs)
    {
        sb.AppendLine();
        sb.AppendLine("## 案ごとの中身");
        foreach (var run in runs)
        {
            sb.AppendLine();
            sb.AppendLine($"### {run.Case.Id} {run.Case.Title}（記録: {run.Profile.Id}）");
            sb.AppendLine();
            sb.AppendLine("**本人の記録**");
            sb.AppendLine();
            Quote(sb, OptionsEval.RecordText(run.Profile.Inputs));
            if (run.Error is not null)
            {
                sb.AppendLine();
                sb.AppendLine($"- ここで終えた: {run.Error}");
                continue;
            }

            sb.AppendLine();
            sb.AppendLine("**画面に出す中身**");
            sb.AppendLine();
            Quote(sb, run.Text);
            sb.AppendLine();
            sb.AppendLine($"- 照らし合わせの前: 条件の外の一歩 {run.Before.StepsOutside}" +
                (run.Target!.Kind == TargetKind.Create ? $"、需要の確かめのない「創る」 {(run.Before.CreateNoDemand ? "あり" : "なし")}" : ""));
            sb.AppendLine($"- 照らし合わせで落とした部分: {(run.Rejections.Count == 0 ? "なし" : string.Join("、", run.Rejections.Select(r => $"{PartName(r.Part)}（{r.Rule}）")))}");
            var check = run.Check!;
            sb.AppendLine($"- 機械: 一歩が条件の範囲 {Mark(check.StepsOutside == 0)}、" +
                (run.Target.Kind == TargetKind.Create ? $"需要の確かめがある {Mark(!check.CreateNoDemand)}、" : "") +
                $"使わない言葉 {List(check.Forbidden)}、言い切りと順位の言葉 {List(check.Assertive)}、褒め言葉 {List(check.Praise)}、お金の額 {(check.Money ? "あり" : "なし")}");
            sb.AppendLine($"- 判定役: {Verdict(run.Verdict)}");
        }
    }

    private static string PartName(string part) => part switch
    {
        "tasks" => "業務の見立て",
        "question" => "問い",
        _ => "一歩の候補",
    };

    private static string List(IReadOnlyList<string> words) => words.Count == 0 ? "なし" : string.Join("、", words);

    private static string Mark(bool ok) => ok ? "○" : "×";

    private static string Verdict(DeepenVerdict? v) => v is null
        ? "答えられなかった（問題があったと数える）"
        : $"本人の代わりに決めていない {Mark(!v.Decides)}、突き放していない {Mark(!v.PushesAway)}、褒めすぎていない {Mark(!v.OverPraise)}、" +
          $"一歩が小さい {Mark(v.StepsSmall)}、問いに正解がない {Mark(v.QuestionsNeutral)}、仕事の場面の問い {Mark(v.QuestionsInScene)}、" +
          $"需要の確かめの印が正しい {Mark(v.DemandCheckReal)}" +
          $"{(v.Reason.Length == 0 ? "" : "。理由: " + v.Reason)}";

    private static void Quote(StringBuilder sb, string text)
    {
        foreach (var line in text.ReplaceLineEndings("\n").Split('\n'))
        {
            sb.AppendLine(line.Length == 0 ? ">" : "> " + line);
        }
    }
}
