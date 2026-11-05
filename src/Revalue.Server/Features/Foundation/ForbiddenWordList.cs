using System.Text.Json;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Foundation;

/// <summary>
/// 使わない言葉の一覧（src/shared/forbidden-words.json。00-common.md の「言葉」）。埋め込みのリソースから読む。
/// AI が書いた文や登録したデータに、使わない言葉が入っていないかを照らし合わせる。
/// </summary>
public sealed class ForbiddenWordList
{
    /// <summary>
    /// 照らし合わせる前に除く言葉。力の名前と、「優先順位」（「優先順位を決めた」のように、本人がしたことを映し返すときに使う。
    /// 一覧の「順位」は、カードや人に順番を付けることを止めるためのもの。00-common.md の「言葉」）。
    /// </summary>
    public static readonly IReadOnlyList<string> Allowed = [.. AbilityCatalog.Active.Select(AbilityText.Name), "優先順位"];

    private ForbiddenWordList(IReadOnlyList<string> words) => Words = words;

    public IReadOnlyList<string> Words { get; }

    public static ForbiddenWordList Load()
    {
        using var stream = typeof(ForbiddenWordList).Assembly.GetManifestResourceStream("forbidden-words.json")
            ?? throw new InvalidOperationException("The embedded resource forbidden-words.json is missing.");
        return new ForbiddenWordList(JsonSerializer.Deserialize<string[]>(stream) ?? throw new InvalidOperationException("forbidden-words.json is empty."));
    }

    /// <summary>最初に見つかった使わない言葉。なければ null。力の名前と「優先順位」（<see cref="Allowed"/>）は先に除く。</summary>
    public string? FirstIn(string text)
    {
        var cleaned = Allowed.Aggregate(text, (current, name) => current.Replace(name, "", StringComparison.Ordinal));
        return Words.FirstOrDefault(word => cleaned.Contains(word, StringComparison.Ordinal));
    }
}
