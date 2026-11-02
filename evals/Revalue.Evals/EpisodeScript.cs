namespace Revalue.Evals;

/// <summary>台本の 1 行。<see cref="IsChoice"/> なら、直前の返事の選択肢の 1 つ目を選ぶ（<see cref="Text"/> は空）。</summary>
public sealed record ScriptedAnswer(string Text, bool IsChoice);

/// <summary>
/// 架空エピソード 1 件（evals/episodes/*.md）。
/// 先頭の --- で囲んだところに id、title、unit、expect を書き、「## 利用者の答え」の下に 1 行 1 ターンで答えを並べる。
/// 選択肢で答える行は「[選択]」で始める。
/// </summary>
/// <param name="Expect">どんな例か。concreteEvent、dontKnow、generalOnly、familyIllness、distress、choiceOnly のどれか。</param>
public sealed record EpisodeScript(string Id, string Title, string Unit, string Expect, IReadOnlyList<ScriptedAnswer> Answers)
{
    public const string AnswersHeading = "## 利用者の答え";
    public const string ChoiceMarker = "[選択]";

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
            answers.Add(text.StartsWith(ChoiceMarker, StringComparison.Ordinal) ? new ScriptedAnswer("", true) : new ScriptedAnswer(text, false));
        }

        var id = Required("id");
        if (answers.Count == 0)
        {
            throw new FormatException($"エピソード {id} に「{AnswersHeading}」の答えがありません。");
        }

        return new EpisodeScript(id, Required("title"), fields.GetValueOrDefault("unit", "discover"), Required("expect"), answers);
    }

    /// <summary>フォルダの中のエピソードのうち、そのまとまりのものを、ファイル名の順に読む。</summary>
    public static IReadOnlyList<EpisodeScript> LoadAll(string directory, string unit) =>
        Directory.GetFiles(directory, "*.md")
            .Order(StringComparer.Ordinal)
            .Select(path => Parse(File.ReadAllText(path)))
            .Where(script => script.Unit == unit)
            .ToList();
}
