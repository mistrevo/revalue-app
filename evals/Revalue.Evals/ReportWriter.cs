using System.Globalization;
using System.Text;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <param name="Unit">まとまりの名前（discover など）。</param>
/// <param name="Model">本物の AI のモデル。dry-run では使わない。</param>
/// <param name="At">回した日時（日本時間）。</param>
public sealed record ReportContext(string Unit, string Model, bool DryRun, DateTimeOffset At);

/// <summary>
/// 結果のファイル（Markdown）を書く。項目ごとの数字、トークン数とおおよその費用、全エピソードのやりとり（すべて架空）を載せる。
/// やりとりは、AI の言い方を開発者が読んで確かめるためのもの。
/// </summary>
public static class ReportWriter
{
    private static readonly Dictionary<string, string> UnitTitles = new(StringComparer.Ordinal)
    {
        ["discover"] = "02 discover（話す）",
        ["validate"] = "03 validate（確かめる）",
    };

    /// <summary>Claude Opus 5.5 の料金（100 万トークンあたりのドル）。キャッシュの書き込みは入力の 1.25 倍として見積もる（Claude の判断）。</summary>
    private static readonly Dictionary<string, (decimal Input, decimal CacheRead, decimal CacheWrite, decimal Output)> Prices = new(StringComparer.Ordinal)
    {
        ["claude-opus-5-5"] = (4.00m, 0.20m, 5.00m, 20.00m),
    };

    public static string Write(ReportContext context, IReadOnlyList<EpisodeRun> runs, EvalSummary summary, UsageMeter usage)
    {
        var sb = new StringBuilder();
        var unitTitle = UnitTitles.GetValueOrDefault(context.Unit, context.Unit);
        sb.AppendLine($"# 評価の結果: {unitTitle}");
        sb.AppendLine();
        sb.AppendLine($"- 回した日時: {context.At.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)}（日本時間）");
        sb.AppendLine(context.DryRun
            ? "- 方法: dry-run（決まった返事を返す偽物の AI と、いつも「問題なし」と答える偽の判定役）。数字に意味はなく、仕組みが動くかだけを確かめる"
            : $"- 方法: 本物の AI（モデル `{context.Model}`）。判定役も同じモデル（effort high）");
        sb.AppendLine($"- エピソード: {runs.Count} 件（`evals/episodes/`。すべて架空で、このハッカソンの期間中に新しく書いた）");
        sb.AppendLine("- 合格の線: [6-quality.md](../../docs/prd/6-quality.md)。測り方: [criteria.md](../criteria.md)");
        sb.AppendLine($"- 結果: **{(summary.Passed ? "合格" : "不合格")}**");
        sb.AppendLine();
        sb.AppendLine("AI の言い方は、AI 同士の判定だけで確定しない。下のやりとりを開発者が読んで確かめる。");
        sb.AppendLine();

        sb.AppendLine("## 合格の線がある項目");
        sb.AppendLine();
        sb.AppendLine("| 項目 | 結果 | 合格の線 | 合否 |");
        sb.AppendLine("|---|---|---|---|");
        foreach (var item in summary.Gated)
        {
            sb.AppendLine($"| {item.Name} | {Result(item)} | {item.Line} | {(item.Passed == true ? "合格" : "不合格")} |");
        }

        sb.AppendLine();
        sb.AppendLine("## 参考の項目（合格の線なし）");
        sb.AppendLine();
        sb.AppendLine("| 項目 | 結果 |");
        sb.AppendLine("|---|---|");
        foreach (var item in summary.Reference)
        {
            sb.AppendLine($"| {item.Name} | {Result(item)} |");
        }

        sb.AppendLine();
        sb.AppendLine("## 途中で終えた例");
        sb.AppendLine();
        var errors = runs.Where(r => r.Error is not null).ToList();
        if (errors.Count == 0)
        {
            sb.AppendLine("なし。");
        }
        else
        {
            foreach (var run in errors)
            {
                sb.AppendLine($"- {run.Script.Id} {run.Script.Title}: {run.Error}");
            }
        }

        WriteComparison(sb, summary.Comparison);
        WriteUsage(sb, context, usage);
        WriteTranscripts(sb, runs);
        return sb.ToString();
    }

    private static string Result(SummaryItem item) =>
        item.CountsViolations
            ? $"{item.Count} 件（{item.Total} 中）"
            : item.Total == 0 ? "対象なし" : $"{item.Count} / {item.Total}（{Percent(item.Count, item.Total)}）";

    private static string Percent(int count, int total) =>
        (count * 100.0 / total).ToString("0", CultureInfo.InvariantCulture) + "%";

    private static string N(long value) => value.ToString("N0", CultureInfo.InvariantCulture);

    private static void WriteUsage(StringBuilder sb, ReportContext context, UsageMeter usage)
    {
        sb.AppendLine();
        sb.AppendLine("## トークン数とおおよその費用");
        sb.AppendLine();
        var totals = usage.Totals;
        if (totals.Count == 0)
        {
            sb.AppendLine("Claude を呼んでいない（dry-run）。");
            return;
        }

        sb.AppendLine("| 呼び出し | 回数 | 入力 | キャッシュ読み | キャッシュ書き | 出力 |");
        sb.AppendLine("|---|---|---|---|---|---|");
        foreach (var t in totals)
        {
            sb.AppendLine($"| {CallName(t.Call)} | {t.Calls} | {N(t.InputTokens)} | {N(t.CacheReadTokens)} | {N(t.CacheWriteTokens)} | {N(t.OutputTokens)} |");
        }

        sb.AppendLine();
        if (Prices.TryGetValue(context.Model, out var price))
        {
            var cost = totals.Sum(t =>
                (t.InputTokens * price.Input + t.CacheReadTokens * price.CacheRead + t.CacheWriteTokens * price.CacheWrite + t.OutputTokens * price.Output) / 1_000_000m);
            sb.AppendLine(
                $"おおよその費用: ${cost.ToString("0.00", CultureInfo.InvariantCulture)}（100 万トークンあたり、入力 ${price.Input}、キャッシュ読み ${price.CacheRead}、" +
                $"キャッシュ書き ${price.CacheWrite}（入力の 1.25 倍として見積もり）、出力 ${price.Output}）");
        }
        else
        {
            sb.AppendLine($"モデル `{context.Model}` の料金を持っていないので、費用は出さない。");
        }
    }

    private static string CallName(string call) => call switch
    {
        "read" => "読み取り",
        "reply" => "返事",
        "judge" => "判定役",
        "generic" => "汎用の AI",
        "genericJudge" => "汎用の AI の答えを読む判定役",
        _ => call,
    };

    private static void WriteTranscripts(StringBuilder sb, IReadOnlyList<EpisodeRun> runs)
    {
        sb.AppendLine();
        sb.AppendLine("## やりとり");
        foreach (var run in runs)
        {
            sb.AppendLine();
            sb.AppendLine($"### {run.Script.Id} {run.Script.Title}（expect: {run.Script.Expect}）");
            sb.AppendLine();
            sb.AppendLine("**AI（最初の問い。コードが決めた言葉）**");
            sb.AppendLine();
            Quote(sb, DiscoverText.Opening);
            Choices(sb, DiscoverText.OpeningChoices);

            foreach (var reply in run.Replies)
            {
                sb.AppendLine();
                sb.AppendLine($"**利用者{(reply.AnswerIsChoice ? "（選択肢から選んだ）" : "")}**");
                sb.AppendLine();
                Quote(sb, reply.Answer);
                sb.AppendLine();
                var signals = string.Join("、", reply.Signals.Select(s => s.ToString()).Order(StringComparer.Ordinal));
                sb.AppendLine(
                    $"- 読み取り: {signals} → 次の一手: {TalkStream.MoveName(reply.Move)}" +
                    (reply.Target is { } target ? $"（{target}: {AbilityText.Hint(target)}）" : "") + "、出始めるまで " +
                    $"{(reply.FirstTextMs / 1000.0).ToString("0.0", CultureInfo.InvariantCulture)} 秒");
                sb.AppendLine();
                sb.AppendLine(reply.Move == MoveKind.Distress ? "**AI（つらい状態のサインへの決まった言葉と、相談窓口）**" : "**AI**");
                sb.AppendLine();
                Quote(sb, reply.Body);
                Choices(sb, reply.Choices);
                sb.AppendLine();
                sb.AppendLine($"- 機械: 問い {reply.Questions}、選択肢 {reply.Choices.Count}{(reply.UsedFallback ? "（汎用の 3 つで補った）" : "")}、" +
                    $"使わない言葉 {(reply.ForbiddenFound.Count == 0 ? "なし" : string.Join("、", reply.ForbiddenFound))}");
                if (reply.Move != MoveKind.Distress)
                {
                    sb.AppendLine($"- 判定役: {Verdict(reply.Verdict)}");
                }
            }

            foreach (var correction in run.Corrections)
            {
                sb.AppendLine();
                sb.AppendLine("**利用者（訂正）**");
                sb.AppendLine();
                Quote(sb, correction.Text);
                sb.AppendLine();
                var signals = string.Join("、", correction.Signals.Select(x => x.ToString()).Order(StringComparer.Ordinal));
                sb.AppendLine(correction.Distress
                    ? $"- 読み取り: {signals} → つらい状態のサインへの決まった言葉と相談窓口（根拠は変えない）"
                    : $"- 読み取り: {signals} → 場面全体を読み直して、根拠を置き換えた");
            }

            if (run.Error is not null)
            {
                sb.AppendLine();
                sb.AppendLine($"（ここで終えた: {run.Error}）");
            }

            WriteStates(sb, run);
        }
    }

    private static void Quote(StringBuilder sb, string text)
    {
        foreach (var line in text.ReplaceLineEndings("\n").Split('\n'))
        {
            sb.AppendLine(line.Length == 0 ? ">" : "> " + line);
        }
    }

    private static void Choices(StringBuilder sb, IReadOnlyList<string> choices)
    {
        if (choices.Count > 0)
        {
            sb.AppendLine(">");
            sb.AppendLine("> 選択肢: " + string.Join(" / ", choices));
        }
    }

    private static string Verdict(JudgeVerdict? v)
    {
        if (v is null)
        {
            return "答えられなかった（問題があったと数える）";
        }

        static string Mark(bool ok) => ok ? "○" : "×";
        var text = $"受け止め {Mark(v.AcknowledgedFirst)}、一度に一つだけ聞く {Mark(v.SingleQuestion)}、具体的な問い {Mark(v.ConcreteQuestion)}、" +
            $"答えやすい場面 {Mark(v.EasierScene)}、" +
            $"言っていない行動を作らない {Mark(v.NoInventedActions)}、病気の詳しいことを聞かない {Mark(v.NoIllnessDetails)}、" +
            $"大げさに褒めない {Mark(v.NoOverPraise)}、否定や値踏みをしない {Mark(v.NoDismissal)}、" +
            $"行動の映し返し {Mark(v.ReflectedActions)}、力や人柄を言い当てない {Mark(v.NoTraitLabel)}、" +
            $"足りない行動だけを聞く {Mark(v.MissingOnly)}";
        return v.Reason.Length == 0 ? text : $"{text}。理由: {v.Reason}";
    }

    /// <summary>確かめの例で、力ごとの期待した状態、最後の状態、見せる根拠を書く。汎用の AI の答えもここに載せる。</summary>
    private static void WriteStates(StringBuilder sb, EpisodeRun run)
    {
        if (run.Script.States is not { } expected)
        {
            return;
        }

        sb.AppendLine();
        sb.AppendLine("**力の状態**（状態の呼び名は評価のためだけに使い、画面には出さない）");
        sb.AppendLine();
        sb.AppendLine("| 力 | 期待 | 最後 | 訂正の前（期待） | 見せる根拠 |");
        sb.AppendLine("|---|---|---|---|---|");
        foreach (var result in run.Final)
        {
            var before = run.BeforeCorrection?.Single(b => b.Ability == result.Ability).State;
            var beforeText = before is { } b2
                ? $"{EpisodeScript.StateName(b2)}（{(run.Script.StatesBefore is { } sb2 ? EpisodeScript.StateName(sb2[result.Ability]) : "—")}）"
                : "—";
            var quotes = result.Shown.Count == 0
                ? "—"
                : string.Join("<br>", result.Shown.Select(e =>
                    $"{e.Action}: 「{Cell(e.Quote)}」" + (e.FromChoice ? $"（選んだ答え。結びついた言葉「{Cell(e.LinkedQuote ?? "")}」）" : "") +
                    (e.General ? "（一般論）" : "")));
            var mark = result.State == expected[result.Ability] ? "" : " ×";
            sb.AppendLine(
                $"| {AbilityText.Name(result.Ability)} | {EpisodeScript.StateName(expected[result.Ability])} | {EpisodeScript.StateName(result.State)}{mark} | " +
                $"{beforeText} | {quotes} |");
        }

        if (run.Generic is not { } generic)
        {
            return;
        }

        sb.AppendLine();
        sb.AppendLine("**汎用の AI の答え**（特別な指示なし）");
        sb.AppendLine();
        Quote(sb, generic.Answer ?? $"（{generic.Error}）");
        if (generic.Reading is { } reading)
        {
            sb.AppendLine();
            foreach (var ability in reading.Abilities)
            {
                var quotes = ability.Quotes.Count == 0
                    ? "引用なし"
                    : string.Join("、", ability.Quotes.Select(q => $"「{q}」{(GenericComparison.IsVerbatim(run.Turns, q) ? "" : "（一字一句でない）")}"));
                sb.AppendLine($"- {AbilityText.Name(ability.Ability)}: {(ability.Named ? "強みとして挙げた" : "挙げていない")}。{quotes}");
            }
        }
    }

    private static string Cell(string text) => text.ReplaceLineEndings(" ").Replace("|", "｜", StringComparison.Ordinal);

    /// <summary>汎用の AI との比較を、同じ物差しで並べる（合格の線なし）。</summary>
    private static void WriteComparison(StringBuilder sb, GenericComparisonSummary? c)
    {
        if (c is null)
        {
            return;
        }

        sb.AppendLine();
        sb.AppendLine("## 汎用の AI との比較");
        sb.AppendLine();
        sb.AppendLine(
            $"同じ {c.Runs} 件のやりとりを、特別な指示もシステムプロンプトもない同じモデルに渡し、「{GenericComparison.Question}」と尋ねた。" +
            "答えから、どの力を強みとして挙げたかと根拠として引いた言葉を判定役が読み取り、引用が本人の答えに一字一句含まれるかはコードが数えた。合格の線は持たせない。");
        if (c.Unavailable > 0)
        {
            sb.AppendLine();
            sb.AppendLine($"答えを得られなかった例が {c.Unavailable} 件あり、数に入れていない。");
        }

        sb.AppendLine();
        sb.AppendLine("| 物差し | RE:VALUE | 汎用の AI |");
        sb.AppendLine("|---|---|---|");
        sb.AppendLine(
            $"| 褒めすぎ（根拠ありにしてはいけない {c.NotConfirmedTotal} の力のうち、根拠あり・強みとした） | {c.ProductOverPraise} 件 | {c.GenericOverPraise} 件 |");
        sb.AppendLine(
            $"| 根拠の引用が本人の発言と一字一句同じでなかった | {c.ProductQuoteMismatches} 件（{c.ProductQuotes} 中） | {c.GenericQuoteMismatches} 件（{c.GenericQuotes} 中） |");
    }
}
