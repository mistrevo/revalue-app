using System.Text.Encodings.Web;
using Microsoft.AspNetCore.Authentication;
using Microsoft.Extensions.Options;

namespace Revalue.Server.Features.Foundation.Auth;

/// <summary>
/// Container Apps の組み込み認証が付けるヘッダーから、ログインした人を知る。
/// 読むのは X-MS-CLIENT-PRINCIPAL-IDP と X-MS-CLIENT-PRINCIPAL-ID だけ。名前やメールアドレスの入ったヘッダーは読まない。
/// </summary>
public sealed class EasyAuthHandler(
    IOptionsMonitor<AuthenticationSchemeOptions> options,
    ILoggerFactory logger,
    UrlEncoder encoder,
    UserKeyHasher hasher)
    : AuthenticationHandler<AuthenticationSchemeOptions>(options, logger, encoder)
{
    public const string SchemeName = "EasyAuth";
    private const string ProviderHeader = "X-MS-CLIENT-PRINCIPAL-IDP";
    private const string IdHeader = "X-MS-CLIENT-PRINCIPAL-ID";

    protected override Task<AuthenticateResult> HandleAuthenticateAsync()
    {
        var provider = Request.Headers[ProviderHeader].ToString();
        var principalId = Request.Headers[IdHeader].ToString();
        if (string.IsNullOrWhiteSpace(provider) || string.IsNullOrWhiteSpace(principalId))
        {
            return Task.FromResult(AuthenticateResult.NoResult());
        }

        var userKey = hasher.Hash(provider, principalId);
        return Task.FromResult(AuthenticateResult.Success(AuthSetup.CreateTicket(userKey, SchemeName)));
    }

    protected override Task HandleChallengeAsync(AuthenticationProperties properties) =>
        AuthSetup.WriteLoginRequiredAsync(Context);
}
