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
/// 03 validate（確かめる）の例は、states（最後に期待する状態）、statesBefore（最初の訂正の直前に期待する状態）、ask（聞き返してほしい行動）も書く。
/// </summary>
/// <param name="Expect">どんな例か。concreteEvent、dontKnow、generalOnly、familyIllness、distress、choiceOnly など。</param>
public sealed record EpisodeScript(string Id, string Title, string Unit, string Expect, IReadOnlyList<ScriptedAnswer> Answers)
{
    public const string AnswersHeading = "## 利用者の答え";
    public const string ChoiceMarker = "[選択]";
    public const string CorrectionMarker = "[訂正]";

    /// <summary>場面を最後まで流したあとに期待する、力ごとの状態。3 つの力すべてを持つ。確かめの例でなければ null。</summary>
    public IReadOnlyDictionary<Ability, AbilityState>? States { get; init; }

    /// <summary>最初の訂正の直前に期待する状態。訂正のある例だけ。</summary>
    public IReadOnlyDictionary<Ability, AbilityState>? StatesBefore { get; init; }

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

        return new EpisodeScript(id, Required("title"), fields.GetValueOrDefault("unit", "discover"), Required("expect"), answers)
        {
            States = fields.TryGetValue("states", out var states) ? ParseStates(id, states) : null,
            StatesBefore = fields.TryGetValue("statesBefore", out var before) ? ParseStates(id, before) : null,
            Ask = fields.TryGetValue("ask", out var ask)
                ? ActionRef.Parse(ask) ?? throw new FormatException($"エピソード {id} の ask「{ask}」を読めません。coordinating.3 の形で書きます。")
                : null,
        };
    }

    /// <summary><c>noticing=notYet, coordinating=confirmed, prioritizing=notYet</c> の形を読む。3 つの力すべてを書く。</summary>
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

        if (states.Count != Enum.GetValues<Ability>().Length)
        {
            throw new FormatException($"エピソード {id} の状態には、3 つの力すべてを書きます。");
        }

        return states;
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
