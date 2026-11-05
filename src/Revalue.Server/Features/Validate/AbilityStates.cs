namespace Revalue.Server.Features.Validate;

/// <summary>場面の中の、一つの力の状態。</summary>
/// <param name="Shown">見せる根拠。行動ごとに 1 つ、行動の番号の順。</param>
/// <param name="Missing">足りない行動の番号（小さい順）。根拠ありと未確認では空。</param>
public sealed record AbilityResult(Ability Ability, AbilityState State, IReadOnlyList<Evidence> Shown, IReadOnlyList<int> Missing);

/// <summary>場面の根拠から、力ごとの状態を決める（03-validate.md の「力の状態」）。</summary>
public static class AbilityStates
{
    /// <summary>話から確かめる力を <see cref="AbilityCatalog"/> の順で返す。</summary>
    public static IReadOnlyList<AbilityResult> Evaluate(IReadOnlyList<Evidence> evidence) =>
        AbilityCatalog.Active.Select(a => EvaluateOne(a, evidence.Where(e => e.Ability == a).ToList())).ToList();

    private static AbilityResult EvaluateOne(Ability ability, List<Evidence> evidence)
    {
        // 本人の行動（状況の行動でない行動）の根拠が一つもない力は、未確認にする。状況の行動（用事が重なる、など）は本人がしたことではないので、
        // それだけで力の名前を、もう少し聞かせてほしいこと・見えた力・できること・カードに出さない（4-rules.md の未確認。Claude の判断）。
        // 状況の行動の根拠は場面に残し、本人の行動がそろえば数える
        if (!evidence.Any(IsOwnAction))
        {
            return new AbilityResult(ability, AbilityState.NotYet, [], []);
        }

        // 一般論でない根拠を、出来事ごとにまとめる。出来事の番号は読み取りごとに振り直されるので、読み取りと番号の組で見分ける
        // （別の読み取りの同じ番号を同じ出来事にすると、別の日の行動がそろってしまう）。
        // 本人の行動の根拠がない出来事は使わない。行動の数が多い順、同じ数なら新しい読み取り、番号の大きい出来事を先に
        var events = evidence
            .Where(e => !e.General)
            .GroupBy(e => (e.Reading, e.Event))
            .Select(g => (g.Key.Reading, g.Key.Event, Shown: Counted(g)))
            .Where(g => g.Shown.Any(IsOwnAction))
            .OrderByDescending(g => g.Shown.Count)
            .ThenByDescending(g => g.Reading)
            .ThenByDescending(g => g.Event)
            .ToList();

        if (events.Count > 0)
        {
            var best = events[0];
            if (best.Shown.Count == AbilityCatalog.ActionCount(ability))
            {
                return new AbilityResult(ability, AbilityState.Confirmed, best.Shown, []);
            }

            return new AbilityResult(ability, AbilityState.NeedsCheck, best.Shown, MissingOf(ability, best.Shown));
        }

        // 一般論の根拠だけ。すべての行動にあっても根拠ありにしない（validate-10）。本人の行動が一般論にもなければ未確認
        var general = OnePerAction(evidence.Where(e => e.General));
        if (!general.Any(IsOwnAction))
        {
            return new AbilityResult(ability, AbilityState.NotYet, [], []);
        }

        return new AbilityResult(ability, AbilityState.NeedsCheck, general, MissingOf(ability, general));
    }

    /// <summary>本人の行動の根拠か（状況の行動 <see cref="AbilityCatalog.IsSituation"/> でない）。</summary>
    private static bool IsOwnAction(Evidence e) => !AbilityCatalog.IsSituation(new ActionRef(e.Ability, e.Action));

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

    /// <summary>
    /// 一つの出来事の根拠のうち、数える根拠。行動ごとに 1 つ（答えの番号が小さいもの）を、行動の番号の順に。
    /// ただしすべての行動がそろったときは、行動ごとに 1 つずつ選んだ組のうち、ほかの行動の引用をすべて含む引用がない組だけを数える。
    /// 行動が 2 つなら、一方の引用がもう一方の引用を含む組（同じ引用の組も）は数えない。
    /// 組は、行動の番号の順に、答えの番号が小さい根拠から試し、最初に見つかった組を数える。含む引用を同じ行動の別の引用に差し替えても、
    /// 差し替えた引用がほかの行動の引用に含まれることがあるので、組ごとに全体を確かめる。どの組でも含む引用が残るなら、行動ごとに答えの番号が
    /// 小さい根拠を選んだ組から、ほかの行動の引用をすべて含む引用（いくつもあれば行動の番号が小さいもの）を除き、その行動を足りないことにする。
    /// 読み取りの AI が一つの句を切り分けてすべての行動に当てると、行動がそろっていないのに根拠ありになるため（validate-1。Claude の判断）。
    /// 状況の行動を持つ力は、本人の行動どうしでも同じように比べる。本人の行動が 2 つなら、一方の引用がもう一方の引用を含む組（同じ引用の組も）は数えない。
    /// 状況の句と、本人の行動 2 つに当てた一つの句とで、根拠ありにしないため（Claude の判断）。
    /// 次の一手（<see cref="Discover.NextMovePolicy"/>）も、この数え方で足りない行動を決める。
    /// </summary>
    public static IReadOnlyList<Evidence> Counted(IEnumerable<Evidence> evidence)
    {
        // 行動ごとの候補。答えの番号が小さい順（同じなら渡された順）。同じ引用は含むかどうかが変わらないので、先の 1 つだけを試す
        var candidates = evidence
            .GroupBy(e => e.Action)
            .OrderBy(g => g.Key)
            .Select(g => g.OrderBy(e => e.Answer).DistinctBy(OwnWords).ToList())
            .ToList();
        var first = candidates.Select(c => c[0]).ToList();
        if (first.Count == 0 || first.Count != AbilityCatalog.ActionCount(first[0].Ability))
        {
            return first;
        }

        if (FirstCombinationWithoutContainer(candidates) is { } counted)
        {
            return counted;
        }

        var container = Enumerable.Range(0, first.Count).First(i => IsContainer(first, i));
        return [.. first.Where((_, i) => i != container)];
    }

    /// <summary>
    /// 行動ごとに候補から 1 つずつ選んだ組のうち、ほかの行動の引用をすべて含む引用がない最初の組。
    /// 行動の番号の順に、答えの番号が小さい候補から試す（行動は 2〜3 つで候補も少ないので、組をすべて試してよい）。なければ null。
    /// </summary>
    private static List<Evidence>? FirstCombinationWithoutContainer(IReadOnlyList<IReadOnlyList<Evidence>> candidates)
    {
        var picked = new Evidence[candidates.Count];
        return Pick(0) ? [.. picked] : null;

        bool Pick(int action)
        {
            if (action == candidates.Count)
            {
                return !Enumerable.Range(0, picked.Length).Any(i => IsContainer(picked, i));
            }

            foreach (var candidate in candidates[action])
            {
                picked[action] = candidate;
                if (Pick(action + 1))
                {
                    return true;
                }
            }

            return false;
        }
    }

    /// <summary>
    /// 組の <paramref name="index"/> 番目の引用を数えないか。組のほかの引用をすべて含むときと、本人の行動の引用が組のほかの本人の行動の引用を
    /// すべて含むとき。同じ引用も含むものとして数える。状況の行動を持たない力では、二つの条件は同じになる。
    /// </summary>
    private static bool IsContainer(IReadOnlyList<Evidence> combination, int index)
    {
        var others = Enumerable.Range(0, combination.Count).Where(j => j != index).ToList();
        if (others.All(j => Covers(combination[index], combination[j])))
        {
            return true;
        }

        var otherOwn = others.Where(j => IsOwnAction(combination[j])).ToList();
        return IsOwnAction(combination[index]) && otherOwn.Count > 0 && otherOwn.All(j => Covers(combination[index], combination[j]));
    }

    private static bool Covers(Evidence outer, Evidence inner) => OwnWords(outer).Contains(OwnWords(inner), StringComparison.Ordinal);

    /// <summary>
    /// 含むかどうかを比べる、本人の言葉。選んだ答えは、それだけでは根拠にならず、結びついた本人の言葉で根拠になるので、結びついた言葉で比べる
    /// （validate-5（選んだだけでは根拠にしない））。一方の行動を自由な答えの句、もう一方を同じ句に結びつけた選んだ答えにして、
    /// 一つの句で行動をそろえないため（Claude の判断）。
    /// </summary>
    private static string OwnWords(Evidence e) => e.FromChoice && !string.IsNullOrEmpty(e.LinkedQuote) ? e.LinkedQuote : e.Quote;

    /// <summary>行動ごとに 1 つ（答えの番号が小さいもの）を、行動の番号の順に。</summary>
    private static List<Evidence> OnePerAction(IEnumerable<Evidence> evidence) =>
        evidence
            .GroupBy(e => e.Action)
            .OrderBy(g => g.Key)
            .Select(g => g.OrderBy(e => e.Answer).First())
            .ToList();

    private static int[] MissingOf(Ability ability, IReadOnlyList<Evidence> shown) =>
        Enumerable.Range(1, AbilityCatalog.ActionCount(ability)).Where(n => shown.All(e => e.Action != n)).ToArray();
}
