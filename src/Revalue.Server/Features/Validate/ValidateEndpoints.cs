using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Foundation.Auth;
using Revalue.Server.Features.Foundation.Consent;

namespace Revalue.Server.Features.Validate;

/// <summary>
/// 根拠の本人の言葉。画面にそのまま出すので、何番目の答えかではなく引用の文字列を返す。
/// 選んだ答え（<paramref name="FromChoice"/>）では、<paramref name="LinkedText"/> に結びついた本人の言葉が入る。
/// </summary>
public sealed record QuoteDto(string Text, bool FromChoice, string? LinkedText)
{
    public static IReadOnlyList<QuoteDto> From(IEnumerable<Evidence> evidence) =>
        evidence.Select(e => new QuoteDto(e.Quote, e.FromChoice, e.LinkedQuote)).ToList();
}

/// <summary>
/// 見えた力の 1 つ。<paramref name="Life"/> は生活の中での状態、<paramref name="Work"/> は仕事での状態で、いまはいつも "notChecked"
/// （validate-9（生活での根拠と仕事での発揮を分ける））。
/// </summary>
public sealed record AbilityDto(
    string Key, string Name, AbilityState Life, IReadOnlyList<QuoteDto> Quotes, string? EpisodeId, IReadOnlyList<string> Hints, string Work, bool Excluded);

public sealed record AbilityChangeDto(
    DateTimeOffset At, string Key, string Name, AbilityState From, AbilityState To, ChangeReason Reason, string? EpisodeId);

/// <summary>見えた力の API が返すもの。履歴は新しい順。</summary>
public sealed record AbilitiesDto(IReadOnlyList<AbilityDto> Abilities, IReadOnlyList<AbilityChangeDto> History);

/// <summary>/api/abilities の API。AI を呼ばない。</summary>
public static class ValidateEndpoints
{
    /// <summary>仕事での発揮の状態。何をもって動かすかはハッカソンのあとに決めるので、いつもこれ。</summary>
    public const string WorkNotChecked = "notChecked";

    public static void Map(RouteGroupBuilder api)
    {
        var abilities = api.MapGroup("/abilities").RequireConsent();

        abilities.MapGet("/", async (HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            var userKey = http.User.GetUserKey()!;
            var book = await store.GetAsync<AbilityBookItem>(userKey, AbilityBookItem.ItemId, ct);
            return TypedResults.Ok(await DtoAsync(store, userKey, book, ct));
        });

        abilities.MapPost("/{name}/exclude", (string name, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
            SetExcludedAsync(name, excluded: true, http, store, time, ct));

        abilities.MapPost("/{name}/restore", (string name, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
            SetExcludedAsync(name, excluded: false, http, store, time, ct));
    }

    private static async Task<IResult> SetExcludedAsync(
        string name, bool excluded, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct)
    {
        if (!ActionRef.TryParseAbility(name, out var ability))
        {
            return Problems.Create(StatusCodes.Status404NotFound, Problems.NotFound, "Not found.");
        }

        var userKey = http.User.GetUserKey()!;
        var book = await AbilityBook.SetExcludedAsync(store, userKey, ability, excluded, time, ct);
        return TypedResults.Ok(await DtoAsync(store, userKey, book, ct));
    }

    private static async Task<AbilitiesDto> DtoAsync(IDataStore store, string userKey, AbilityBookItem? book, CancellationToken ct)
    {
        var episodes = await store.ListByTypeAsync<EpisodeItem>(userKey, EpisodeItem.ItemType, ct);
        var abilities = AbilityBook.View(episodes, book)
            .Select(v => new AbilityDto(
                ActionRef.Key(v.Ability),
                AbilityText.Name(v.Ability),
                v.State,
                QuoteDto.From(v.Shown),
                v.EpisodeId,
                v.Hints,
                WorkNotChecked,
                v.Excluded))
            .ToList();
        var history = (book?.History ?? [])
            .Reverse()
            .Select(h => new AbilityChangeDto(h.At, ActionRef.Key(h.Ability), AbilityText.Name(h.Ability), h.From, h.To, h.Reason, h.EpisodeId))
            .ToList();
        return new AbilitiesDto(abilities, history);
    }
}
