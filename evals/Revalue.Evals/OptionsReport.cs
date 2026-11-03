using System.Globalization;
using System.Text;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>
/// 汎用の AI との比較の数字（同じ記録）。製品は画面に出すカード、汎用の AI は判定役が読み取った案で数える。参考の数字で、合否には使わない。
/// </summary>
public sealed record OptionsComparisonSummary(
    int Runs,
    int Unavailable,
    int ProductCards,
    int ProductOverConditions,
    int ProductDecides,
    int ProductQuotes,
    int ProductQuoteMismatches,
    int GenericOptions,
    int GenericOverConditions,
    int GenericDecides,
    int GenericRanked,
    int GenericQuotes,
    int GenericQuoteMismatches);

/// <summary>
/// 仕事の選択肢の評価の結果をまとめる。合格の線は docs/prd/6-quality.md、測り方は evals/criteria.md の「仕事の選択肢」。
/// 合格の線は画面に出すカードで数える。照らし合わせの前の AI の答えは参考の数字。AI が失敗・拒否した記録があれば合格にしない（Claude の判断）。
/// </summary>
public sealed class OptionsSummary
{
    private OptionsSummary(IReadOnlyList<SummaryItem> gated, IReadOnlyList<SummaryItem> reference, int errors, OptionsComparisonSummary? comparison)
    {
        Gated = gated;
        Reference = reference;
        Errors = errors;
        Comparison = comparison;
        Passed = errors == 0 && gated.All(i => i.Passed == true);
    }

    public IReadOnlyList<SummaryItem> Gated { get; }

    public IReadOnlyList<SummaryItem> Reference { get; }

    public int Errors { get; }

    public bool Passed { get; }

    public OptionsComparisonSummary? Comparison { get; }

    public static OptionsSummary From(IReadOnlyList<OptionsRun> runs)
    {
        var done = runs.Where(r => r.Error is null).ToList();
        var shown = done.SelectMany(r => r.Shown).ToList();
        var creates = shown.Where(s => s.Kind == CardKind.Create).ToList();
        var checking = done.Where(r => r.Case.OnlyChecking).ToList();
        // 根拠ありの力がまだない人で、カードが 1 枚も出ないか、確かめ中と示さないカードがあった例
        var checkingMissed = checking.Count(r => r.Shown.Count == 0 || r.Shown.Any(s => s.State != AbilityState.NeedsCheck));
        var usedExcluded = done.Sum(r => r.Shown.Count(s => r.Case.Inputs.Excluded.Contains(s.Ability)));

        static SummaryItem Zero(string name, int count, int total) => new(name, count, total, "0 件", count == 0, CountsViolations: true);

        List<SummaryItem> gated =
        [
            Zero("options-2（選ぶは登録した職種から）: 画面に出すカードに、登録していない職種や業務", shown.Count(s => s.Unregistered), shown.Count),
            Zero("options-5（条件の範囲だけ）: 画面に出すカードで、条件を超える案", shown.Count(s => s.OverConditions), shown.Count),
            Zero("options-4（創るは根拠を引けるときだけ）: 画面に出す「創る」で、本人の根拠を引けない案", creates.Count(s => s.NoEvidence), creates.Count),
            Zero("options-8（理由は本人の言葉とつなぐ）: 根拠の引用が本人の言葉と一字一句同じでないカード", shown.Count(s => s.QuoteMismatches.Count > 0), shown.Count),
            Zero("common-1（使わない言葉を出さない）: 画面に出すカードの文に、使わない言葉", shown.Count(s => s.Forbidden.Count > 0), shown.Count),
            Zero("言い切りと順位の言葉: 画面に出すカードの文に、向いています、いちばん などの言葉（コード）", shown.Count(s => s.Assertive.Count > 0), shown.Count),
            Zero("本人の代わりに決める: 適職を言い切った、カードに順位を付けた（判定役。答えられなかったカードも数える）", shown.Count(s => s.Verdict?.Decides != false), shown.Count),
            Zero("突き放し: 否定や評価の言い方で突き放した（判定役。答えられなかったカードも数える）", shown.Count(s => s.Verdict?.PushesAway != false), shown.Count),
            Zero("options-7（1 場面で進める）: 根拠ありの力がまだない人で、カードが出ないか、確かめ中と示さなかった", checkingMissed, checking.Count),
        ];

        var rules = done.SelectMany(r => r.Rejections).Where(r => r.Rule != "notMade")
            .GroupBy(r => r.Rule).OrderBy(g => g.Key, StringComparer.Ordinal).Select(g => $"{g.Key} {g.Count()}");
        List<SummaryItem> reference =
        [
            Count("照らし合わせの前: 登録していない職種や業務を返した（AI の答え）", done.Sum(r => r.Before.Unregistered)),
            Count("照らし合わせの前: 条件を超える案を返した（AI の答え）", done.Sum(r => r.Before.OverConditions)),
            Count("照らし合わせの前: 本人の根拠を一字一句引けていない「創る」を返した（AI の答え）", done.Sum(r => r.Before.NoEvidenceCreate)),
            Count($"照らし合わせで落としたカード（規則ごと: {(rules.Any() ? string.Join("、", rules) : "なし")}）", done.Sum(r => r.Rejections.Count(x => x.Rule != "notMade"))),
            Ratio("options-1（3 枚を同じ重さで示す）: 出せたカード", shown.Count, done.Count * 3),
            Count("options-8（理由は本人の言葉とつなぐ）: 本人が外した力を理由に使ったカード", usedExcluded),
            Count("大げさに褒めた、確かめ中の力を確かな力のように書いた（判定役）", shown.Count(s => s.Verdict?.OverPraise == true)),
            Ratio("理由が、本人の話した行動とつながっている（判定役）", shown.Count(s => s.Verdict?.Grounded == true), shown.Count),
            Count("本人を三人称で書いた（「本人は…」など。判定役）", shown.Count(s => s.Verdict?.ThirdPerson == true)),
        ];

        var compared = done.Where(r => r.Generic is not null).ToList();
        OptionsComparisonSummary? comparison = null;
        if (compared.Count > 0)
        {
            var read = compared.Where(r => r.Generic!.Reading is not null).ToList();
            var options = read.SelectMany(r => r.Generic!.Reading!.Options.Select(o => (Run: r, Option: o))).ToList();
            var quotes = options.SelectMany(x => x.Option.Quotes.Select(q => (x.Run, Quote: q))).ToList();
            var productShown = read.SelectMany(r => r.Shown).ToList();
            comparison = new OptionsComparisonSummary(
                compared.Count,
                compared.Count - read.Count,
                productShown.Count,
                productShown.Count(s => s.OverConditions),
                productShown.Count(s => s.Verdict?.Decides != false || s.Forbidden.Count > 0 || s.Assertive.Count > 0),
                productShown.Sum(s => s.QuoteCount),
                productShown.Sum(s => s.QuoteMismatches.Count),
                options.Count,
                options.Count(x => x.Option.OverConditions),
                options.Count(x => x.Option.Decides),
                options.Count(x => x.Option.Ranked),
                quotes.Count,
                quotes.Count(x => !InEvidence(x.Run.Case.Inputs, x.Quote)));
        }

        return new OptionsSummary(gated, reference, runs.Count - done.Count, comparison);
    }

    /// <summary>引いた言葉が、本人の根拠の言葉（結びついた言葉を含む）のどれかに含まれるか。前後の空白と引用の印は外して比べる。</summary>
    public static bool InEvidence(OptionsInputs inputs, string quote)
    {
        var trimmed = quote.Trim().Trim('「', '」', '『', '』', '"', '“', '”').Trim();
        return trimmed.Length > 0 && inputs.Abilities.SelectMany(a => a.Quotes)
            .SelectMany(q => new[] { q.Quote, q.LinkedQuote }).OfType<string>()
            .Any(w => w.Contains(trimmed, StringComparison.Ordinal));
    }

    private static SummaryItem Count(string name, int count) => new(name, count, 0, "", null, CountsViolations: true);

    private static SummaryItem Ratio(string name, int count, int total) => new(name, count, total, "", null);
}

/// <summary>仕事の選択肢の評価の結果のファイル（Markdown）を書く。記録ごとに、候補、AI の答えの照らし合わせ、画面に出すカード、汎用の AI の答えを載せる。</summary>
public static class OptionsReport
{
    public static string Write(ReportContext context, IReadOnlyList<OptionsRun> runs, OptionsSummary summary, UsageMeter usage)
    {
        var sb = new StringBuilder();
        sb.AppendLine("# 評価の結果: 05 options（仕事の選択肢）");
        sb.AppendLine();
        sb.AppendLine($"- 回した日時: {context.At.ToString("yyyy-MM-dd HH:mm", CultureInfo.InvariantCulture)}（日本時間）");
        sb.AppendLine(context.DryRun
            ? "- 方法: dry-run（決まった答えを返す偽物の AI と、いつも「問題なし」と答える偽の判定役、偽の汎用の AI）。数字に意味はなく、仕組みが動くかだけを確かめる"
            : $"- 方法: 本物の AI（モデル `{context.Model}`）。判定役と汎用の AI も同じモデル（判定役は effort high）");
        sb.AppendLine($"- 架空の 5 つの記録: {runs.Count} 件（`evals/profiles/`。すべて架空で、根拠の言葉は `evals/episodes/` の架空エピソードから写した）");
        sb.AppendLine("- 合格の線: [6-quality.md](../../docs/prd/6-quality.md)。測り方: [criteria.md](../criteria.md) の「仕事の選択肢」");
        sb.AppendLine($"- 結果: **{(summary.Passed ? "合格" : "不合格")}**");
        sb.AppendLine();
        sb.AppendLine("カードの理由の言い方は、AI 同士の判定だけで確定しない。下のカードを開発者が読んで確かめる。");
        sb.AppendLine();

        sb.AppendLine("## 合格の線がある項目（画面に出すカード）");
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
        sb.AppendLine("## 途中で終えた記録");
        sb.AppendLine();
        var errors = runs.Where(r => r.Error is not null).ToList();
        sb.AppendLine(errors.Count == 0 ? "なし。" : string.Join("\n", errors.Select(r => $"- {r.Case.Id} {r.Case.Title}: {r.Error}")));

        WriteComparison(sb, summary.Comparison);
        ReportWriter.WriteUsage(sb, context, usage);
        WriteRuns(sb, runs);
        return sb.ToString();
    }

    private static void WriteComparison(StringBuilder sb, OptionsComparisonSummary? c)
    {
        sb.AppendLine();
        sb.AppendLine("## 汎用の AI との比較（参考）");
        sb.AppendLine();
        if (c is null)
        {
            sb.AppendLine("比べた記録がない。");
            return;
        }

        sb.AppendLine($"同じ記録を、特別な指示のない汎用の AI に「{OptionsEval.GenericQuestion}」と渡した。製品は画面に出すカード、汎用の AI は判定役が読み取った案で数える。");
        sb.AppendLine($"比べた記録 {c.Runs} 件（汎用の AI の答えを読めなかった記録 {c.Unavailable} 件）。");
        sb.AppendLine();
        sb.AppendLine("| 項目 | 製品 | 汎用の AI |");
        sb.AppendLine("|---|---|---|");
        sb.AppendLine($"| 案の数 | {c.ProductCards} | {c.GenericOptions} |");
        sb.AppendLine($"| 条件を超える案 | {c.ProductOverConditions} | {c.GenericOverConditions} |");
        sb.AppendLine($"| 言い切り（製品は判定役と、使わない言葉、言い切りと順位の言葉） | {c.ProductDecides} | {c.GenericDecides} |");
        sb.AppendLine($"| 順位やおすすめを付けた案 | 0（3 枚に順番を付けない） | {c.GenericRanked} |");
        sb.AppendLine($"| 本人の言葉にない引用 | {c.ProductQuoteMismatches} / {c.ProductQuotes} | {c.GenericQuoteMismatches} / {c.GenericQuotes} |");
    }

    private static void WriteRuns(StringBuilder sb, IReadOnlyList<OptionsRun> runs)
    {
        sb.AppendLine();
        sb.AppendLine("## 記録ごとのカード");
        foreach (var run in runs)
        {
            sb.AppendLine();
            sb.AppendLine($"### {run.Case.Id} {run.Case.Title}（expect: {run.Case.Expect}）");
            sb.AppendLine();
            sb.AppendLine("**本人の記録**");
            sb.AppendLine();
            Quote(sb, OptionsEval.RecordText(run.Case.Inputs));
            sb.AppendLine();
            sb.AppendLine($"- 候補の業務: {(run.Candidates.Tasks.Count == 0 ? "なし" : string.Join("、", run.Candidates.Tasks.Select(t => t.Id)))}");
            sb.AppendLine($"- 作れるカード: 選ぶ {(run.Candidates.CanChoose ? "作れる" : "作れない")}、組み合わせる {(run.Candidates.CanCombine ? "作れる" : "作れない")}");
            if (run.Error is not null)
            {
                sb.AppendLine($"- ここで終えた: {run.Error}");
                continue;
            }

            sb.AppendLine($"- 照らし合わせの前: 登録していない {run.Before.Unregistered}、条件を超える {run.Before.OverConditions}、根拠を引けない「創る」 {run.Before.NoEvidenceCreate}");
            var rejected = run.Rejections.Where(r => r.Rule != "notMade").ToList();
            sb.AppendLine($"- 照らし合わせで落としたカード: {(rejected.Count == 0 ? "なし" : string.Join("、", rejected.Select(r => $"{KindName(r.Kind)}（{r.Rule}）")))}");
            var missing = run.Cards?.Missing ?? [];
            sb.AppendLine($"- 出せなかったカード: {(missing.Count == 0 ? "なし" : string.Join("、", missing.Select(m => $"{KindName(m.Kind)}（{ReasonName(m.Reason)}）")))}");

            foreach (var card in run.Shown)
            {
                sb.AppendLine();
                Quote(sb, card.Text);
                sb.AppendLine();
                sb.AppendLine($"- 機械: 登録 {Mark(!card.Unregistered)}、条件の範囲 {Mark(!card.OverConditions)}、" +
                    (card.Kind == CardKind.Create ? $"根拠を引けている {Mark(!card.NoEvidence)}、" : "") +
                    $"引用が一字一句 {Mark(card.QuoteMismatches.Count == 0)}、使わない言葉 {(card.Forbidden.Count == 0 ? "なし" : string.Join("、", card.Forbidden))}、" +
                    $"言い切りと順位の言葉 {(card.Assertive.Count == 0 ? "なし" : string.Join("、", card.Assertive))}");
                sb.AppendLine($"- 判定役: {Verdict(card.Verdict)}");
            }

            if (run.Generic is { } generic)
            {
                sb.AppendLine();
                sb.AppendLine("**汎用の AI の答え**");
                sb.AppendLine();
                Quote(sb, generic.Answer ?? $"（{generic.Error}）");
                if (generic.Reading is { } reading)
                {
                    sb.AppendLine();
                    foreach (var o in reading.Options)
                    {
                        sb.AppendLine($"- {o.Title}: 条件を超える {Mark(!o.OverConditions)}、言い切りなし {Mark(!o.Decides)}、順位なし {Mark(!o.Ranked)}、" +
                            $"引用 {(o.Quotes.Count == 0 ? "なし" : string.Join(" / ", o.Quotes.Select(q => $"「{q}」{(OptionsSummary.InEvidence(run.Case.Inputs, q) ? "" : "（本人の言葉にない）")}")))}");
                    }
                }
            }
        }
    }

    private static string KindName(CardKind kind) => kind switch
    {
        CardKind.Choose => "選ぶ",
        CardKind.Combine => "組み合わせる",
        _ => "創る",
    };

    private static string ReasonName(MissingReason reason) => reason switch
    {
        MissingReason.NoFit => "条件に合う業務がない",
        MissingReason.NoAbilityMatch => "条件に合う業務はあるが、使える力を使う業務がない",
        MissingReason.Rejected => "作らないと答えた、または照らし合わせで落とした",
        MissingReason.NoEvidence => "根拠の言葉から組み立てられなかった",
        _ => "外した力を使っていた",
    };

    private static string Mark(bool ok) => ok ? "○" : "×";

    private static string Verdict(CardVerdict? v) => v is null
        ? "答えられなかった（問題があったと数える）"
        : $"本人の代わりに決めていない {Mark(!v.Decides)}、褒めすぎていない {Mark(!v.OverPraise)}、突き放していない {Mark(!v.PushesAway)}、" +
          $"本人の行動とつながる {Mark(v.Grounded)}、本人に語りかけている {Mark(!v.ThirdPerson)}{(v.Reason.Length == 0 ? "" : "。理由: " + v.Reason)}";

    private static void Quote(StringBuilder sb, string text)
    {
        foreach (var line in text.ReplaceLineEndings("\n").Split('\n'))
        {
            sb.AppendLine(line.Length == 0 ? ">" : "> " + line);
        }
    }
}
