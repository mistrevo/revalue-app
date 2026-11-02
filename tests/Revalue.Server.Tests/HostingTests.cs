using System.Net;
using System.Net.Http.Json;
using System.Text.Json;

namespace Revalue.Server.Tests;

public sealed class HostingTests
{
    [Fact(DisplayName = "foundation-7（公開 URL で動く）: GET /api/health は未ログインでも 200")]
    public async Task HealthIsOkWithoutLogin()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync("/api/health", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var body = await response.Content.ReadFromJsonAsync<JsonElement>(TestContext.Current.CancellationToken);
        Assert.Equal("ok", body.GetProperty("status").GetString());
    }

    [Fact(DisplayName = "foundation-7（公開 URL で動く）: GET /api/health は、動いているイメージのコミットを返す")]
    public async Task HealthReturnsBuildCommit()
    {
        await using var built = new RevalueFactory().WithSetting("Build:Commit", "0123abc");
        var body = await built.CreateClient().GetFromJsonAsync<JsonElement>("/api/health", TestContext.Current.CancellationToken);
        Assert.Equal("0123abc", body.GetProperty("commit").GetString());

        // イメージの外（手元とテスト）では local
        await using var local = new RevalueFactory();
        var localBody = await local.CreateClient().GetFromJsonAsync<JsonElement>("/api/health", TestContext.Current.CancellationToken);
        Assert.Equal("local", localBody.GetProperty("commit").GetString());
    }

    [Fact(DisplayName = "foundation-1（案内はログインなしで見られる）: /api 以外の知らないパスは index.html を返す")]
    public async Task UnknownNonApiPathReturnsIndexHtml()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync("/settings", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/html", response.Content.Headers.ContentType?.MediaType);
        var html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("revalue-test-root", html);
    }

    [Fact(DisplayName = "foundation-1（案内はログインなしで見られる）: / は index.html を返す")]
    public async Task RootReturnsIndexHtml()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateClient();

        var response = await client.GetAsync("/", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var html = await response.Content.ReadAsStringAsync(TestContext.Current.CancellationToken);
        Assert.Contains("revalue-test-root", html);
    }

    [Fact(DisplayName = "foundation-1（案内はログインなしで見られる）: /api の知らないパスは 404 の ProblemDetails")]
    public async Task UnknownApiPathIsProblem404()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");

        var response = await client.GetAsync("/api/nope", TestContext.Current.CancellationToken);

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal("application/problem+json", response.Content.Headers.ContentType?.MediaType);
    }
}
