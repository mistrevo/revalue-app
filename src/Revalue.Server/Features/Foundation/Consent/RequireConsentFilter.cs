using Revalue.Server.Data;
using Revalue.Server.Features.Foundation.Auth;

namespace Revalue.Server.Features.Foundation.Consent;

/// <summary>いまの版で了解していない人には 403 を返す。</summary>
public sealed class RequireConsentFilter : IEndpointFilter
{
    public async ValueTask<object?> InvokeAsync(EndpointFilterInvocationContext context, EndpointFilterDelegate next)
    {
        var http = context.HttpContext;
        var store = http.RequestServices.GetRequiredService<IDataStore>();
        var consent = await store.GetAsync<ConsentItem>(http.User.GetUserKey()!, ConsentItem.ItemId, http.RequestAborted);
        if (consent?.Version != ConsentInfo.CurrentVersion)
        {
            return Problems.Create(StatusCodes.Status403Forbidden, Problems.ConsentRequired, "Consent required.");
        }

        return await next(context);
    }
}

public static class RequireConsentExtensions
{
    /// <summary>了解の要る API に付ける。02 以降の API はすべてこれを付ける。</summary>
    public static TBuilder RequireConsent<TBuilder>(this TBuilder builder) where TBuilder : IEndpointConventionBuilder =>
        builder.AddEndpointFilter<TBuilder, RequireConsentFilter>();
}
