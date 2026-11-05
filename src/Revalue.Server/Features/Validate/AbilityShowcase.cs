using Revalue.Server.Features.Discover;

namespace Revalue.Server.Features.Validate;

/// <summary>一つの場面から本人に見せる力。</summary>
/// <param name="Seen">「この話から見えた力」（根拠あり）。辞書の順。</param>
/// <param name="MoreToHear">「もう少し聞かせてほしいこと」（要確認）。聞く順。</param>
public sealed record EpisodeShowcase(IReadOnlyList<AbilityResult> Seen, IReadOnlyList<AbilityResult> MoreToHear)
{
    /// <summary>見せる力（<see cref="Seen"/> と <see cref="MoreToHear"/>）か。</summary>
    public bool Shows(Ability ability) => Seen.Any(r => r.Ability == ability) || MoreToHear.Any(r => r.Ability == ability);
}

/// <summary>
/// 一つの場面から見せる力を絞る（4-rules.md の「画面での見せ方」、03-validate.md の「話し終えたとき」）。
/// 話から確かめる力が多いので、似た力が並んで褒めすぎに見えないよう、また採点表に見えないよう、見せる数を決める。
/// 本人が力を見るすべての所（話す画面の見えたこと、見えた力の画面と履歴、できること、カード、深める、レポート）は、ここを通った力だけを使う。
/// 見せない力の根拠は、場面にはそのまま残す。
/// </summary>
public static class AbilityShowcase
{
    /// <summary>一つの場面から見せる根拠ありの力の、分類ごとの上限。</summary>
    public const int SeenPerCategory = 1;

    /// <summary>一つの場面から見せる根拠ありの力の、場面全体の上限（Claude の判断）。分類が多いので、分類ごとの上限だけでは一つの話に力が並びすぎるため。</summary>
    public const int MaxSeen = 3;

    /// <summary>一つの場面の「もう少し聞かせてほしいこと」の上限。</summary>
    public const int MaxMoreToHear = 2;

    /// <summary>
    /// 見せる力を決める（どれも Claude の判断）。
    /// 見えた力: 根拠ありの力から <see cref="SelectSeen"/> で選ぶ。並びは辞書の順。
    /// もう少し聞かせてほしいこと: 要確認の力のうち、そろえば見えた力に出せる力（<see cref="CouldBeSeen"/>）を <see cref="MaxMoreToHear"/> つまで。
    /// 聞き返した力（<see cref="ValidationContext.Focus"/>）が入っていれば先に置き、残りは見せる根拠の多い順、同じなら辞書の順。
    /// </summary>
    public static EpisodeShowcase Of(IReadOnlyList<Turn> turns, IReadOnlyList<Evidence> evidence)
    {
        var results = AbilityStates.Evaluate(evidence);

        var seenAbilities = SelectSeen(results.Where(r => r.State == AbilityState.Confirmed).Select(r => r.Ability)).ToHashSet();
        var seen = results.Where(r => seenAbilities.Contains(r.Ability)).OrderBy(r => r.Ability).ToList();

        var focus = ValidationContext.From(turns, evidence).Focus;
        var moreToHear = results
            .Where(r => r.State == AbilityState.NeedsCheck && CouldBeSeen(r.Ability, results))
            .OrderByDescending(r => r.Ability == focus)
            .ThenByDescending(r => r.Shown.Count)
            .ThenBy(r => r.Ability)
            .Take(MaxMoreToHear)
            .ToList();

        return new EpisodeShowcase(seen, moreToHear);
    }

    /// <summary>
    /// その力の行動がこの場面でそろったら、見えた力に出せるか。ほかの根拠ありの力に、この力がそろったものとして加え、<see cref="SelectSeen"/> で選び直して確かめる。
    /// 同じ分類で行動の多い力（同じ数なら辞書の順で前の力）がそろっている力や、場面全体の上限からこぼれる力は、聞き返しても本人に見せられない。
    /// そうした力は、もう少し聞かせてほしいことに出さず、足りない行動も聞かない（03-validate.md の「次の一手」。Claude の判断）。
    /// </summary>
    /// <param name="results">この場面の力ごとの状態（<see cref="AbilityStates.Evaluate"/>）。</param>
    public static bool CouldBeSeen(Ability ability, IReadOnlyList<AbilityResult> results) =>
        AbilityCatalog.IsActive(ability)
        && SelectSeen(results.Where(r => r.State == AbilityState.Confirmed && r.Ability != ability).Select(r => r.Ability).Append(ability))
            .Contains(ability);

    /// <summary>
    /// 根拠ありの力から、見えた力を選ぶ。分類ごとに <see cref="SeenPerCategory"/> つ、場面全体で <see cref="MaxSeen"/> つまで。
    /// どちらも、そろった行動の多い力（根拠ありなら行動の数）、同じなら辞書の順で前の力を選ぶ。
    /// </summary>
    private static IEnumerable<Ability> SelectSeen(IEnumerable<Ability> confirmed) =>
        confirmed
            .GroupBy(AbilityCatalog.Category)
            .SelectMany(g => g.OrderByDescending(AbilityCatalog.ActionCount).ThenBy(a => a).Take(SeenPerCategory))
            .OrderByDescending(AbilityCatalog.ActionCount)
            .ThenBy(a => a)
            .Take(MaxSeen);
}
