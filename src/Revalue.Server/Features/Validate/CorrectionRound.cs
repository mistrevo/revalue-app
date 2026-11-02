using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Features.Validate;

/// <summary>
/// 訂正を読み直した結果。<paramref name="ErrorKind"/> があれば（<see cref="ConversationAiException.Failure"/> か
/// <see cref="ConversationAiException.Refusal"/>）、読み取りは失敗で、何も保存しない。
/// </summary>
/// <param name="Evidence">場面全体を読み直して照らし合わせを通った根拠。前の根拠とは合わせず、これで置き換える。</param>
public sealed record CorrectionOutcome(TurnReading? Reading, IReadOnlyList<Evidence> Evidence, string? ErrorKind);

/// <summary>
/// 訂正の中身（保存を除く）。訂正を足した場面全体を AI が読み直し、根拠の候補を本人の言葉と照らし合わせる（03-validate.md の「訂正」）。
/// 製品（/api/episodes/{id}/corrections）と評価の両方がこれを使う。AI を呼ぶのは読み取りの 1 回だけ。
/// </summary>
public static class CorrectionRound
{
    /// <param name="turnsWithCorrection">場面のやりとり。最後は、いま届いた訂正（<see cref="AnswerKind.Correction"/>）。</param>
    public static async Task<CorrectionOutcome> RunAsync(IConversationAi ai, IReadOnlyList<Turn> turnsWithCorrection, CancellationToken ct)
    {
        TurnReading reading;
        try
        {
            reading = await ai.ReadAsync(turnsWithCorrection, ct);
        }
        catch (ConversationAiException e)
        {
            return new CorrectionOutcome(null, [], e.Kind);
        }
        catch (Exception e) when (e is not OperationCanceledException || !ct.IsCancellationRequested)
        {
            // 決めていない例外も不調として扱う。中身は持たない
            return new CorrectionOutcome(null, [], ConversationAiException.Failure);
        }

        return new CorrectionOutcome(reading, EvidenceChecker.Check(turnsWithCorrection, reading.Candidates), null);
    }

    /// <summary>
    /// 訂正で打ち消された行動: 訂正の前の根拠にあり、読み直したあとの根拠にない行動（力と行動の番号の順）。
    /// 訂正の読み直しで、読み取りが訂正と関係なく落とした行動もここに入る。どちらも本人がもう話した行動なので、聞き直さない側に倒す（Claude の判断）。
    /// </summary>
    public static IReadOnlyList<ActionRef> Withdrawn(IReadOnlyList<Evidence> before, IReadOnlyList<Evidence> after)
    {
        var kept = after.Select(e => new ActionRef(e.Ability, e.Action)).ToHashSet();
        return before
            .Select(e => new ActionRef(e.Ability, e.Action))
            .Where(a => !kept.Contains(a))
            .Distinct()
            .OrderBy(a => a.Ability)
            .ThenBy(a => a.Number)
            .ToList();
    }

    /// <summary>場面の訂正のターンに残した、訂正で打ち消された行動すべて。形の合わない印は読まない。</summary>
    public static IReadOnlySet<ActionRef> WithdrawnIn(IEnumerable<Turn> turns) =>
        turns
            .Where(t => t.Role == TurnRoles.User && t.Withdrawn is not null)
            .SelectMany(t => t.Withdrawn!)
            .Select(ActionRef.Parse)
            .OfType<ActionRef>()
            .ToHashSet();
}
