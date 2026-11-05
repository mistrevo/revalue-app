using System.Net;
using System.Net.Http.Json;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Report;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

public sealed class ReportApiTests
{
    private sealed record Kit(RevalueFactory Factory, FakeConversationAi Ai);

    private static Kit Setup()
    {
        var ai = new FakeConversationAi();
        var factory = new RevalueFactory().WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
            services.AddSingleton<IOptionsAi>(new FakeOptionsAi());
            services.AddSingleton<IDeepenAi>(new FakeDeepenAi());
        });
        return new Kit(factory, ai);
    }

    /// <summary>話し終えた場面（利害調整力が見えた力）と、週 10 時間・日中と夕方・家だけの条件がある人。</summary>
    private static async Task<HttpClient> Ready(Kit kit, string user)
    {
        var client = await Consenting(kit.Factory, user);
        await FinishedEpisode(client, kit.Ai, BalancingInterestsAll);
        await PutOk(client, "/api/profile/conditions", new { timeSlots = new[] { "daytime", "evening" }, hoursPerWeek = 10, place = "homeOnly", monthlyIncome = 5 });
        return client;
    }

    private static async Task PutOk(HttpClient client, string path, object body) =>
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(path, body, Ct)).StatusCode);

    /// <summary>仕事のカードを作り、そのカードを選ぶ。</summary>
    private static async Task ChooseCard(HttpClient client, string card = "choose")
    {
        var generated = await client.PostAsync("/api/options", null, Ct);
        Assert.Equal(HttpStatusCode.OK, generated.StatusCode);
        var generatedAt = (await Json(generated)).GetProperty("cards").GetProperty("generatedAt").GetString();
        await PutOk(client, "/api/options/choice", new { kind = "card", card, generatedAt });
    }

    private static Task PutPreferences(HttpClient client, params string[] texts) =>
        PutOk(client, "/api/profile/preferences", new { entries = texts.Select(t => new { text = t, source = "written" }).ToArray() });

    private static async Task<JsonElement> Get(HttpClient client)
    {
        var response = await client.GetAsync("/api/report", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static async Task<long> Reached(HttpClient client) =>
        (await Json(await client.GetAsync("/api/stats", Ct))).GetProperty("reachedReport").GetInt64();

    private static Task<ReportItem?> Stored(Kit kit, string user) =>
        kit.Factory.Services.GetRequiredService<IDataStore>().GetAsync<ReportItem>(TestUsers.Key(user), ReportItem.ItemId, Ct);

    private static int Number(JsonElement dto) => dto.GetProperty("current").GetProperty("number").GetInt32();

    private static List<string> Changed(JsonElement version) =>
        Array(version, "changed").Select(c => c.GetString()!).ToList();

    private static List<string> AbilityKeys(JsonElement abilities) =>
        abilities.EnumerateArray().Select(a => a.GetProperty("key").GetString()!).ToList();

    [Fact(DisplayName = "report-5（保留しても開ける）: 話し終えた場面がなければ ready が false で、版も数も増えない")]
    public async Task NotReadyWithoutFinishedEpisode()
    {
        var kit = Setup();
        var client = await Consenting(kit.Factory, "r-1");

        var dto = await Get(client);

        Assert.False(dto.GetProperty("ready").GetBoolean());
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("content").ValueKind);
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("current").ValueKind);
        Assert.Empty(Array(dto, "previous"));
        Assert.Null(await Stored(kit, "r-1"));
        Assert.Equal(0, await Reached(client));
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: 開くと、まとめた中身と第 1 版を返し、案を選ぶか保留していれば「可能性レポートまで進んだ人」を 1 回だけ数える")]
    public async Task OpensAndCountsOnce()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-2");

        var first = await Get(client);
        Assert.True(first.GetProperty("ready").GetBoolean());
        var content = first.GetProperty("content");
        Assert.Equal(["balancing-interests"], AbilityKeys(content.GetProperty("abilities")));
        var ability = content.GetProperty("abilities")[0];
        Assert.Equal((AbilityText.Name(TestAbilities.BalancingInterests), "confirmed"), (ability.GetProperty("name").GetString(), ability.GetProperty("state").GetString()));
        Assert.Contains(Array(ability, "quotes"), q => q.GetProperty("text").GetString() == "夫と母の予定がぶつかって");
        Assert.Equal(
            AbilityCatalog.Active.Where(a => a != TestAbilities.BalancingInterests).Select(AbilityText.Name),
            Array(content.GetProperty("notYet"), "notHeard").Select(n => n.GetString()));
        Assert.Equal(JsonValueKind.Null, content.GetProperty("choice").GetProperty("kind").ValueKind);
        Assert.Equal(JsonValueKind.Null, content.GetProperty("thinking").ValueKind);
        Assert.Equal(JsonValueKind.Null, content.GetProperty("steps").ValueKind);
        Assert.Equal(1, Number(first));
        Assert.Empty(Changed(first.GetProperty("current")));
        Assert.Empty(Array(first, "previous"));
        // まだ選んでいないので数えない
        Assert.Equal(0, await Reached(client));

        await ChooseCard(client);
        var chosen = await Get(client);
        Assert.Equal("card", chosen.GetProperty("content").GetProperty("choice").GetProperty("kind").GetString());
        Assert.Equal("オンライン秘書", chosen.GetProperty("content").GetProperty("choice").GetProperty("title").GetString());
        Assert.Equal(2, Number(chosen));
        Assert.Equal(1, await Reached(client));

        var again = await Get(client);
        Assert.Equal(2, Number(again));
        Assert.Equal(1, await Reached(client));
        Assert.Equal(2, (await Stored(kit, "r-2"))!.Versions.Count);
    }

    [Theory(DisplayName = "report-1（一つにまとめて示す）: カードを選ばずに保留したときと、自分で書いた仕事を選んだときも、開くと「可能性レポートまで進んだ人」を 1 回だけ数える")]
    [InlineData("hold")]
    [InlineData("own")]
    public async Task CountsHoldAndOwnChoice(string kind)
    {
        var kit = Setup();
        var user = $"r-count-{kind}";
        var client = await Ready(kit, user);
        await Get(client);
        Assert.Equal(0, await Reached(client));

        if (kind == "hold")
        {
            await PutOk(client, "/api/options/choice", new { kind = "hold" });
        }
        else
        {
            var added = await Json(await client.PostAsJsonAsync("/api/options/own", new { title = "架空の地域の見守りの仕事", note = (string?)null }, Ct));
            var ownJobId = Array(added, "ownJobs").Last().GetProperty("id").GetString()!;
            await PutOk(client, "/api/options/choice", new { kind = "own", ownJobId });
        }

        var dto = await Get(client);
        Assert.Equal(kind, dto.GetProperty("content").GetProperty("choice").GetProperty("kind").GetString());
        Assert.Equal(1, await Reached(client));
        await Get(client);
        Assert.Equal(1, await Reached(client));
    }

    [Fact(DisplayName = "report-3（版を残す）: 続きを話している途中で場面を飛ばすと、続きのあいだに作った版を捨て、飛ばしたやりとりからだけ出た力の名前を前の版に残さない")]
    public async Task SkippingResumedTalkDropsItsVersions()
    {
        var kit = Setup();
        var client = await Consenting(kit.Factory, "r-skip-resume");

        // 話し終えた場面が 1 つだけだと、続きを話しているあいだはレポートを開けない（07-report.md の「進める条件」）。場面を 2 つにする
        await FinishedEpisode(client, kit.Ai, BalancingInterestsAll);
        var id = await FinishedEpisode(client, kit.Ai, Candidate(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって"));
        Assert.Equal(1, Number(await Get(client)));

        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        kit.Ai.Reading = _ => ReadingWith(Candidate(TestAbilities.NoticingChanges, 1, "夫と母の予定がぶつかっていた"));
        await Send(client, id, CoordinatingAnswer);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var during = await Get(client);
        Assert.Equal(2, Number(during));
        Assert.Contains("noticing-changes", AbilityKeys(during.GetProperty("content").GetProperty("abilities")));

        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);
        var after = await Get(client);

        // 続きを話す前の中身は第 1 版と同じなので、版は増やさない。続きのあいだに作った第 2 版は残さない
        Assert.Equal(1, Number(after));
        Assert.Empty(Array(after, "previous"));
        Assert.DoesNotContain("noticing-changes", AbilityKeys(after.GetProperty("current").GetProperty("snapshot").GetProperty("abilities")));
        Assert.Equal([1], (await Stored(kit, "r-skip-resume"))!.Versions.Select(v => v.Number));
    }

    [Fact(DisplayName = "report-3（版を残す）: 問いを足さずに続きを開いた場面を飛ばしても、前に作った版は残る")]
    public async Task SkippingResumeWithoutNewQuestionKeepsEarlierVersions()
    {
        var kit = Setup();
        var client = await Consenting(kit.Factory, "r-skip-resume-again");
        await FinishedEpisode(client, kit.Ai, BalancingInterestsAll);
        var id = await FinishedEpisode(client, kit.Ai, Candidate(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって"));
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(1, Number(await Get(client)));
        var first = (await Stored(kit, "r-skip-resume-again"))!.Versions.Single();

        // 続きを開く → 答えずに区切る → また続きを開く（問いは足さない） → 飛ばす
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await Finish(client, id);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);

        // 第 1 版は、続きを始める前に作ったので捨てない
        var stored = (await Stored(kit, "r-skip-resume-again"))!;
        Assert.Equal([(first.Number, first.At)], stored.Versions.Select(v => (v.Number, v.At)));
        Assert.Equal(1, Number(await Get(client)));
    }

    [Fact(DisplayName = "report-3（版を残す）: 話している途中の新しい場面を飛ばすと、その場面を始めたあとに作った版を捨てる。番号は残った版の続きになる")]
    public async Task SkippingNewTalkDropsItsVersions()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-skip-new");
        Assert.Equal(1, Number(await Get(client)));
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        await PutPreferences(client, "家でできる");
        Assert.Equal(2, Number(await Get(client)));

        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var id = await Start(client);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        kit.Ai.Reading = _ => ReadingWith(Candidate(TestAbilities.NoticingChanges, 1, "夫と母の予定がぶつかっていた"));
        await Send(client, id, CoordinatingAnswer);
        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var during = await Get(client);
        Assert.Equal(3, Number(during));
        Assert.Contains("noticing-changes", AbilityKeys(during.GetProperty("content").GetProperty("abilities")));

        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);
        var after = await Get(client);

        Assert.Equal(2, Number(after));
        Assert.Equal([1], Array(after, "previous").Select(v => v.GetProperty("number").GetInt32()));
        Assert.All(
            Array(after, "previous").Append(after.GetProperty("current")),
            v => Assert.DoesNotContain("noticing-changes", AbilityKeys(v.GetProperty("snapshot").GetProperty("abilities"))));
    }

    [Fact(DisplayName = "report-3（版を残す）: 中身が変わったら版が増え、変わった欄を返す")]
    public async Task ChangeAddsVersion()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-3");
        await Get(client);

        await PutPreferences(client, "家でできる");
        var dto = await Get(client);

        Assert.Equal(2, Number(dto));
        Assert.Equal(["records"], Changed(dto.GetProperty("current")));
        var previous = Assert.Single(Array(dto, "previous"));
        Assert.Equal(1, previous.GetProperty("number").GetInt32());
        Assert.Empty(Array(previous.GetProperty("snapshot").GetProperty("records"), "preferences"));
        Assert.Equal("家でできる", dto.GetProperty("content").GetProperty("records").GetProperty("preferences")[0].GetProperty("text").GetString());
    }

    [Fact(DisplayName = "report-3（版を残す）: 案を保留にすると版が増え、選んだ案の欄が変わったと返す")]
    public async Task HoldingAddsVersion()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-4");
        await ChooseCard(client);
        var before = Number(await Get(client));

        await PutOk(client, "/api/options/choice", new { kind = "hold" });
        var dto = await Get(client);

        Assert.Equal(before + 1, Number(dto));
        Assert.Contains("choice", Changed(dto.GetProperty("current")));
        var choice = dto.GetProperty("content").GetProperty("choice");
        Assert.Equal("hold", choice.GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, choice.GetProperty("title").ValueKind);
        Assert.Equal("card", Array(dto, "previous")[0].GetProperty("snapshot").GetProperty("choice").GetProperty("kind").GetString());
    }

    [Fact(DisplayName = "report-3（版を残す）: 前の版には根拠の本人の言葉と、選んだ案の理由を残さず、力の状態も出さない")]
    public async Task VersionsDoNotKeepQuotes()
    {
        const string quote = "夫と母の予定がぶつかって";
        var kit = Setup();
        var client = await Ready(kit, "r-5");
        await ChooseCard(client);
        await Get(client);
        await PutPreferences(client, "家でできる");
        var dto = await Get(client);

        var content = dto.GetProperty("content");
        Assert.Contains(Array(content.GetProperty("abilities")[0], "quotes"), q => q.GetProperty("text").GetString() == quote);
        var reason = content.GetProperty("choice").GetProperty("reason").GetString()!;
        Assert.Contains(quote, reason, StringComparison.Ordinal);
        Assert.Equal("balancing-interests", content.GetProperty("choice").GetProperty("ability").GetProperty("key").GetString());

        var raw = new List<string>();
        await foreach (var json in kit.Factory.Services.GetRequiredService<IDataStore>().DumpRawJsonAsync(Ct))
        {
            if (json.Contains("\"type\":\"report\"", StringComparison.Ordinal))
            {
                raw.Add(JsonNode.Parse(json)!.ToJsonString(new JsonSerializerOptions { Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
            }
        }

        var stored = Assert.Single(raw);
        Assert.Contains("家でできる", stored, StringComparison.Ordinal);
        Assert.DoesNotContain(quote, stored, StringComparison.Ordinal);
        Assert.DoesNotContain(reason, stored, StringComparison.Ordinal);

        // 前の版に出さない、力の状態を表すもの（まだ聞けていない力、確かめ中の力、理由と力を出せなかったわけ）は保存もしない
        Assert.DoesNotContain("\"notHeard\"", stored, StringComparison.Ordinal);
        Assert.DoesNotContain("\"checking\"", stored, StringComparison.Ordinal);
        Assert.DoesNotContain("\"problem\"", stored, StringComparison.Ordinal);

        foreach (var version in Array(dto, "previous").Append(dto.GetProperty("current")))
        {
            var snapshot = version.GetProperty("snapshot");
            var ability = Assert.Single(Array(snapshot, "abilities"));
            Assert.Equal("balancing-interests", ability.GetProperty("key").GetString());
            Assert.False(ability.TryGetProperty("state", out _));
            Assert.False(ability.TryGetProperty("quotes", out _));
            Assert.False(snapshot.GetProperty("choice").TryGetProperty("reason", out _));
            Assert.False(snapshot.GetProperty("choice").TryGetProperty("ability", out _));
            Assert.False(snapshot.GetProperty("choice").TryGetProperty("problem", out _));

            // まだ確かめていないことの欄も、力の状態を表す行（まだ聞けていない力、確かめ中の力、業務で使う力のうち確かめていない力）は出さない
            var notYet = snapshot.GetProperty("notYet");
            Assert.False(notYet.TryGetProperty("notHeard", out _));
            Assert.False(notYet.TryGetProperty("checking", out _));
            Assert.All(Array(notYet, "taskGaps"), gap => Assert.False(gap.TryGetProperty("abilityName", out _)));
        }
    }

    [Fact(DisplayName = "report-3（版を残す）: いま外している力は、前の版にも出さない")]
    public async Task ExcludedAbilityIsHiddenInPreviousVersions()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-6");
        Assert.Equal(["balancing-interests"], AbilityKeys((await Get(client)).GetProperty("content").GetProperty("abilities")));

        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/abilities/balancing-interests/exclude", null, Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/abilities/setting-priorities/exclude", null, Ct)).StatusCode);
        var dto = await Get(client);

        Assert.Empty(AbilityKeys(dto.GetProperty("content").GetProperty("abilities")));
        foreach (var version in Array(dto, "previous"))
        {
            var snapshot = version.GetProperty("snapshot");
            Assert.DoesNotContain("balancing-interests", AbilityKeys(snapshot.GetProperty("abilities")));
            // 前の版のまだ確かめていないことには、力の名前の行がない（力の状態を表すので）
            Assert.False(snapshot.GetProperty("notYet").TryGetProperty("notHeard", out _));
        }

        // 戻せば、前の版にもまた出る（前の版は名前を残している）
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/abilities/balancing-interests/restore", null, Ct)).StatusCode);
        var restored = await Get(client);
        Assert.Contains(Array(restored, "previous"), v => AbilityKeys(v.GetProperty("snapshot").GetProperty("abilities")).Contains("balancing-interests"));
    }

    [Fact(DisplayName = "report-3（版を残す）: 版は新しいものから 10 まで残し、番号は通し番号のまま")]
    public async Task KeepsTenVersions()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-7");
        await Get(client);

        for (var i = 0; i < 10; i++)
        {
            await PutOk(client, "/api/profile/agency", new { text = $"架空の大事にしたいこと {i}" });
            await Get(client);
        }

        var dto = await Get(client);
        Assert.Equal(11, Number(dto));
        Assert.Equal(Enumerable.Range(2, 9).Reverse(), Array(dto, "previous").Select(v => v.GetProperty("number").GetInt32()));
        Assert.Equal(ReportItem.MaxVersions, (await Stored(kit, "r-7"))!.Versions.Count);
    }

    [Fact(DisplayName = "report-3（版を残す）: 同じ中身で同時に開いても、版は 1 つだけ増える")]
    public async Task ConcurrentOpenAddsOneVersion()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-8");
        await Get(client);
        await PutPreferences(client, "家でできる");

        var opened = await Task.WhenAll(Enumerable.Range(0, 5).Select(_ => Get(client)));

        Assert.All(opened, dto => Assert.Equal(2, Number(dto)));
        Assert.Equal(2, (await Stored(kit, "r-8"))!.Versions.Count);
    }

    [Fact(DisplayName = "report-6（話を足したら作り直す）: レポートのあとにまた話して記録が変わると、次に開いたときに版が増える")]
    public async Task TalkingAgainAddsVersion()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-9");
        await Get(client);

        await FinishedEpisode(client, kit.Ai, Candidate(TestAbilities.NoticingChanges, 1, "夫と母の予定がぶつかっていた"));
        var dto = await Get(client);

        Assert.Equal(2, Number(dto));
        Assert.Contains("abilities", Changed(dto.GetProperty("current")));
        // 並びは辞書の順（利害調整力が変化への気づきより前）
        Assert.Equal(["balancing-interests", "noticing-changes"], AbilityKeys(dto.GetProperty("content").GetProperty("abilities")));

        // 話しても中身が変わらなければ、版は増やさない
        Assert.Equal(2, Number(await Get(client)));
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: レポートの API のログに、記録の中身を書かない")]
    public async Task LogsHaveNoContent()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-10");
        await PutOk(client, "/api/profile/agency", new { text = "主体性の目印-5a6b" });
        await PutPreferences(client, "好みの目印-7c8d");
        await ChooseCard(client);

        await Get(client);

        var logs = kit.Factory.CapturedLogs;
        Assert.Contains(logs, l => l.Contains("Report opened", StringComparison.Ordinal));
        foreach (var line in logs)
        {
            Assert.DoesNotContain("目印", line);
            Assert.DoesNotContain("夫と母の予定がぶつかって", line);
            Assert.DoesNotContain("オンライン秘書", line);
        }
    }

    [Fact(DisplayName = "foundation-3（全部消せる）: 全部消すと、レポートの版も消える")]
    public async Task DeleteAllRemovesVersions()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-11");
        await Get(client);
        Assert.NotNull(await Stored(kit, "r-11"));

        Assert.Equal(HttpStatusCode.NoContent, (await client.DeleteAsync("/api/me", Ct)).StatusCode);
        Assert.Null(await Stored(kit, "r-11"));
    }

    [Fact(DisplayName = "report-5（保留しても開ける）: 了解していない人はレポートを開けない")]
    public async Task ConsentIsRequired()
    {
        var kit = Setup();
        var client = kit.Factory.CreateUserClient("r-12");
        var other = await client.GetAsync("/api/profile", Ct);

        Assert.NotEqual(HttpStatusCode.OK, other.StatusCode);
        Assert.Equal(other.StatusCode, (await client.GetAsync("/api/report", Ct)).StatusCode);
    }

    [Fact(DisplayName = "report-1（一つにまとめて示す）: できることの欄に出ていた力を本人が外していれば、いまの中身に「外した力がある」と添える。前の版には足さない")]
    public async Task TellsWhenAbilitiesAreExcluded()
    {
        var kit = Setup();
        var client = await Ready(kit, "r-excluded-flag");
        var before = await Get(client);
        Assert.False(before.GetProperty("content").GetProperty("abilitiesExcluded").GetBoolean());

        // 根拠のない力（欄に出ていない力）を外しただけでは添えない。欄が空の理由は外したことではないため
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/abilities/setting-priorities/exclude", null, Ct)).StatusCode);
        Assert.False((await Get(client)).GetProperty("content").GetProperty("abilitiesExcluded").GetBoolean());

        kit.Factory.Clock.Advance(TimeSpan.FromMinutes(1));
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync("/api/abilities/balancing-interests/exclude", null, Ct)).StatusCode);
        var after = await Get(client);

        var content = after.GetProperty("content");
        Assert.Empty(Array(content, "abilities"));
        Assert.True(content.GetProperty("abilitiesExcluded").GetBoolean());
        Assert.False(after.GetProperty("current").GetProperty("snapshot").TryGetProperty("abilitiesExcluded", out _));
    }
}
