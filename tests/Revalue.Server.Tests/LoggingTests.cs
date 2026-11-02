using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;

namespace Revalue.Server.Tests;

public sealed class LoggingTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Name = "架空 花子";
    private const string Email = "hanako@example.com";
    private const string Content = "目印-話した内容-7f3a";

    private static async Task SendMarkedRequests(RevalueFactory factory)
    {
        var client = factory.CreateUserClient("g-1");
        client.DefaultRequestHeaders.Add("X-MS-CLIENT-PRINCIPAL-NAME", Email);
        var principal = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{{\"name\":\"{Name}\",\"email\":\"{Email}\"}}"));
        client.DefaultRequestHeaders.Add("X-MS-CLIENT-PRINCIPAL", principal);

        await client.PostAsJsonAsync("/api/consent", new { version = "2026-11-02", memo = Content }, Ct);
        await client.PostAsJsonAsync("/api/consent", new { version = Content }, Ct);
        await client.GetAsync($"/api/me?q={Uri.EscapeDataString(Content)}", Ct);
        await client.GetAsync($"/api/nope/{Uri.EscapeDataString(Content)}", Ct);
        await client.PostAsync("/api/consent", new StringContent("{" + Content, new MediaTypeHeaderValue("application/json")), Ct);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 目印がログに出ない")]
    public async Task MarkersDoNotAppearInLogs()
    {
        await using var factory = new RevalueFactory();

        await SendMarkedRequests(factory);

        var logs = factory.CapturedLogs;
        Assert.Contains(logs, l => l.Contains("/api/consent"));
        Assert.All(logs, line =>
        {
            Assert.DoesNotContain(Name, line);
            Assert.DoesNotContain(Email, line);
            Assert.DoesNotContain(Content, line);
        });
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: アクセスログは型・状態コード・時間・利用者キーだけ")]
    public async Task AccessLogHasOnlyAllowedFields()
    {
        await using var factory = new RevalueFactory();
        await factory.CreateUserClient("g-1").GetAsync("/api/me", Ct);

        var line = Assert.Single(factory.CapturedLogs, l => l.Contains("RequestLog"));
        Assert.Contains("GET /api/me 200", line);
        Assert.Contains(TestUsers.Key("g-1"), line);
        Assert.DoesNotContain("g-1", line.Replace(TestUsers.Key("g-1"), ""));
    }

    [Fact(DisplayName = "foundation-5（名前とメールアドレスを残さない）: 保存したアイテムに名前とメールアドレスが入らない")]
    public async Task StoredItemsHaveNoNameOrEmail()
    {
        await using var factory = new RevalueFactory();

        await SendMarkedRequests(factory);

        var store = (InMemoryDataStore)factory.Services.GetRequiredService<IDataStore>();
        var all = await store.DumpRawJsonAsync(Ct).ToListAsync(Ct);
        Assert.NotEmpty(all);
        Assert.All(all, json =>
        {
            Assert.DoesNotContain(Email, json);
            Assert.DoesNotContain(Name, json);
        });
    }
}
