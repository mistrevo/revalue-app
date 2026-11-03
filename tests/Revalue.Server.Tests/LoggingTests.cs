using Revalue.Server.Features.Foundation.Consent;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Tests;

public sealed class LoggingTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private const string Name = "架空 花子";
    private const string Email = "hanako@example.com";
    private const string Content = "目印-話した内容-7f3a";

    /// <summary>返事にも目印を入れる偽物の AI で立ち上げる（AI の返事もログに書かないことを確かめるため）。</summary>
    private static (RevalueFactory Factory, FakeConversationAi Ai) Create()
    {
        var ai = new FakeConversationAi
        {
            ReplyChunks = [$"{Content}を話してくれて", "ありがとうございます。何をしましたか？\n---選択肢---\n- 段取りを考えた\n- 人に頼んだ\n- 手を動かした"],
        };
        return (new RevalueFactory().WithTestServices(services => services.AddSingleton<IConversationAi>(ai)), ai);
    }

    private static async Task SendMarkedRequests(RevalueFactory factory, FakeConversationAi ai)
    {
        var client = factory.CreateUserClient("g-1");
        client.DefaultRequestHeaders.Add("X-MS-CLIENT-PRINCIPAL-NAME", Email);
        var principal = Convert.ToBase64String(Encoding.UTF8.GetBytes($"{{\"name\":\"{Name}\",\"email\":\"{Email}\"}}"));
        client.DefaultRequestHeaders.Add("X-MS-CLIENT-PRINCIPAL", principal);

        await client.PostAsJsonAsync("/api/consent", new { version = ConsentInfo.CurrentVersion, memo = Content }, Ct);
        await client.PostAsJsonAsync("/api/consent", new { version = Content }, Ct);
        await client.GetAsync($"/api/me?q={Uri.EscapeDataString(Content)}", Ct);
        await client.GetAsync($"/api/nope/{Uri.EscapeDataString(Content)}", Ct);
        await client.PostAsync("/api/consent", new StringContent("{" + Content, new MediaTypeHeaderValue("application/json")), Ct);

        // 話した内容がいちばん多く通る、答えを送る API（discover）
        await client.PostAsJsonAsync("/api/consent", new { version = ConsentInfo.CurrentVersion }, Ct);
        var started = await client.PostAsync("/api/episodes", null, Ct);
        var id = (await started.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("id").GetString();
        var messages = $"/api/episodes/{id}/messages";
        Task<string> Send(string text, string kind = "free") =>
            client.PostAsJsonAsync(messages, new { text, kind }, Ct).ContinueWith(t => t.Result.Content.ReadAsStringAsync(Ct), Ct).Unwrap();

        // 正しい答え（返事を最後まで受け取り、保存する）
        Assert.Contains("event: done", await Send($"昨日は{Content}をしました。"));
        // 長すぎる答え、答え方が分からない答え、JSON として読めない答え（どれも返事を流す前に 400 で断る）
        await Send(Content + new string('あ', TalkStream.MaxAnswerLength));
        await Send(Content, "voice");
        await client.PostAsync(messages, new StringContent("{\"text\":\"" + Content, new MediaTypeHeaderValue("application/json")), Ct);
        // 返事の途中で、AI が失敗する・断る・思いがけない例外を投げる（例外の中身に目印がある）
        ai.FailNextReply = (1, ConversationAiException.Failure);
        Assert.Contains("event: error", await Send($"途中で失敗する{Content}"));
        ai.FailNextReply = (1, ConversationAiException.Refusal);
        Assert.Contains("event: error", await Send($"途中で断られる{Content}"));
        ai.ThrowNextReply = new InvalidOperationException($"思いがけない失敗 {Content}");
        Assert.Contains("event: error", await Send($"思いがけず失敗する{Content}"));
        // 読み取りに失敗する、つらい状態のサインが出る
        ai.FailNextRead = ConversationAiException.Failure;
        Assert.Contains("event: error", await Send($"読み取りで失敗する{Content}"));
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress });
        Assert.Contains("event: done", await Send($"つらい{Content}"));
        // 一覧と読み返し、飛ばす
        await client.GetAsync("/api/episodes", Ct);
        await client.GetAsync($"/api/episodes/{id}", Ct);
        await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 目印がログに出ない")]
    public async Task MarkersDoNotAppearInLogs()
    {
        var (factory, ai) = Create();
        await using var _f = factory;

        await SendMarkedRequests(factory, ai);

        var logs = factory.CapturedLogs;
        Assert.Contains(logs, l => l.Contains("/api/consent"));
        // 答えを送る API と、その失敗のログを通ったこと
        Assert.Contains(logs, l => l.Contains("/messages 400"));
        Assert.Contains(logs, l => l.Contains("/messages 200"));
        Assert.Contains(logs, l => l.Contains("Conversation AI threw InvalidOperationException"));
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
        var (factory, ai) = Create();
        await using var _f = factory;

        await SendMarkedRequests(factory, ai);

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
