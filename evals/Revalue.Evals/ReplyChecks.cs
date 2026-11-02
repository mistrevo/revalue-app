using System.Text.Json;

namespace Revalue.Evals;

/// <summary>返事を機械で確かめる。</summary>
public static class ReplyChecks
{
    /// <summary>本文の問いの数。全角と半角の疑問符を数える。</summary>
    public static int CountQuestions(string body) => body.Count(c => c is '？' or '?');
}

/// <summary>使わない言葉の一覧（src/shared/forbidden-words.json）。</summary>
public sealed class ForbiddenWords(IReadOnlyList<string> words)
{
    public IReadOnlyList<string> Words { get; } = words;

    public static ForbiddenWords Load(string path) =>
        new(JsonSerializer.Deserialize<string[]>(File.ReadAllText(path)) ?? throw new FormatException($"{path} を読めません。"));

    /// <summary>文に含まれる使わない言葉。</summary>
    public IReadOnlyList<string> Find(string text) => Words.Where(w => text.Contains(w, StringComparison.Ordinal)).ToList();
}
