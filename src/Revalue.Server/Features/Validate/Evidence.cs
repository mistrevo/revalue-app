using System.Globalization;
using System.Text;
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
/// <param name="Event">
/// 何番目の具体的な出来事か。番号は読み取りの AI が毎回振り直すので、その読み取り（<paramref name="Reading"/>）の中でだけ意味を持つ。
/// 同じ出来事かどうかは、（<paramref name="Reading"/>、<paramref name="Event"/>）の組で見分ける。
/// </param>
/// <param name="FromChoice">選んだ答えの言葉か。true のときは <paramref name="LinkedQuote"/> に結びついた本人の言葉がある。</param>
/// <param name="LinkedQuote">選んだ答えに結びついた、自由な答えか訂正の言葉。自由な答えと訂正の根拠では null。</param>
/// <param name="Reading">
/// どの読み取りで見つかったか。読み取ったときの本人の答えの数（1 往復ごとと訂正ごとに増えるので、場面の中で読み取りごとに違う）。
/// この印のない前の根拠は 0 として読む。
/// </param>
public sealed record Evidence(
    Ability Ability, int Action, string Quote, int Answer, int Event, bool General, bool FromChoice, string? LinkedQuote, int Reading = 0);

/// <summary>
/// AI の返した根拠の候補を、本人の答えと照らし合わせる（03-validate.md の「根拠として使える言葉」）。
/// 本人の答えに一字一句含まれない言葉、短すぎる言葉、範囲外の番号、結びつく言葉のない選んだ答えは捨てる。例外にはしない。
/// </summary>
public static class EvidenceChecker
{
    /// <summary>
    /// 引用（と、選んだ答えに結びつく言葉）に求める、空白と句読点・記号を除いた文字の数の下限（Claude の判断）。
    /// 「て」のような 1 文字の助詞など、それだけでは意味の分からない言葉で根拠ありにしないため。
    /// 一字一句の照らし合わせだけでは、読み取りの AI がどの行動にも同じ短い言葉を返したときに防げない。
    /// </summary>
    public const int MinQuoteLetters = 4;

    /// <summary>空白と句読点・記号を除いた文字の数。濁点を合成したかなのような、合成された文字は 1 文字と数える。</summary>
    public static int Letters(string? text)
    {
        if (string.IsNullOrEmpty(text))
        {
            return 0;
        }

        var count = 0;
        var elements = StringInfo.GetTextElementEnumerator(text);
        while (elements.MoveNext())
        {
            if (Rune.IsLetterOrDigit(Rune.GetRuneAt(elements.GetTextElement(), 0)))
            {
                count++;
            }
        }

        return count;
    }

    /// <summary>引用か、結びつく言葉（あれば）が、<see cref="MinQuoteLetters"/> に満たない候補か。評価で、読み取りが短すぎる言葉を返した数を数えるのに使う。</summary>
    public static bool IsTooShort(EvidenceCandidate candidate) =>
        Letters(candidate.Quote) < MinQuoteLetters
        || (!string.IsNullOrEmpty(candidate.LinkedQuote) && Letters(candidate.LinkedQuote) < MinQuoteLetters);

    public static IReadOnlyList<Evidence> Check(IReadOnlyList<Turn> turns, IEnumerable<EvidenceCandidate>? candidates)
    {
        var answers = turns.Where(t => t.Role == TurnRoles.User).ToList();
        var reading = answers.Count;
        var kept = new List<Evidence>();
        foreach (var c in candidates ?? [])
        {
            if (c is null
                || !AbilityCatalog.Active.Contains(c.Ability)
                || c.Action < 1
                || c.Action > AbilityCatalog.ActionCount(c.Ability)
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

                kept.Add(new Evidence(c.Ability, c.Action, c.Quote, c.Answer, c.Event, c.General, FromChoice: true, c.LinkedQuote, reading));
            }
            else
            {
                kept.Add(new Evidence(c.Ability, c.Action, c.Quote, c.Answer, c.Event, c.General, FromChoice: false, LinkedQuote: null, reading));
            }
        }

        return kept;
    }

    /// <summary>
    /// <paramref name="number"/> 番目の本人の答えに、<paramref name="quote"/> が一字一句含まれ、
    /// 空白と記号を除いて <see cref="MinQuoteLetters"/> 文字以上あるか。
    /// </summary>
    private static bool Contains(List<Turn> answers, int number, string? quote) =>
        number >= 1 && number <= answers.Count
        && !string.IsNullOrWhiteSpace(quote)
        && Letters(quote) >= MinQuoteLetters
        && answers[number - 1].Text.Contains(quote, StringComparison.Ordinal);
}

/// <summary>場面の根拠の集まり。</summary>
public static class EvidenceSet
{
    /// <summary>
    /// 前の根拠に、新しい読み取りで見つかった根拠を足す（03-validate.md の「1 往復の中の確かめ」）。
    /// 出来事の番号は読み取りごとに振り直されるので、新しい読み取りの根拠は前の根拠と混ぜず、その番号のまま足す（同じものは 1 つにする）。
    /// 前の根拠は消さない（会話の途中で見立てが行ったり来たりしないように）。ただし、前の読み取りの出来事のうち、
    /// 力ごとの中身（行動、引用、答えの番号、一般論か、選んだ答えか）が新しい読み取りのある出来事にすべて含まれるものは、残さない。
    /// 新しい出来事のほうが行動が同じか多く、同じ数なら新しい読み取りが先に選ばれるので、残さなくても状態と見せる根拠は変わらない。
    /// </summary>
    public static IReadOnlyList<Evidence> Merge(IReadOnlyList<Evidence> known, IReadOnlyList<Evidence> found)
    {
        var added = found.Distinct().ToList();
        var newGroups = added
            .GroupBy(GroupOf)
            .Select(g => (g.Key.Ability, Contents: g.Select(ContentOf).ToHashSet()))
            .ToList();
        var newKeys = added.Select(GroupOf).ToHashSet();

        var covered = known
            .GroupBy(GroupOf)
            .Where(g => !newKeys.Contains(g.Key)
                && newGroups.Any(n => n.Ability == g.Key.Ability && g.All(e => n.Contents.Contains(ContentOf(e)))))
            .Select(g => g.Key)
            .ToHashSet();

        var merged = known.Where(e => !covered.Contains(GroupOf(e))).ToList();
        var seen = merged.ToHashSet();
        merged.AddRange(added.Where(seen.Add));
        return merged;
    }

    /// <summary>力ごとの、一回の読み取りの中の一つの出来事。</summary>
    private static (Ability Ability, int Reading, int Event) GroupOf(Evidence e) => (e.Ability, e.Reading, e.Event);

    /// <summary>読み取りと出来事の番号を除いた中身。</summary>
    private static (int, string, int, bool, bool, string?) ContentOf(Evidence e) =>
        (e.Action, e.Quote, e.Answer, e.General, e.FromChoice, e.LinkedQuote);
}
