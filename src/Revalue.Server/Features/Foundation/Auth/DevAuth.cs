using System.Text.Encodings.Web;
using System.Text.RegularExpressions;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Revalue.Server.Features.Foundation.Auth;

/// <summary>
/// 開発環境（Development）だけで使う偽のログイン。開発用の利用者をクッキーで覚える。
/// それ以外の環境では登録しないので動かない。
/// </summary>
public sealed partial class DevAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    UserKeyHasher hasher)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "Dev";
    public const string CookieName = "revalue_dev_user";
    public const string DefaultUser = "dev-user";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var devUser = Request.Cookies[CookieName];
        if (!IsValidDevUser(devUser))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var userKey = hasher.Hash("dev", devUser!);
        return Task.FromResult(AuthenticateResult.Success(AuthSetup.CreateTicket(userKey, SchemeName)));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        AuthSetup.WriteLoginRequiredAsync(Context);

    /// <summary>開発用の利用者の名前は、英数字とハイフンだけ許す。</summary>
    public static bool IsValidDevUser(string? value) => value is not null && DevUserPattern().IsMatch(value);

    [GeneratedRegex("^[A-Za-z0-9-]{1,64}$")]
    private static partial Regex DevUserPattern();
}

/// <summary>開発用の /.auth/login/google と /.auth/logout。</summary>
public static class DevAuthEndpoints
{
    public static void Map(IEndpointRouteBuilder app)
    {
        app.MapGet("/.auth/login/google", (HttpContext context, string? post_login_redirect_uri, string? dev_user) =>
        {
            var devUser = string.IsNullOrEmpty(dev_user) ? DevAuthHandler.DefaultUser : dev_user;
            if (!DevAuthHandler.IsValidDevUser(devUser))
            {
                return Results.Problem(statusCode: StatusCodes.Status400BadRequest, title: "dev_user is invalid.");
            }

            context.Response.Cookies.Append(DevAuthHandler.CookieName, devUser, new CookieOptions
            {
                HttpOnly = true,
                SameSite = SameSiteMode.Lax,
                Path = "/",
            });
            return Results.Redirect(SafeLocalPath(post_login_redirect_uri, "/start"));
        });

        app.MapGet("/.auth/logout", (HttpContext context, string? post_logout_redirect_uri) =>
        {
            context.Response.Cookies.Delete(DevAuthHandler.CookieName, new CookieOptions { Path = "/" });
            return Results.Redirect(SafeLocalPath(post_logout_redirect_uri, "/"));
        });
    }

    /// <summary>このサイトの中のパスだけを許す。外のサイトへは飛ばさない。</summary>
    public static string SafeLocalPath(string? path, string fallback)
    {
        if (string.IsNullOrEmpty(path)
            || path[0] != '/'
            || path.StartsWith("//", StringComparison.Ordinal)
            || path.Contains('\\')
            || path.Any(char.IsControl))
        {
            return fallback;
        }

        return path;
    }
}
