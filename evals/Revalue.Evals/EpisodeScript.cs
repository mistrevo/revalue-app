using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>
/// 台本の 1 行。<see cref="IsChoice"/> なら選んだ答えとして送る（<see cref="Text"/> が空なら、直前の返事の選択肢の 1 つ目を選ぶ）。
/// <see cref="IsCorrection"/> なら、そこまでの場面に訂正として送る。
/// </summary>
public sealed record ScriptedAnswer(string Text, bool IsChoice, bool IsCorrection = false);

/// <summary>
/// 架空エピソード 1 件（evals/episodes/*.md）。
/// 先頭の --- で囲んだところに id、title、unit、expect を書き、「## 利用者の答え」の下に 1 行 1 ターンで答えを並べる。
/// 選択肢で答える行は「[選択]」で始め、訂正の行は「[訂正]」で始める。訂正の行は、ほかの答えのあとにだけ置ける。
/// 03 validate（確かめる）の例は、states（狙った力の、最後に期待する状態）、notConfirmed（根拠ありにしてはいけない力）、
/// statesBefore（最初の訂正の直前に期待する、狙った力の状態）、ask（聞き返してほしい行動）も書く。話から確かめる力すべての状態は書かない。
/// </summary>
/// <param name="Expect">どんな例か。concreteEvent、dontKnow、generalOnly、familyIllness、distress、choiceOnly など。</param>
public sealed record EpisodeScript(string Id, string Title, string Unit, string Expect, IReadOnlyList<ScriptedAnswer> Answers)
{
    public const string AnswersHeading = "## 利用者の答え";
    public const string ChoiceMarker = "[選択]";
    public const string CorrectionMarker = "[訂正]";

    /// <summary>場面を最後まで流したあとに期待する、狙った力の状態（1 つ以上）。書いていなければ null。</summary>
    public IReadOnlyDictionary<Ability, AbilityState>? States { get; init; }

    /// <summary>最初の訂正の直前に期待する、狙った力の状態。訂正のある例だけ。</summary>
    public IReadOnlyDictionary<Ability, AbilityState>? StatesBefore { get; init; }

    /// <summary>
    /// 根拠ありにしてはいけない力。書いていなければ空。<c>*</c> は、話から確かめるすべての力から、<see cref="States"/> で confirmed の力を除いたもの。
    /// </summary>
    public IReadOnlySet<Ability> NotConfirmed { get; init; } = new HashSet<Ability>();

    /// <summary>台本に書いた力（<see cref="States"/> のキーと <see cref="NotConfirmed"/>）。評価はこの力だけを数える。</summary>
    public IReadOnlySet<Ability> Listed => (States?.Keys ?? []).Concat(NotConfirmed).ToHashSet();

    /// <summary>
    /// 根拠ありになったら褒めすぎと数える力。<see cref="States"/> で confirmed でない力と、<see cref="NotConfirmed"/> の力。
    /// </summary>
    public IReadOnlySet<Ability> MustNotConfirm =>
        (States ?? new Dictionary<Ability, AbilityState>()).Where(s => s.Value != AbilityState.Confirmed).Select(s => s.Key).Concat(NotConfirmed).ToHashSet();

    /// <summary>一部だけそろった例で、聞き返してほしい行動。</summary>
    public ActionRef? Ask { get; init; }

    public static EpisodeScript Parse(string markdown)
    {
        var lines = markdown.ReplaceLineEndings("\n").Split('\n');
        var index = 0;
        while (index < lines.Length && lines[index].Trim().Length == 0)
        {
            index++;
        }

        if (index >= lines.Length || lines[index].Trim() != "---")
        {
            throw new FormatException("エピソードの先頭に、--- で囲んだ id、title、unit、expect が要ります。");
        }

        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        for (index++; index < lines.Length && lines[index].Trim() != "---"; index++)
        {
            var separator = lines[index].IndexOf(':');
            if (separator > 0)
            {
                fields[lines[index][..separator].Trim()] = lines[index][(separator + 1)..].Trim();
            }
        }

        string Required(string name) =>
            fields.TryGetValue(name, out var value) && value.Length > 0 ? value : throw new FormatException($"エピソードに {name} がありません。");

        var id = Required("id");
        var answers = new List<ScriptedAnswer>();
        var inAnswers = false;
        for (index++; index < lines.Length; index++)
        {
            var line = lines[index].Trim();
            if (line.StartsWith('#'))
            {
                inAnswers = line == AnswersHeading;
                continue;
            }

            if (!inAnswers || line.Length == 0)
            {
                continue;
            }

            var text = line.StartsWith("- ", StringComparison.Ordinal) ? line[2..].Trim() : line;
            ScriptedAnswer answer;
            if (text.StartsWith(ChoiceMarker, StringComparison.Ordinal))
            {
                answer = new ScriptedAnswer(text[ChoiceMarker.Length..].Trim(), true);
            }
            else if (text.StartsWith(CorrectionMarker, StringComparison.Ordinal))
            {
                var correction = text[CorrectionMarker.Length..].Trim();
                answer = correction.Length > 0
                    ? new ScriptedAnswer(correction, false, IsCorrection: true)
                    : throw new FormatException($"エピソード {id} の [訂正] の行に文がありません。");
            }
            else
            {
                answer = new ScriptedAnswer(text, false);
            }

            // 訂正は話し終えた場面に送るので、訂正のあとに普通の答えを置けない（Claude の判断）
            if (!answer.IsCorrection && answers.Any(a => a.IsCorrection))
            {
                throw new FormatException($"エピソード {id} で、[訂正] の行のあとに答えがあります。訂正は最後にまとめてください。");
            }

            answers.Add(answer);
        }

        if (answers.Count == 0)
        {
            throw new FormatException($"エピソード {id} に「{AnswersHeading}」の答えがありません。");
        }

        if (answers[0].IsCorrection)
        {
            throw new FormatException($"エピソード {id} が [訂正] から始まっています。訂正は答えのあとに置きます。");
        }

        var unit = fields.GetValueOrDefault("unit", "discover");
        var parsedStates = fields.TryGetValue("states", out var states) ? ParseStates(id, states) : null;
        var notConfirmed = fields.TryGetValue("notConfirmed", out var notText) ? ParseNotConfirmed(id, notText, parsedStates) : null;
        if (unit == "validate" && parsedStates is null && notConfirmed is null)
        {
            throw new FormatException($"エピソード {id} は確かめの例なので、states（狙った力の期待する状態）か notConfirmed（根拠ありにしてはいけない力）を書きます。");
        }

        return new EpisodeScript(id, Required("title"), unit, Required("expect"), answers)
        {
            States = parsedStates,
            StatesBefore = fields.TryGetValue("statesBefore", out var before) ? ParseStates(id, before) : null,
            NotConfirmed = notConfirmed ?? new HashSet<Ability>(),
            Ask = fields.TryGetValue("ask", out var ask)
                ? ActionRef.Parse(ask) ?? throw new FormatException($"エピソード {id} の ask「{ask}」を読めません。coordinating.3 の形で書きます。")
                : null,
        };
    }

    /// <summary>
    /// <c>noticing, prioritizing</c> の形か、<c>*</c> を読む。<c>*</c> は、話から確かめるすべての力から、states で confirmed の力を除いたもの。
    /// 知らない力、同じ力の重なり、states で confirmed の力は読めない。
    /// </summary>
    private static HashSet<Ability> ParseNotConfirmed(string id, string text, IReadOnlyDictionary<Ability, AbilityState>? states)
    {
        bool IsConfirmed(Ability a) => states is not null && states.TryGetValue(a, out var s) && s == AbilityState.Confirmed;

        if (text.Trim() == "*")
        {
            return AbilityCatalog.Active.Where(a => !IsConfirmed(a)).ToHashSet();
        }

        var abilities = new HashSet<Ability>();
        foreach (var part in text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            if (!ActionRef.TryParseAbility(part, out var ability))
            {
                throw new FormatException($"エピソード {id} の notConfirmed の力「{part}」を読めません。話から確かめる力の id を書きます。");
            }

            if (!abilities.Add(ability))
            {
                throw new FormatException($"エピソード {id} の notConfirmed に、{part} が 2 回書いてあります。");
            }

            if (IsConfirmed(ability))
            {
                throw new FormatException($"エピソード {id} で、{part} が states では confirmed なのに、notConfirmed にも書いてあります。");
            }
        }

        return abilities.Count > 0 ? abilities : throw new FormatException($"エピソード {id} の notConfirmed に力がありません。");
    }

    /// <summary><c>coordinating=confirmed</c> の形を読む。狙った力だけを書く（1 つ以上）。力の id は能力辞書（abilities.json）で確かめる。</summary>
    private static Dictionary<Ability, AbilityState> ParseStates(string id, string text)
    {
        var states = new Dictionary<Ability, AbilityState>();
        foreach (var part in text.Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            var pair = part.Split('=', StringSplitOptions.TrimEntries);
            if (pair.Length != 2 || !ActionRef.TryParseAbility(pair[0], out var ability) || !TryParseState(pair[1], out var state))
            {
                throw new FormatException($"エピソード {id} の状態「{part}」を読めません。noticing=confirmed の形で書きます。");
            }

            if (!states.TryAdd(ability, state))
            {
                throw new FormatException($"エピソード {id} で、{pair[0]} の状態が 2 回書いてあります。");
            }
        }

        return states.Count > 0 ? states : throw new FormatException($"エピソード {id} の状態に力がありません。");
    }

    private static bool TryParseState(string text, out AbilityState state)
    {
        (string Name, AbilityState State)[] names =
            [("notYet", AbilityState.NotYet), ("needsCheck", AbilityState.NeedsCheck), ("confirmed", AbilityState.Confirmed)];
        foreach (var (name, value) in names)
        {
            if (string.Equals(name, text, StringComparison.Ordinal))
            {
                state = value;
                return true;
            }
        }

        state = default;
        return false;
    }

    /// <summary>状態を、台本と同じ名前（notYet、needsCheck、confirmed）にする。</summary>
    public static string StateName(AbilityState state) => state switch
    {
        AbilityState.NotYet => "notYet",
        AbilityState.NeedsCheck => "needsCheck",
        AbilityState.Confirmed => "confirmed",
        _ => state.ToString(),
    };

    /// <summary>フォルダの中のエピソードのうち、そのまとまりのものを、ファイル名の順に読む。</summary>
    public static IReadOnlyList<EpisodeScript> LoadAll(string directory, string unit) =>
        Directory.GetFiles(directory, "*.md")
            .Order(StringComparer.Ordinal)
            .Select(path => Parse(File.ReadAllText(path)))
            .Where(script => script.Unit == unit)
            .ToList();
}
