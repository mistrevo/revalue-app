using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Features.Options;

/// <summary>カードの理由に使える力。<paramref name="State"/> は根拠ありか要確認。</summary>
public sealed record UsableAbility(Ability Ability, AbilityState State, IReadOnlyList<Evidence> Quotes);

/// <summary>
/// 仕事の選択肢の元になる記録（05-options.md の「進める条件」）。
/// <paramref name="Abilities"/> は本人が外していない、根拠ありか要確認の力（<see cref="Ability"/> の順）。<paramref name="Excluded"/> は本人が外した力。
/// </summary>
public sealed record OptionsInputs(
    ProfileConditions? Conditions,
    bool HasFinishedEpisode,
    IReadOnlyList<UsableAbility> Abilities,
    IReadOnlyList<Ability> Excluded,
    IReadOnlyList<string> Preferences,
    IReadOnlyList<string> Wants,
    string? Agency)
{
    /// <summary>外した力の中に、外していなければ使える力（根拠ありか要確認で、根拠のあるもの）があるか。</summary>
    public bool HasExcludedUsable { get; init; }
}

/// <summary>仕事の選択肢を出せるか。出せないときは、最初に足りないもの。</summary>
[JsonConverter(typeof(JsonStringEnumConverter<Readiness>))]
public enum Readiness
{
    [JsonStringEnumMemberName("ready")]
    Ready,

    [JsonStringEnumMemberName("needsConditions")]
    NeedsConditions,

    [JsonStringEnumMemberName("needsFinishedEpisode")]
    NeedsFinishedEpisode,

    [JsonStringEnumMemberName("needsAbility")]
    NeedsAbility,

    /// <summary>使える力はあるが、どれも本人が外している。</summary>
    [JsonStringEnumMemberName("onlyExcluded")]
    OnlyExcluded,
}

public static class OptionsInputsReader
{
    public static async Task<OptionsInputs> ReadAsync(IDataStore store, string userKey, CancellationToken ct)
    {
        var profile = await store.GetAsync<ProfileItem>(userKey, ProfileItem.ItemId, ct);
        var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
        var book = await store.GetAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);

        var views = AbilityBook.View(episodes, book);
        static bool Usable(AbilityView v) => v.State is AbilityState.Confirmed or AbilityState.NeedsCheck && v.Shown.Count > 0;
        var abilities = views
            .Where(v => !v.Excluded && Usable(v))
            .Select(v => new UsableAbility(v.Ability, v.State, v.Shown))
            .ToList();

        return new OptionsInputs(
            profile?.Conditions,
            episodes.Any(e => e.Status == EpisodeStatus.Finished),
            abilities,
            book?.Excluded.Order().ToList() ?? [],
            profile?.Preferences.Select(p => p.Text).ToList() ?? [],
            profile?.Wants.Select(p => p.Text).ToList() ?? [],
            profile?.Agency)
        {
            HasExcludedUsable = views.Any(v => v.Excluded && Usable(v)),
        };
    }

    /// <summary>
    /// 条件、話し終えた場面、使える力の順に、最初に足りないもの。使える力がないときは、外した見立てしかないのかを分ける
    /// （外した見立てを戻す道を示すため）。
    /// </summary>
    public static Readiness Check(OptionsInputs inputs) =>
        inputs.Conditions is null ? Readiness.NeedsConditions
        : !inputs.HasFinishedEpisode ? Readiness.NeedsFinishedEpisode
        : inputs.Abilities.Count > 0 ? Readiness.Ready
        : inputs.HasExcludedUsable ? Readiness.OnlyExcluded
        : Readiness.NeedsAbility;

    /// <summary>
    /// カードを作ったときの元の記録の指紋。使える力（力、状態、根拠の言葉と選んだ答えか・結びついた言葉）、条件、好み、やりたいこと、主体性、
    /// 外した力を、決まった順の JSON にして SHA-256 の 16 進にする。
    /// </summary>
    public static string Basis(OptionsInputs inputs)
    {
        var basis = new
        {
            abilities = inputs.Abilities.OrderBy(a => a.Ability).Select(a => new
            {
                ability = ActionRef.Key(a.Ability),
                state = a.State.ToString(),
                quotes = a.Quotes.Select(q => new { quote = q.Quote, fromChoice = q.FromChoice, linkedQuote = q.LinkedQuote }),
            }),
            excluded = inputs.Excluded.Order().Select(ActionRef.Key),
            conditions = inputs.Conditions is { } c
                ? new
                {
                    timeSlots = c.TimeSlots.Distinct().Order().Select(s => s.ToString()),
                    hoursPerWeek = c.HoursPerWeek,
                    place = c.Place.ToString(),
                    monthlyIncome = c.MonthlyIncome,
                }
                : null,
            preferences = inputs.Preferences,
            wants = inputs.Wants,
            agency = inputs.Agency,
        };
        return Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(basis)))).ToLowerInvariant();
    }
}
