namespace Revalue.Server.Ai;

/// <summary>
/// AI への指示（Ai/Prompts/*.md）。ビルドの出力にコピーしたものを読む。評価（evals/Revalue.Evals）からも同じファイルを読む。
/// </summary>
public static class PromptFiles
{
    /// <summary>聞き手の返事の指示。</summary>
    public const string Listener = "listener.md";

    /// <summary>答えの読み取りの指示。</summary>
    public const string Reader = "reader.md";

    /// <summary>仕事の選択肢（3 枚のカード）の指示。</summary>
    public const string Options = "options.md";

    public static string Read(string name) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Ai", "Prompts", name)).ReplaceLineEndings("\n").Trim();
}
