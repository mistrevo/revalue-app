using System.Text.Json;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Foundation;

/// <summary>
/// 使わない言葉の一覧（src/shared/forbidden-words.json。00-common.md の「言葉」）。埋め込みのリソースから読む。
/// AI が書いた文や登録したデータに、使わない言葉が入っていないかを照らし合わせる。
/// </summary>
public sealed class ForbiddenWordList
{
    private readonly string[] _abilityNames = Enum.GetValues<Ability>().Select(AbilityText.Name).ToArray();

    private ForbiddenWordList(IReadOnlyList<string> words) => Words = words;

    public IReadOnlyList<string> Words { get; }

    public static ForbiddenWordList Load()
    {
        using var stream = typeof(ForbiddenWordList).Assembly.GetManifestResourceStream("forbidden-words.json")
            ?? throw new InvalidOperationException("The embedded resource forbidden-words.json is missing.");
        return new ForbiddenWordList(JsonSerializer.Deserialize<string[]>(stream) ?? throw new InvalidOperationException("forbidden-words.json is empty."));
    }

    /// <summary>最初に見つかった使わない言葉。なければ null。力の名前（「優先順位をつける力」の「順位」など）は先に除く。</summary>
    public string? FirstIn(string text)
    {
        var cleaned = _abilityNames.Aggregate(text, (current, name) => current.Replace(name, "", StringComparison.Ordinal));
        return Words.FirstOrDefault(word => cleaned.Contains(word, StringComparison.Ordinal));
    }
}
