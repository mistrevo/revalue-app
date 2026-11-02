using System.Security.Claims;
using Microsoft.AspNetCore.Authentication;

namespace Revalue.Server.Features.Foundation.Auth;

public static class AuthSetup
{
    public const string UserKeyClaim = "user_key";

    /// <summary>
    /// ログインの仕組みを登録する。本番とテストでは組み込み認証のヘッダーを読み、
    /// 開発環境（Development）だけ偽のログインを既定にする。
    /// </summary>
    public static IServiceCollection AddRevalueAuth(this IServiceCollection services, IHostEnvironment environment)
    {
        services.AddSingleton<UserKeyHasher>();

        var isDevelopment = environment.IsDevelopment();
        var auth = services.AddAuthentication(isDevelopment ? DevAuthHandler.SchemeName : EasyAuthHandler.SchemeName)
            .AddScheme<AuthenticationSchemeOptions, EasyAuthHandler>(EasyAuthHandler.SchemeName, null);
        if (isDevelopment)
        {
            auth.AddScheme<AuthenticationSchemeOptions, DevAuthHandler>(DevAuthHandler.SchemeName, null);
        }

        services.AddAuthorization();
        return services;
    }

    /// <summary>ログインの仕組みを要求の流れに入れる。利用者キーの鍵がなければ、ここで起動を止める。</summary>
    public static WebApplication UseRevalueAuth(this WebApplication app)
    {
        _ = app.Services.GetRequiredService<UserKeyHasher>();
        app.UseAuthentication();
        app.UseAuthorization();
        return app;
    }

    /// <summary>
    /// /.auth の経路。開発環境（Development）のときだけ偽のログインとログアウトを足す。
    /// それ以外の /.auth は、画面（index.html）を返さず 404 にする（本番では組み込み認証が手前で受け持つ）。
    /// </summary>
    public static void MapDevAuth(this WebApplication app)
    {
        if (app.Environment.IsDevelopment())
        {
            DevAuthEndpoints.Map(app);
        }

        app.Map("/.auth/{**rest}", () => TypedResults.NotFound());
    }

    public static string? GetUserKey(this ClaimsPrincipal user) => user.FindFirst(UserKeyClaim)?.Value;

    internal static AuthenticationTicket CreateTicket(string userKey, string scheme)
    {
        var identity = new ClaimsIdentity([new Claim(UserKeyClaim, userKey)], scheme);
        return new AuthenticationTicket(new ClaimsPrincipal(identity), scheme);
    }

    internal static Task WriteLoginRequiredAsync(HttpContext context) =>
        Problems.Create(StatusCodes.Status401Unauthorized, Problems.LoginRequired, "Login required.")
            .ExecuteAsync(context);
}
