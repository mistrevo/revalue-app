using Revalue.Server.Features.Discover;

namespace Revalue.Server.Features.Validate;

/// <summary>
/// 読み取りの AI が返す、核となる行動の根拠の候補。コード（<see cref="EvidenceChecker"/>）が照らし合わせるまでは使わない。
/// </summary>
/// <param name="Action">核となる行動の番号（1〜3）。</param>
/// <param name="Quote">根拠になる本人の言葉。</param>
/// <param name="Answer">何番目の本人の答えか（1 から。本人のターンだけを数える）。</param>
/// <param name="Event">場面の中の、何番目の具体的な出来事か（1 から）。</param>
/// <param name="General">「いつも〜している」のような一般論として話されたか。</param>
/// <param name="LinkedQuote">選んだ答えを根拠にするとき、結びつく自由な答えか訂正の言葉。なければ空。</param>
/// <param name="LinkedAnswer"><paramref name="LinkedQuote"/> が何番目の本人の答えか。なければ 0。</param>
public sealed record EvidenceCandidate(
    Ability Ability, int Action, string Quote, int Answer, int Event, bool General, string LinkedQuote, int LinkedAnswer);

/// <summary>照らし合わせを通った根拠。場面に保存する形。</summary>
/// <param name="FromChoice">選んだ答えの言葉か。true のときは <paramref name="LinkedQuote"/> に結びついた本人の言葉がある。</param>
/// <param name="LinkedQuote">選んだ答えに結びついた、自由な答えか訂正の言葉。自由な答えと訂正の根拠では null。</param>
public sealed record Evidence(
    Ability Ability, int Action, string Quote, int Answer, int Event, bool General, bool FromChoice, string? LinkedQuote);

/// <summary>
/// AI の返した根拠の候補を、本人の答えと照らし合わせる（03-validate.md の「根拠として使える言葉」）。
/// 本人の答えに一字一句含まれない言葉、範囲外の番号、結びつく言葉のない選んだ答えは捨てる。例外にはしない。
/// </summary>
public static class EvidenceChecker
{
    public static IReadOnlyList<Evidence> Check(IReadOnlyList<Turn> turns, IEnumerable<EvidenceCandidate>? candidates)
    {
        var answers = turns.Where(t => t.Role == TurnRoles.User).ToList();
        var kept = new List<Evidence>();
        foreach (var c in candidates ?? [])
        {
            if (c is null
                || !Enum.IsDefined(c.Ability)
                || c.Action is < 1 or > ActionRef.ActionsPerAbility
                || c.Event < 1
                || !Contains(answers, c.Answer, c.Quote))
            {
                continue;
            }

            if (answers[c.Answer - 1].AnswerKind == AnswerKind.Choice)
            {
                // 選んだだけでは根拠にしない。結びつく自由な答えか訂正の言葉が、一字一句あるときだけ使う（validate-5）
                if (c.LinkedAnswer == c.Answer
                    || !Contains(answers, c.LinkedAnswer, c.LinkedQuote)
                    || answers[c.LinkedAnswer - 1].AnswerKind == AnswerKind.Choice)
                {
                    continue;
                }

                kept.Add(new Evidence(c.Ability, c.Action, c.Quote, c.Answer, c.Event, c.General, FromChoice: true, c.LinkedQuote));
            }
            else
            {
                kept.Add(new Evidence(c.Ability, c.Action, c.Quote, c.Answer, c.Event, c.General, FromChoice: false, LinkedQuote: null));
            }
        }

        return kept;
    }

    /// <summary><paramref name="number"/> 番目の本人の答えに、<paramref name="quote"/> が一字一句含まれるか。</summary>
    private static bool Contains(List<Turn> answers, int number, string? quote) =>
        number >= 1 && number <= answers.Count
        && !string.IsNullOrWhiteSpace(quote)
        && answers[number - 1].Text.Contains(quote, StringComparison.Ordinal);
}

/// <summary>場面の根拠の集まり。</summary>
public static class EvidenceSet
{
    /// <summary>
    /// 前の根拠に、新しく見つかった根拠を足す。同じ（力、行動、引用、答えの番号）は 1 つにし、前のものを残す。
    /// 前の根拠は消さない（会話の途中で見立てが行ったり来たりしないように）。
    /// </summary>
    public static IReadOnlyList<Evidence> Merge(IReadOnlyList<Evidence> known, IReadOnlyList<Evidence> found)
    {
        var merged = new List<Evidence>(known);
        var seen = known.Select(KeyOf).ToHashSet();
        foreach (var evidence in found)
        {
            if (seen.Add(KeyOf(evidence)))
            {
                merged.Add(evidence);
            }
        }

        return merged;
    }

    private static (Ability, int, string, int) KeyOf(Evidence e) => (e.Ability, e.Action, e.Quote, e.Answer);
}
