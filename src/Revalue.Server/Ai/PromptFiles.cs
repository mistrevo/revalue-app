using System.Text;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Ai;

/// <summary>
/// AI への指示（Ai/Prompts/*.md）。ビルドの出力にコピーしたものを読む。評価（evals/Revalue.Evals）からも同じファイルを読む。
/// </summary>
public static class PromptFiles
{
    /// <summary>聞き手の返事の指示。</summary>
    public const string Listener = "listener.md";

    /// <summary>答えの読み取りの指示。力の表は <see cref="ReaderPrompt"/> で差し込む。</summary>
    public const string Reader = "reader.md";

    /// <summary>仕事の選択肢（3 枚のカード）の指示。</summary>
    public const string Options = "options.md";

    /// <summary>選んだ案を深める（業務の見立て、仮の場面の問い、最初の一歩）の指示。</summary>
    public const string Deepen = "deepen.md";

    /// <summary>読み取りの指示（<see cref="Reader"/>）の中で、力の表（<see cref="AbilityTable"/>）を差し込む印。</summary>
    public const string AbilityTableMarker = "{{ABILITY_TABLE}}";

    private static readonly Lazy<string> ReaderPromptText =
        new(() => Read(Reader).Replace(AbilityTableMarker, AbilityTable(), StringComparison.Ordinal));

    public static string Read(string name) =>
        File.ReadAllText(Path.Combine(AppContext.BaseDirectory, "Ai", "Prompts", name)).ReplaceLineEndings("\n").Trim();

    /// <summary>
    /// 読み取りの指示。力の表を、判定に使う力（<see cref="AbilityCatalog.Active"/>）から作って差し込む。
    /// 毎回同じ文字列になるので、システムプロンプトのキャッシュが効く。
    /// </summary>
    public static string ReaderPrompt() => ReaderPromptText.Value;

    /// <summary>
    /// 読み取りの指示に差し込む、話から確かめる力の表。力ごとに、名前、<c>ability</c> に入れる id、<c>action</c> の番号ごとの核となる行動の文。
    /// 行動の数が力によって違えば、足りない欄は空にする。表の前の文に力の数は書かない（辞書の力が増減しても文を変えずに済むように）。
    /// </summary>
    public static string AbilityTable()
    {
        var abilities = AbilityCatalog.Active;
        var counts = abilities.Select(AbilityCatalog.ActionCount).ToList();
        var (min, max) = (counts.Min(), counts.Max());
        var actionCount = min == max
            ? $"どの力も {max} つ"
            : $"力によって {string.Join(" つか ", Enumerable.Range(min, max - min + 1))} つ";

        var sb = new StringBuilder();
        sb.Append($"話から確かめる力と、力ごとの核となる行動です。行動の数は{actionCount}です。\n\n");
        sb.Append("| 力 | `ability` |");
        for (var n = 1; n <= max; n++)
        {
            sb.Append($" `action` {n} |");
        }

        sb.Append("\n|").Append(string.Concat(Enumerable.Repeat("---|", max + 2)));
        foreach (var ability in abilities)
        {
            sb.Append($"\n| {AbilityCatalog.Name(ability)} | `{ability.Id}` |");
            for (var n = 1; n <= max; n++)
            {
                var text = n <= AbilityCatalog.ActionCount(ability) ? AbilityCatalog.ActionText(new ActionRef(ability, n)) : "";
                sb.Append(' ').Append(text).Append(" |");
            }
        }

        return sb.ToString();
    }
}
