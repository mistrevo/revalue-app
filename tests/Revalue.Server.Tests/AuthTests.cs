using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Revalue.Server.Features.Foundation.Auth;

namespace Revalue.Server.Tests;

public sealed class AuthTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static UserKeyHasher CreateHasher(string? secret = RevalueFactory.TestSecret) =>
        new(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Auth:UserKeySecret"] = secret })
            .Build());

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 同じ人は同じ利用者キー、違う人は違うキー、元の ID を含まない")]
    public void UserKeyIsStableAndOpaque()
    {
        var hasher = CreateHasher();

        var first = hasher.Hash("google", "123");
        var second = hasher.Hash("google", "123");
        var other = hasher.Hash("google", "456");

        Assert.Equal(first, second);
        Assert.NotEqual(first, other);
        Assert.DoesNotContain("123", first);
        Assert.Matches("^u_[0-9a-f]{64}$", first);
    }

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 利用者キーの鍵が空なら使えない")]
    public void EmptySecretIsRejected()
    {
        Assert.Throws<InvalidOperationException>(() => CreateHasher(""));
        Assert.Throws<InvalidOperationException>(() => CreateHasher(null));
    }

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 利用者キーの鍵がなければ起動しない")]
    public async Task EmptySecretStopsStartup()
    {
        await using var factory = new RevalueFactory().WithSetting("Auth:UserKeySecret", "");

        Assert.ThrowsAny<Exception>(() => factory.CreateClient());
    }

    [Theory(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 本番でも鍵がなければ起動しない")]
    [InlineData("Production")]
    [InlineData("Testing")]
    public async Task EmptySecretStopsStartupOutsideDevelopment(string environment)
    {
        await using var factory = new RevalueFactory()
            .WithEnvironment(environment)
            .WithSetting("Cosmos:Endpoint", "https://example.com:443/")
            .WithSetting("Auth:UserKeySecret", "");

        Assert.ThrowsAny<Exception>(() => factory.CreateClient());
    }

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 開発環境では鍵がなくても、その場かぎりの鍵で起動する")]
    public async Task DevelopmentStartsWithoutSecret()
    {
        await using var factory = new RevalueFactory().WithEnvironment("Development").WithSetting("Auth:UserKeySecret", "");
        var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/api/health", TestContext.Current.CancellationToken)).StatusCode);
    }

    [Theory(DisplayName = "foundation-1（案内はログインなしで見られる）: 未ログインの /api は 401 の ProblemDetails")]
    [InlineData("GET", "/api/me")]
    [InlineData("POST", "/api/consent")]
    [InlineData("DELETE", "/api/me")]
    [InlineData("GET", "/api/stats")]
    [InlineData("GET", "/api/nope")]
    public async Task AnonymousApiIsProblem401(string method, string path)
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateClient();
        using var request = new HttpRequestMessage(new HttpMethod(method), path);
        if (method == "POST")
        {
            request.Content = JsonContent.Create(new { version = "2026-11-02" });
        }

        var response = await client.SendAsync(request, Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        Assert.Equal("/problems/login-required", body.GetProperty("type").GetString());
    }

    [Fact(DisplayName = "foundation-1（案内はログインなしで見られる）: 組み込み認証のヘッダーがあればログイン扱い")]
    public async Task EasyAuthHeadersSignIn()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");

        var response = await client.GetAsync("/api/nope", Ct);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact(DisplayName = "foundation-1（案内はログインなしで見られる）: 組み込み認証のヘッダーが片方だけなら未ログイン")]
    public async Task PartialEasyAuthHeadersAreAnonymous()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateClient();
        client.DefaultRequestHeaders.Add("X-MS-CLIENT-PRINCIPAL-ID", "g-1");

        var response = await client.GetAsync("/api/nope", Ct);

        Assert.Equal(HttpStatusCode.Unauthorized, response.StatusCode);
    }

    [Theory(DisplayName = "foundation-5（名前とメールアドレスを残さない）: Testing と Production では偽のログインが効かない")]
    [InlineData("Testing")]
    [InlineData("Production")]
    public async Task DevLoginIsDisabledOutsideDevelopment(string environment)
    {
        await using var factory = new RevalueFactory()
            .WithEnvironment(environment)
            .WithSetting("Cosmos:Endpoint", "https://cosmos.example.com:443/");
        var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        using var withCookie = new HttpRequestMessage(HttpMethod.Get, "/api/me");
        withCookie.Headers.Add("Cookie", "revalue_dev_user=x");
        withCookie.Headers.Add("X-Dev-User", "x");
        var me = await client.SendAsync(withCookie, Ct);
        Assert.Equal(HttpStatusCode.Unauthorized, me.StatusCode);

        var login = await client.GetAsync("/.auth/login/google?post_login_redirect_uri=/start", Ct);
        Assert.Equal(HttpStatusCode.NotFound, login.StatusCode);

        var logout = await client.GetAsync("/.auth/logout?post_logout_redirect_uri=/", Ct);
        Assert.Equal(HttpStatusCode.NotFound, logout.StatusCode);
    }

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: Development では偽のログインで入れる")]
    public async Task DevLoginWorksInDevelopment()
    {
        await using var factory = new RevalueFactory().WithEnvironment("Development");
        var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        var before = await client.GetAsync("/api/nope", Ct);
        Assert.Equal(HttpStatusCode.Unauthorized, before.StatusCode);

        var login = await client.GetAsync("/.auth/login/google?post_login_redirect_uri=/start", Ct);
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        Assert.Equal("/start", login.Headers.Location?.OriginalString);

        var after = await client.GetAsync("/api/nope", Ct);
        Assert.Equal(HttpStatusCode.NotFound, after.StatusCode);

        var logout = await client.GetAsync("/.auth/logout?post_logout_redirect_uri=/", Ct);
        Assert.Equal(HttpStatusCode.Redirect, logout.StatusCode);
        Assert.Equal("/", logout.Headers.Location?.OriginalString);

        var loggedOut = await client.GetAsync("/api/nope", Ct);
        Assert.Equal(HttpStatusCode.Unauthorized, loggedOut.StatusCode);
    }

    [Theory(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 開発用ログインは外のサイトへ飛ばさない")]
    [InlineData("https://evil.example.com")]
    [InlineData("//evil.example.com")]
    [InlineData("/\\evil.example.com")]
    [InlineData("")]
    public async Task DevLoginDoesNotRedirectOutside(string redirect)
    {
        await using var factory = new RevalueFactory().WithEnvironment("Development");
        var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        var login = await client.GetAsync($"/.auth/login/google?post_login_redirect_uri={Uri.EscapeDataString(redirect)}", Ct);
        Assert.Equal(HttpStatusCode.Redirect, login.StatusCode);
        Assert.Equal("/start", login.Headers.Location?.OriginalString);

        var logout = await client.GetAsync($"/.auth/logout?post_logout_redirect_uri={Uri.EscapeDataString(redirect)}", Ct);
        Assert.Equal(HttpStatusCode.Redirect, logout.StatusCode);
        Assert.Equal("/", logout.Headers.Location?.OriginalString);
    }

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 開発用の利用者の名前は英数字とハイフンだけ")]
    public async Task DevUserMustBeSimple()
    {
        await using var factory = new RevalueFactory().WithEnvironment("Development");
        var client = factory.CreateClient(new WebApplicationFactoryClientOptions { AllowAutoRedirect = false });

        var login = await client.GetAsync("/.auth/login/google?post_login_redirect_uri=/start&dev_user=a%3Bb", Ct);

        Assert.Equal(HttpStatusCode.BadRequest, login.StatusCode);
        var after = await client.GetAsync("/api/nope", Ct);
        Assert.Equal(HttpStatusCode.Unauthorized, after.StatusCode);
    }
}
