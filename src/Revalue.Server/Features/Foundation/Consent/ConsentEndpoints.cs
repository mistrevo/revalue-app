using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;

namespace Revalue.Server.Features.Foundation.Consent;

/// <summary>
/// 「はじめに」に了解した記録。版は、はじめにの中身を変えたときに上げる。
/// その人のパーティションの入口で、これがある間だけ、ほかのアイテムを書ける（<see cref="IDataStore"/>）。
/// </summary>
public sealed record ConsentItem : Item
{
    public const string ItemId = DataConstants.ConsentId;
    public const string ItemType = "consent";

    public required string Version { get; init; }
    public required DateTimeOffset At { get; init; }
}

public static class ConsentInfo
{
    public const string CurrentVersion = "2026-11-02";
}

public sealed record MeDto(bool Consented, string? ConsentVersion, string CurrentVersion);

public sealed record ConsentRequest(string? Version);

public static class ConsentEndpoints
{
    public static void Map(RouteGroupBuilder api)
    {
        api.MapGet("/me", async (HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            var consent = await store.GetAsync<ConsentItem>(http.User.GetUserKey()!, ConsentItem.ItemId, ct);
            return TypedResults.Ok(new MeDto(
                consent?.Version == ConsentInfo.CurrentVersion, consent?.Version, ConsentInfo.CurrentVersion));
        });

        api.MapPost("/consent", async (ConsentRequest request, HttpContext http, IDataStore store, TimeProvider time, CancellationToken ct) =>
        {
            if (request.Version != ConsentInfo.CurrentVersion)
            {
                return Problems.Create(StatusCodes.Status400BadRequest, "/problems/invalid-consent-version", "Invalid consent version.");
            }

            await store.UpsertAsync(new ConsentItem
            {
                Id = ConsentItem.ItemId,
                UserKey = http.User.GetUserKey()!,
                Type = ConsentItem.ItemType,
                Version = request.Version,
                At = time.GetUtcNow(),
            }, ct);
            return TypedResults.NoContent();
        });

        api.MapDelete("/me", async (HttpContext http, IDataStore store, CancellationToken ct) =>
        {
            await store.DeleteAllAsync(http.User.GetUserKey()!, ct);
            return TypedResults.NoContent();
        });
    }
}
