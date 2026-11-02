namespace Revalue.Server.Features.Validate;

/// <summary>場面の中の、一つの力の状態。</summary>
/// <param name="Shown">見せる根拠。行動ごとに 1 つ、行動の番号の順。</param>
/// <param name="Missing">足りない行動の番号（小さい順）。根拠ありと未確認では空。</param>
public sealed record AbilityResult(Ability Ability, AbilityState State, IReadOnlyList<Evidence> Shown, IReadOnlyList<int> Missing);

/// <summary>場面の根拠から、力ごとの状態を決める（03-validate.md の「力の状態」）。</summary>
public static class AbilityStates
{
    private static readonly int[] AllActions = [.. Enumerable.Range(1, ActionRef.ActionsPerAbility)];

    /// <summary>3 つの力を <see cref="Ability"/> の順で返す。</summary>
    public static IReadOnlyList<AbilityResult> Evaluate(IReadOnlyList<Evidence> evidence) =>
        Enum.GetValues<Ability>().Select(a => EvaluateOne(a, evidence.Where(e => e.Ability == a).ToList())).ToList();

    private static AbilityResult EvaluateOne(Ability ability, List<Evidence> evidence)
    {
        if (evidence.Count == 0)
        {
            return new AbilityResult(ability, AbilityState.NotYet, [], []);
        }

        // 一般論でない根拠を、出来事ごとにまとめる。出来事の番号は読み取りごとに振り直されるので、読み取りと番号の組で見分ける
        // （別の読み取りの同じ番号を同じ出来事にすると、別の日の行動がそろってしまう）。
        // 行動の数が多い順、同じ数なら新しい読み取り、番号の大きい出来事を先に
        var events = evidence
            .Where(e => !e.General)
            .GroupBy(e => (e.Reading, e.Event))
            .Select(g => (g.Key.Reading, g.Key.Event, Shown: OnePerAction(g)))
            .OrderByDescending(g => g.Shown.Count)
            .ThenByDescending(g => g.Reading)
            .ThenByDescending(g => g.Event)
            .ToList();

        if (events.Count > 0)
        {
            var best = events[0];
            if (best.Shown.Count == ActionRef.ActionsPerAbility)
            {
                return new AbilityResult(ability, AbilityState.Confirmed, best.Shown, []);
            }

            return new AbilityResult(ability, AbilityState.NeedsCheck, best.Shown, MissingOf(best.Shown));
        }

        // 一般論の根拠だけ。3 つあっても根拠ありにしない（validate-10）
        var general = OnePerAction(evidence);
        return new AbilityResult(ability, AbilityState.NeedsCheck, general, MissingOf(general));
    }

    /// <summary>
    /// 足りない行動を聞く順（03-validate.md の「次の一手」）。この場面のどこにも一般論でない根拠がない行動を先に、同じなら番号の小さい順。
    /// 読み取りが前の答えの行動を落とすと、その行動はいまの出来事では足りないことになるが、本人はもう話している。聞き直すのを後にする（Claude の判断）。
    /// </summary>
    /// <param name="missing">いまの出来事で足りない行動の番号。</param>
    /// <param name="evidence">この場面の根拠すべて。</param>
    public static IEnumerable<ActionRef> AskOrder(Ability ability, IEnumerable<int> missing, IReadOnlyList<Evidence> evidence)
    {
        var told = evidence.Where(e => !e.General && e.Ability == ability).Select(e => e.Action).ToHashSet();
        return missing.Order().OrderBy(told.Contains).Select(n => new ActionRef(ability, n)).ToList();
    }

    /// <summary>行動ごとに 1 つ（答えの番号が小さいもの）を、行動の番号の順に。</summary>
    private static List<Evidence> OnePerAction(IEnumerable<Evidence> evidence) =>
        evidence
            .GroupBy(e => e.Action)
            .OrderBy(g => g.Key)
            .Select(g => g.OrderBy(e => e.Answer).First())
            .ToList();

    private static int[] MissingOf(List<Evidence> shown) =>
        AllActions.Where(n => shown.All(e => e.Action != n)).ToArray();
}
