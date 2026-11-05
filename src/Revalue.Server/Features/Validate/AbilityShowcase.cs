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

    /// <summary>一つの場面の「もう少し聞かせてほしいこと」の上限。</summary>
    public const int MaxMoreToHear = 2;

    /// <summary>
    /// 見せる力を決める（どれも Claude の判断）。
    /// 見えた力: 根拠ありの力を分類ごとに分け、分類ごとに <see cref="SeenPerCategory"/> つ。そろった行動の多い力、同じなら辞書の順で前の力。並びは辞書の順。
    /// もう少し聞かせてほしいこと: 要確認の力のうち <see cref="MaxMoreToHear"/> つまで。聞き返した力（<see cref="ValidationContext.Focus"/>）が要確認なら先に置き、
    /// 残りは見せる根拠の多い順、同じなら辞書の順。
    /// </summary>
    public static EpisodeShowcase Of(IReadOnlyList<Turn> turns, IReadOnlyList<Evidence> evidence)
    {
        var results = AbilityStates.Evaluate(evidence);

        var seen = results
            .Where(r => r.State == AbilityState.Confirmed)
            .GroupBy(r => AbilityCatalog.Category(r.Ability))
            .SelectMany(g => g.OrderByDescending(r => r.Shown.Count).ThenBy(r => r.Ability).Take(SeenPerCategory))
            .OrderBy(r => r.Ability)
            .ToList();

        var focus = ValidationContext.From(turns, evidence).Focus;
        var moreToHear = results
            .Where(r => r.State == AbilityState.NeedsCheck)
            .OrderByDescending(r => r.Ability == focus)
            .ThenByDescending(r => r.Shown.Count)
            .ThenBy(r => r.Ability)
            .Take(MaxMoreToHear)
            .ToList();

        return new EpisodeShowcase(seen, moreToHear);
    }
}
