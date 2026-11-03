using System.Text.Json;
using Revalue.Server.Data;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Evals;

/// <summary>
/// 架空の 5 つの記録の 1 件（evals/profiles/*.json）。仕事の選択肢の評価で、AI に渡す元の記録として使う。
/// <see cref="Expect"/> はどんな例か（allCards、needsCheck、tightConditions、canGoOut、highIncome、excluded、choiceLinked）。
/// </summary>
public sealed record ProfileCase(string Id, string Title, string Expect, OptionsInputs Inputs)
{
    /// <summary>根拠ありの力がまだない人の例（カードが出て、確かめ中と示すかを見る）。</summary>
    public bool OnlyChecking => Expect is "needsCheck" or "excluded";

    private sealed record RawQuote(int Action, string Quote, bool FromChoice = false, string? LinkedQuote = null);

    private sealed record RawAbility(Ability Ability, AbilityState State, List<RawQuote> Quotes);

    private sealed record Raw(
        string Id,
        string Title,
        string Expect,
        List<RawAbility> Abilities,
        List<Ability>? Excluded,
        ProfileConditions Conditions,
        List<string>? Preferences,
        List<string>? Wants,
        string? Agency);

    /// <summary>JSON の 1 件を読む。足りない項目があれば <see cref="FormatException"/>。根拠は場面を話し終えた力として読む。</summary>
    public static ProfileCase Parse(string json)
    {
        Raw? raw;
        try
        {
            raw = JsonSerializer.Deserialize<Raw>(json, DataConstants.Json);
        }
        catch (JsonException e)
        {
            throw new FormatException("架空の記録を読めません。", e);
        }

        if (raw is not { Id.Length: > 0, Title: not null, Expect: not null, Abilities: not null, Conditions.TimeSlots: not null })
        {
            throw new FormatException("架空の記録に id、title、expect、abilities、conditions が要ります。");
        }

        var abilities = raw.Abilities
            .OrderBy(a => a.Ability)
            .Select(a => new UsableAbility(
                a.Ability,
                a.State,
                a.Quotes.Select((q, i) => new Evidence(a.Ability, q.Action, q.Quote, i + 1, 1, false, q.FromChoice, q.LinkedQuote)).ToList()))
            .ToList();
        if (abilities.Any(a => a.State is not (AbilityState.Confirmed or AbilityState.NeedsCheck) || a.Quotes.Count == 0))
        {
            throw new FormatException($"{raw.Id}: 使える力は confirmed か needsCheck で、根拠の言葉が 1 つ以上要ります。");
        }

        var inputs = new OptionsInputs(
            raw.Conditions,
            true,
            abilities,
            raw.Excluded?.Order().ToList() ?? [],
            raw.Preferences ?? [],
            raw.Wants ?? [],
            raw.Agency);
        return new ProfileCase(raw.Id, raw.Title, raw.Expect, inputs);
    }

    /// <summary>フォルダの中の p*.json を、ファイル名の順に読む。</summary>
    public static IReadOnlyList<ProfileCase> LoadAll(string directory) =>
        Directory.GetFiles(directory, "p*.json")
            .Order(StringComparer.Ordinal)
            .Select(path => Parse(File.ReadAllText(path)))
            .ToList();
}
