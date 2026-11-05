using Revalue.Server.Features.Foundation.Consent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class TalkStreamTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private sealed record SseEvent(string Event, JsonElement Data);

    private static (RevalueFactory Factory, FakeConversationAi Ai) Create(RevalueFactory? baseFactory = null)
    {
        var ai = new FakeConversationAi();
        var factory = (baseFactory ?? new RevalueFactory()).WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
        });
        return (factory, ai);
    }

    /// <summary>偽物の AI と、書き込みの直前にほかの要求を割り込ませる保存先で立ち上げる。</summary>
    private static (RevalueFactory Factory, FakeConversationAi Ai) CreateInterrupting()
    {
        var ai = new FakeConversationAi();
        var factory = new RevalueFactory().WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
            InterruptingDataStore.Install(services);
        });
        return (factory, ai);
    }

    private static async Task<HttpClient> Consenting(RevalueFactory factory, string id)
    {
        var client = factory.CreateUserClient(id);
        var consent = await client.PostAsJsonAsync("/api/consent", new { version = ConsentInfo.CurrentVersion }, Ct);
        Assert.Equal(HttpStatusCode.NoContent, consent.StatusCode);
        return client;
    }

    private static async Task<string> Start(HttpClient client)
    {
        var response = await client.PostAsync("/api/episodes", null, Ct);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        var episode = await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
        return episode.GetProperty("id").GetString()!;
    }

    private static Task<HttpResponseMessage> Send(HttpClient client, string episodeId, string text, string kind = "free") =>
        client.PostAsJsonAsync($"/api/episodes/{episodeId}/messages", new { text, kind }, Ct);

    private static async Task<List<SseEvent>> SendAndRead(HttpClient client, string episodeId, string text, string kind = "free")
    {
        var response = await Send(client, episodeId, text, kind);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType?.MediaType);
        return Parse(await response.Content.ReadAsStringAsync(Ct));
    }

    /// <summary>SSE の本文を、イベントの並びにする。</summary>
    private static List<SseEvent> Parse(string body)
    {
        var events = new List<SseEvent>();
        foreach (var block in body.ReplaceLineEndings("\n").Split("\n\n", StringSplitOptions.RemoveEmptyEntries))
        {
            string? name = null;
            var data = new List<string>();
            foreach (var line in block.Split('\n'))
            {
                if (line.StartsWith("event:", StringComparison.Ordinal))
                {
                    name = line["event:".Length..].Trim();
                }
                else if (line.StartsWith("data:", StringComparison.Ordinal))
                {
                    data.Add(line["data:".Length..].TrimStart(' '));
                }
            }

            using var document = JsonDocument.Parse(string.Join("\n", data));
            events.Add(new SseEvent(name ?? "message", document.RootElement.Clone()));
        }

        return events;
    }

    private static async Task<JsonElement> GetEpisode(HttpClient client, string episodeId)
    {
        var response = await client.GetAsync($"/api/episodes/{episodeId}", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await response.Content.ReadFromJsonAsync<JsonElement>(Ct);
    }

    private static async Task<int> TurnCount(HttpClient client, string episodeId) =>
        (await GetEpisode(client, episodeId)).GetProperty("turns").GetArrayLength();

    private static string Deltas(IEnumerable<SseEvent> events) =>
        string.Concat(events.Where(e => e.Event == "delta").Select(e => e.Data.GetProperty("text").GetString()));

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 本文が少しずつ届き、選択肢は本文に混ざらず最後に届く")]
    public async Task BodyStreamsThenChoicesThenDone()
    {
        var (factory, _) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        var events = await SendAndRead(client, id, "昨日は朝から子どもの支度をして、そのあと町内会の集まりに出ました。");

        var names = events.Select(e => e.Event).ToList();
        Assert.True(names.Count(n => n == "delta") >= 2, string.Join(",", names));
        Assert.All(names.Take(names.Count - 2), n => Assert.Equal("delta", n));
        Assert.Equal(["choices", "done"], names.TakeLast(2));

        var streamed = Deltas(events);
        Assert.Equal(FakeConversationAi.DefaultBody, streamed.TrimEnd());
        Assert.DoesNotContain("---", streamed);
        Assert.DoesNotContain("選択肢", streamed);
        Assert.All(FakeConversationAi.DefaultChoices, c => Assert.DoesNotContain(c, streamed));

        var choices = events.Single(e => e.Event == "choices").Data.GetProperty("choices").EnumerateArray().Select(c => c.GetString()).ToArray();
        Assert.Equal(FakeConversationAi.DefaultChoices, choices);

        var done = events.Single(e => e.Event == "done").Data;
        Assert.Equal(1, done.GetProperty("userTurnCount").GetInt32());
        Assert.Equal("talking", done.GetProperty("status").GetString());
        Assert.Equal("askWhatYouDid", done.GetProperty("move").GetString());

        var turns = (await GetEpisode(client, id)).GetProperty("turns");
        Assert.Equal(3, turns.GetArrayLength());
        Assert.Equal("user", turns[1].GetProperty("role").GetString());
        Assert.Equal("free", turns[1].GetProperty("answerKind").GetString());
        Assert.Equal("assistant", turns[2].GetProperty("role").GetString());
        Assert.Equal(FakeConversationAi.DefaultBody, turns[2].GetProperty("text").GetString());
        Assert.Equal(FakeConversationAi.DefaultChoices, turns[2].GetProperty("choices").EnumerateArray().Select(c => c.GetString()).ToArray());
        Assert.Equal("askWhatYouDid", turns[2].GetProperty("move").GetString());
    }

    [Fact(DisplayName = "discover-3（選んでも書いてもよい）: 選んだ答えは選んだものとして記録される")]
    public async Task ChoiceAnswerIsRecordedAsChoice()
    {
        var (factory, _) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        await SendAndRead(client, id, DiscoverText.OpeningChoices[0], "choice");

        var turns = (await GetEpisode(client, id)).GetProperty("turns");
        Assert.Equal("choice", turns[1].GetProperty("answerKind").GetString());
        Assert.Equal(DiscoverText.OpeningChoices[0], turns[1].GetProperty("text").GetString());
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 返事の途中で失敗したら、何も保存せず、送り直すと 1 往復だけ増える")]
    public async Task FailureMidStreamSavesNothingAndRetryAddsOneRound()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.FailNextReply = (2, ConversationAiException.Failure);

        var failed = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal(["delta", "delta", "error"], failed.Select(e => e.Event));
        Assert.Equal("failure", failed[^1].Data.GetProperty("kind").GetString());
        Assert.Equal(1, await TurnCount(client, id));

        var retried = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal("done", retried[^1].Event);
        Assert.Equal(3, await TurnCount(client, id));
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: AI が断ったら、断ったと知らせ、何も保存しない")]
    public async Task RefusalSavesNothing()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.FailNextReply = (FakeConversationAi.DefaultChunks.Length, ConversationAiException.Refusal);

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal("error", events[^1].Event);
        Assert.Equal("refusal", events[^1].Data.GetProperty("kind").GetString());
        Assert.DoesNotContain(events, e => e.Event is "choices" or "done");
        Assert.Equal(1, await TurnCount(client, id));
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 返事を AI が断ったときも、窓口を添える")]
    public async Task ReplyRefusalAddsSupportNotice()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.FailNextReply = (2, ConversationAiException.Refusal);

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal(["notice", "error"], events.Select(e => e.Event).TakeLast(2));
        Assert.Equal("support", events[^2].Data.GetProperty("kind").GetString());
        Assert.Equal(DiscoverText.PrecautionSupportNote, events[^2].Data.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.SupportLinkUrl, events[^2].Data.GetProperty("linkUrl").GetString());
        Assert.Equal("refusal", events[^1].Data.GetProperty("kind").GetString());
        Assert.Equal(1, await TurnCount(client, id));
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: サインには AI の返事を使わず、決まった言葉と窓口を出し、印を付ける")]
    public async Task DistressUsesFixedTextAndMarksEpisode()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress, AnswerSignal.ConcreteEvent });
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        var events = await SendAndRead(client, id, "最近ずっと眠れなくて、つらいです。");

        Assert.Equal(["notice", "done"], events.Select(e => e.Event));
        var notice = events[0].Data;
        Assert.Equal("distress", notice.GetProperty("kind").GetString());
        Assert.Equal(DiscoverText.DistressText, notice.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.SupportLinkUrl, notice.GetProperty("linkUrl").GetString());
        Assert.Equal(DiscoverText.SupportLinkLabel, notice.GetProperty("linkLabel").GetString());
        Assert.Equal(DiscoverText.DistressActions, notice.GetProperty("actions").EnumerateArray().Select(a => a.GetString()!).ToArray());
        Assert.Empty(ai.Moves);
        Assert.Equal("distress", events[1].Data.GetProperty("move").GetString());

        var store = factory.Services.GetRequiredService<IDataStore>();
        var saved = (await store.GetAsync<EpisodeItem>(TestUsers.Key("g-1"), id, Ct))!;
        Assert.True(saved.ExcludedFromValidation);
        Assert.Equal(3, saved.Turns.Count);
        Assert.Equal(DiscoverText.DistressText, saved.Turns[2].Text);
        Assert.Null(saved.Turns[2].Choices);
        Assert.Equal("distress", saved.Turns[2].Move);
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 開き直しても、サインへの応えのあとに窓口と続け方が出る")]
    public async Task ReopenedEpisodeKeepsDistressNotice()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        // サインの前は、窓口の知らせを付けない
        Assert.Equal(JsonValueKind.Null, (await GetEpisode(client, id)).GetProperty("notice").ValueKind);

        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress });
        await SendAndRead(client, id, "最近ずっと眠れなくて、つらいです。");

        var notice = (await GetEpisode(client, id)).GetProperty("notice");
        Assert.Equal("distress", notice.GetProperty("kind").GetString());
        Assert.Equal(DiscoverText.DistressText, notice.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.SupportLinkUrl, notice.GetProperty("linkUrl").GetString());
        Assert.Equal(DiscoverText.SupportLinkLabel, notice.GetProperty("linkLabel").GetString());
        Assert.Equal(DiscoverText.DistressActions, notice.GetProperty("actions").EnumerateArray().Select(a => a.GetString()!).ToArray());

        // 続けて答え、AI の返事が来たら、知らせは外れる
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent });
        await SendAndRead(client, id, "昨日は子どもを病院に連れて行きました。");
        Assert.Equal(JsonValueKind.Null, (await GetEpisode(client, id)).GetProperty("notice").ValueKind);
    }

    /// <summary>飛ばしたあとの新しい場面の最初のターン。</summary>
    private static async Task<JsonElement> SkipAndReadFirstTurn(HttpClient client, string episodeId)
    {
        var skip = await client.PostAsync($"/api/episodes/{episodeId}/skip", null, Ct);
        Assert.Equal(HttpStatusCode.Created, skip.StatusCode);
        return (await skip.Content.ReadFromJsonAsync<JsonElement>(Ct)).GetProperty("turns")[0];
    }

    /// <summary>つらい状態のサインのあとの入口と同じ問いと選択肢で、家族や家を前提にしていないこと。</summary>
    private static void AssertDistressSafeOpening(JsonElement first)
    {
        var text = first.GetProperty("text").GetString()!;
        var choices = first.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray();
        Assert.Equal(DiscoverText.OpeningAfterDistress, text);
        Assert.Equal(DiscoverText.OpeningAfterDistressChoices, choices);
        Assert.Equal("afterSkip", first.GetProperty("move").GetString());
        foreach (var word in new[] { "家族", "家", "夫", "子ども", "ごはん" })
        {
            Assert.All([text, .. choices], t => Assert.DoesNotContain(word, t, StringComparison.Ordinal));
        }
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: つらい状態のサインのあとに「この話は残さずに、別の話にする」を選ぶと、つらい状態のサインのあとの入口と同じ、家族や家を前提にしない問いで始まる")]
    public async Task SkipRightAfterDistressStartsWithoutFamilyOrHome()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress });
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        await SendAndRead(client, id, "架空の答え。家で大きな声で責められることが続いていて、つらいです。");

        // サインのあとの続け方「この話は残さずに、別の話にする」は、「この話は飛ばす」と同じ API を呼ぶ。
        // サインには家庭内の暴力や暴言も入るので、打ち明けた直後に「家族とゆっくり過ごした」や、ごはんの前後の場面を出さない
        var first = await SkipAndReadFirstTurn(client, id);

        AssertDistressSafeOpening(first);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: つらい状態のサインのあと「続けて話す」で話を続けてから飛ばしても、家族や家を前提にしない問いで始まる")]
    public async Task SkipAfterContinuingFromDistressStartsWithoutFamilyOrHome()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.Reading = turns => turns[^1].Text.Contains("つらい", StringComparison.Ordinal)
            ? new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress })
            : new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent });
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        await SendAndRead(client, id, "架空の答え。家で大きな声で責められることが続いていて、つらいです。");
        await SendAndRead(client, id, "架空の答え。昨日は午後から図書館に行きました。");

        // 続けて話したので、最後の返事はサインへの応えではない（窓口の知らせは外れている）。それでも場面には印が残っている
        Assert.Equal(JsonValueKind.Null, (await GetEpisode(client, id)).GetProperty("notice").ValueKind);
        var first = await SkipAndReadFirstTurn(client, id);

        AssertDistressSafeOpening(first);
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 読み取りに失敗したときも、窓口を添える")]
    public async Task ReadFailureAddsSupportNotice()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.FailNextRead = ConversationAiException.Failure;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal(["notice", "error"], events.Select(e => e.Event));
        Assert.Equal("support", events[0].Data.GetProperty("kind").GetString());
        Assert.Equal(DiscoverText.PrecautionSupportNote, events[0].Data.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.SupportLinkUrl, events[0].Data.GetProperty("linkUrl").GetString());
        Assert.Equal("failure", events[1].Data.GetProperty("kind").GetString());
        Assert.Empty(ai.Moves);
        Assert.Equal(1, await TurnCount(client, id));
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 読み取りを AI が断ったときも、窓口を添える")]
    public async Task ReadRefusalAddsSupportNotice()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.FailNextRead = ConversationAiException.Refusal;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal(["notice", "error"], events.Select(e => e.Event));
        Assert.Equal("support", events[0].Data.GetProperty("kind").GetString());
        Assert.Equal("refusal", events[1].Data.GetProperty("kind").GetString());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 8 往復目の返事のあと話し終えた状態になる")]
    public async Task EighthAnswerFinishesEpisode()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        List<SseEvent> last = [];
        for (var i = 1; i <= NextMovePolicy.MaxUserTurns; i++)
        {
            last = await SendAndRead(client, id, $"{i} つ目の答えです。");
        }

        Assert.DoesNotContain(last, e => e.Event == "choices");
        var done = last.Single(e => e.Event == "done").Data;
        Assert.Equal("finished", done.GetProperty("status").GetString());
        Assert.Equal(8, done.GetProperty("userTurnCount").GetInt32());
        Assert.Equal("close", done.GetProperty("move").GetString());
        Assert.Equal(MoveKind.Close, ai.Moves[^1]);

        var episode = await GetEpisode(client, id);
        Assert.Equal("finished", episode.GetProperty("status").GetString());
        Assert.NotEqual(JsonValueKind.Null, episode.GetProperty("finishedAt").ValueKind);
        var lastTurn = episode.GetProperty("turns")[16];
        Assert.False(lastTurn.TryGetProperty("choices", out _));

        var ninth = await Send(client, id, "9 つ目の答えです。");
        Assert.Equal(HttpStatusCode.Conflict, ninth.StatusCode);
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: ほかの人の場面には送れない")]
    public async Task CannotSendToOthersEpisode()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var owner = await Consenting(factory, "g-1");
        var other = await Consenting(factory, "g-2");
        var id = await Start(owner);

        var response = await Send(other, id, "昨日は買い物に行きました。");

        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
        Assert.Equal(0, ai.ReadCalls);
        Assert.Equal(1, await TurnCount(owner, id));
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 答えを送る API に送信回数の上限が効く")]
    public async Task DailyLimitApplies()
    {
        var (factory, _) = Create(new RevalueFactory().WithSetting("Limits:MessagesPerDay", "1"));
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        await SendAndRead(client, id, "昨日は買い物に行きました。");
        var second = await Send(client, id, "スーパーを 2 軒まわりました。");

        Assert.Equal(HttpStatusCode.TooManyRequests, second.StatusCode);
    }

    [Theory(DisplayName = "discover-3（選んでも書いてもよい）: 空の答え、長すぎる答え、知らない答え方は SSE を始める前に断る")]
    [InlineData("", "free")]
    [InlineData("   ", "free")]
    [InlineData("long", "free")]
    [InlineData("combining", "free")]
    [InlineData("昨日は買い物に行きました。", "voice")]
    [InlineData("昨日は買い物に行きました。", null)]
    public async Task InvalidAnswerIsBadRequest(string text, string? kind)
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        var body = text switch
        {
            "long" => new string('あ', TalkStream.MaxAnswerLength + 1),
            // 見た目は 1 文字のまま、結合文字（U+0301）を重ねて中身だけを長くした答え
            "combining" => "あ" + new string('\u0301', TalkStream.MaxAnswerUtf16Length),
            _ => text,
        };

        var response = await client.PostAsJsonAsync($"/api/episodes/{id}/messages", new { text = body, kind }, Ct);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(0, ai.ReadCalls);
    }

    [Fact(DisplayName = "discover-3（選んでも書いてもよい）: 上限ちょうどの長さの答えは受け取る")]
    public async Task AnswerAtMaxLengthIsAccepted()
    {
        var (factory, _) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        var events = await SendAndRead(client, id, new string('あ', TalkStream.MaxAnswerLength));

        Assert.Equal("done", events[^1].Event);
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 返事を流しているあいだに飛ばした場面は、保存し直さない")]
    public async Task SkippedDuringStreamIsNotResurrected()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.BeforeReply = async () =>
        {
            var skip = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
            Assert.Equal(HttpStatusCode.Created, skip.StatusCode);
        };

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal("error", events[^1].Event);
        Assert.Equal(TalkStream.ClosedError, events[^1].Data.GetProperty("kind").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        var store = (InMemoryDataStore)factory.Services.GetRequiredService<IDataStore>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            Assert.DoesNotContain("昨日は買い物に行きました。", json);
        }
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 返事を保存する直前に飛ばされても、消した場面を作り直さない")]
    public async Task SkipRightBeforeSaveIsNotResurrected()
    {
        var (factory, _) = CreateInterrupting();
        await using var _f = factory;
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        // 返事を受け取り終え、保存を書く直前に、ほかの画面から飛ばす
        store.RunOnceBeforeWriting(id, async () =>
        {
            var skip = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
            Assert.Equal(HttpStatusCode.Created, skip.StatusCode);
        });

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal("error", events[^1].Event);
        Assert.Equal(TalkStream.ClosedError, events[^1].Data.GetProperty("kind").GetString());
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            Assert.DoesNotContain("昨日は買い物に行きました。", json);
        }
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: サインを読み取った往復は、保存の直前に飛ばされても窓口を添える")]
    public async Task DistressStillShowsSupportWhenSaveFails()
    {
        var (factory, ai) = CreateInterrupting();
        await using var _f = factory;
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress });
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        store.RunOnceBeforeWriting(id, async () =>
        {
            var skip = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
            Assert.Equal(HttpStatusCode.Created, skip.StatusCode);
        });

        var events = await SendAndRead(client, id, "もう消えたいと思うことがあります。");

        Assert.Equal(["notice", "error"], events.Select(e => e.Event));
        Assert.Equal("support", events[0].Data.GetProperty("kind").GetString());
        Assert.Equal(DiscoverText.SupportLinkUrl, events[0].Data.GetProperty("linkUrl").GetString());
        Assert.Equal(TalkStream.ClosedError, events[1].Data.GetProperty("kind").GetString());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 返事を保存する直前に区切られたら、区切った場面に答えを足さない")]
    public async Task FinishRightBeforeSaveKeepsFinished()
    {
        var (factory, _) = CreateInterrupting();
        await using var _f = factory;
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        store.RunOnceBeforeWriting(id, async () =>
        {
            var finish = await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);
            Assert.Equal(HttpStatusCode.OK, finish.StatusCode);
        });

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal("error", events[^1].Event);
        Assert.Equal(TalkStream.ClosedError, events[^1].Data.GetProperty("kind").GetString());
        var episode = await GetEpisode(client, id);
        Assert.Equal("finished", episode.GetProperty("status").GetString());
        Assert.Equal(1, episode.GetProperty("turns").GetArrayLength());
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: 2 つの画面から続けて送っても、先に保存した 1 往復を上書きしない")]
    public async Task TwoTabsDoNotOverwriteEachOther()
    {
        var (factory, _) = CreateInterrupting();
        await using var _f = factory;
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        // こちらの保存を書く直前に、ほかの画面の答えが先に保存される
        store.RunOnceBeforeWriting(id, async () =>
        {
            var other = await SendAndRead(client, id, "別の画面からの答えです。");
            Assert.Equal("done", other[^1].Event);
        });

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal("error", events[^1].Event);
        // 場面はまだ話している途中なので、閉じられたのではなく、うまくいかなかったと知らせる
        Assert.Equal(ConversationAiException.Failure, events[^1].Data.GetProperty("kind").GetString());
        var turns = (await GetEpisode(client, id)).GetProperty("turns");
        Assert.Equal(3, turns.GetArrayLength());
        Assert.Equal("別の画面からの答えです。", turns[1].GetProperty("text").GetString());
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: 保存の直前に残す期間を延ばす書き直しが入っても、1 往復を保存する")]
    public async Task TouchRightBeforeSaveStillSaves()
    {
        var (factory, _) = CreateInterrupting();
        await using var _f = factory;
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        // 中身は変えずに書き直す（版だけが変わる）
        store.RunOnceBeforeWriting(id, inner => inner.TouchAllAsync(TestUsers.Key("g-1"), Ct));

        var events = await SendAndRead(client, id, "昨日は買い物に行きました。");

        Assert.Equal("done", events[^1].Event);
        Assert.Equal(3, await TurnCount(client, id));
    }

    [Fact(DisplayName = "評価: 評価の流し方は、答えを送る API と同じ一手、返事、選択肢になる")]
    public async Task EvalRunnerMatchesTalkStream()
    {
        string[] answers =
        [
            "昨日は子どもと買い物に行きました。",
            "分からないです。",
            "いつも朝は忙しいです。",
            "母が入院していて、病院に通いました。",
            "最近ずっと眠れなくて、つらいです。",
        ];
        var ai = new ScriptedConversationAi();
        await using var factory = new RevalueFactory().WithTestServices(services => services.AddSingleton<IConversationAi>(ai));
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        var product = new List<string>();
        foreach (var answer in answers)
        {
            var events = await SendAndRead(client, id, answer);
            var done = events.Single(e => e.Event == "done").Data;
            var move = done.GetProperty("move").GetString();
            var body = move == "distress"
                ? events.Single(e => e.Event == "notice").Data.GetProperty("text").GetString()
                : Deltas(events).TrimEnd();
            var choices = events.SingleOrDefault(e => e.Event == "choices")?.Data.GetProperty("choices").EnumerateArray().Select(c => c.GetString()) ?? [];
            product.Add($"{move} | {body} | {string.Join(" / ", choices)}");
        }

        var script = new Revalue.Evals.EpisodeScript("e99", "試しの例", "discover", "distress", answers.Select(a => new Revalue.Evals.ScriptedAnswer(a, false)).ToList());
        var forbidden = Revalue.Evals.ForbiddenWords.Load(Path.Combine(AppContext.BaseDirectory, "forbidden-words.json"));
        var run = await new Revalue.Evals.EvalRunner(ai, new Revalue.Evals.DryRunJudge(), forbidden).RunAsync(script, Ct);
        var evaluated = run.Replies.Select(r => $"{TalkStream.MoveName(r.Move)} | {r.Body} | {string.Join(" / ", r.Choices)}").ToList();

        Assert.Equal(["askWhatYouDid", "askEasierScene", "askConcreteEvent", "returnFromIllness", "distress"], product.Select(p => p.Split(" | ")[0]));
        Assert.Equal(product, evaluated);
        Assert.True(run.SupportShown);
    }

    private static TurnReading ReadingWith(params EvidenceCandidate[] candidates) =>
        new(new HashSet<AnswerSignal> { AnswerSignal.ConcreteEvent }, candidates);

    private static EvidenceCandidate Candidate(Ability ability, int action, string quote, int answer = 1) =>
        new(ability, action, quote, answer, 1, false, "", 0);

    private static async Task<EpisodeItem> Saved(RevalueFactory factory, string user, string id) =>
        (await factory.Services.GetRequiredService<IDataStore>().GetAsync<EpisodeItem>(TestUsers.Key(user), id, Ct))!;

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 要確認の力があると、返事のターンに一手 askMissingAction と行動が保存される")]
    public async Task MissingActionIsAskedAndSaved()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.Reading = _ => ReadingWith(
            Candidate(Ability.Coordinating, 1, "夫と母の予定がぶつかって"),
            Candidate(Ability.Coordinating, 2, "二人に電話しました"));
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        var events = await SendAndRead(client, id, "昨日は夫と母の予定がぶつかっていたので、二人に電話しました。");

        Assert.Equal("askMissingAction", events.Single(e => e.Event == "done").Data.GetProperty("move").GetString());
        var target = new ActionRef(Ability.Coordinating, 3);
        Assert.Equal(new NextMove(MoveKind.AskMissingAction, target), ai.NextMoves[^1]);

        var saved = await Saved(factory, "g-1", id);
        Assert.Equal("askMissingAction", saved.Turns[2].Move);
        Assert.Equal("coordinating.3", saved.Turns[2].Target);
        Assert.Null(saved.Turns[1].Target);
        Assert.Equal(2, saved.Evidence.Count);
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 照らし合わせを通った根拠だけが場面に保存される")]
    public async Task OnlyCheckedEvidenceIsSaved()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.Reading = _ => ReadingWith(
            Candidate(Ability.Noticing, 1, "顔色がいつもと違う"),
            Candidate(Ability.Noticing, 2, "熱っぽい様子だった"),
            Candidate(Ability.Noticing, 3, "その日の朝"));
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        await SendAndRead(client, id, "朝、子どもの顔色がいつもと違うと気づきました。");

        var saved = await Saved(factory, "g-1", id);
        var evidence = Assert.Single(saved.Evidence);
        Assert.Equal("顔色がいつもと違う", evidence.Quote);
        Assert.Equal(1, evidence.Answer);
        Assert.False(evidence.FromChoice);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 前の往復の根拠は、次の往復の読み取りに出なくても残る")]
    public async Task EarlierEvidenceIsKept()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        ai.Reading = _ => ReadingWith(Candidate(Ability.Prioritizing, 1, "用事が三つ重なって", answer: 1));
        await SendAndRead(client, id, "朝、用事が三つ重なっていました。");
        ai.Reading = _ => ReadingWith(Candidate(Ability.Prioritizing, 2, "病院を先に", answer: 2));
        await SendAndRead(client, id, "病院を先にして、買い物は後にしました。");

        var saved = await Saved(factory, "g-1", id);
        Assert.Equal([1, 2], saved.Evidence.Select(e => e.Action));
        Assert.Equal("用事が三つ重なって", saved.Evidence[0].Quote);
        Assert.Equal(new NextMove(MoveKind.AskMissingAction, new ActionRef(Ability.Prioritizing, 3)), ai.NextMoves[^1]);
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: つらい状態のサインの往復では根拠を保存しない")]
    public async Task DistressRoundSavesNoEvidence()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        ai.Reading = _ => new TurnReading(
            new HashSet<AnswerSignal> { AnswerSignal.Distress, AnswerSignal.ConcreteEvent },
            [Candidate(Ability.Noticing, 1, "いつもと違う")]);
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);

        await SendAndRead(client, id, "いつもと違うと思っても、最近ずっと眠れなくて、つらいです。");

        var saved = await Saved(factory, "g-1", id);
        Assert.True(saved.ExcludedFromValidation);
        Assert.Empty(saved.Evidence);
        Assert.Equal("distress", saved.Turns[2].Move);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 往復の上限は場面ごとの上限に従う")]
    public async Task EpisodeTurnLimitIsUsed()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        var store = factory.Services.GetRequiredService<IDataStore>();
        await store.TryUpdateAsync<EpisodeItem>(TestUsers.Key("g-1"), id, e => e with { TurnLimit = 2 }, Ct);

        await SendAndRead(client, id, "1 つ目の答えです。");
        var last = await SendAndRead(client, id, "2 つ目の答えです。");

        var done = last.Single(e => e.Event == "done").Data;
        Assert.Equal("close", done.GetProperty("move").GetString());
        Assert.Equal("finished", done.GetProperty("status").GetString());
        Assert.Equal(MoveKind.Close, ai.Moves[^1]);
    }
}
