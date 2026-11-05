using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Report;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

/// <summary>
/// 辞書から消えた力の id（noticing、coordinating、prioritizing）を持つ保存データ（00-common.md の「力」）。
/// 古い id は、消さず、移さず、読むときに無視する。名前を引く前に除き、例外にしない。話した中身はそのまま残る。
/// </summary>
public sealed class LegacyAbilityDataTests
{
    private sealed record Kit(RevalueFactory Factory, FakeConversationAi Ai);

    /// <summary>置き換え先の id と、辞書から消えた古い id。</summary>
    private static readonly (string New, string Old)[] Renames =
    [
        ("noticing-changes", "noticing"),
        ("balancing-interests", "coordinating"),
        ("setting-priorities", "prioritizing"),
    ];

    private static readonly string[] OldNames = ["見立てる力", "調整する力", "優先順位をつける力"];

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

    private static async Task Ok(Task<HttpResponseMessage> request) => Assert.Equal(HttpStatusCode.OK, (await request).StatusCode);

    /// <summary>
    /// 場面、力の本、カードと選んだ案（「創る」）、深めるの中身（業務の見立てと問い）、レポートの版がそろった人を、いまの id で作り、
    /// 保存データの力の id をすべて古い id に書き換える。聞いた行動の印と、訂正で打ち消された印も古い id で置く。
    /// </summary>
    private static async Task<(HttpClient Client, string EpisodeId)> LegacyUser(Kit kit, string user)
    {
        var client = await Consenting(kit.Factory, user);
        var id = await FinishedEpisode(client, kit.Ai,
        [
            .. BalancingInterestsAll,
            Candidate(TestAbilities.NoticingChanges, 1, "夫と母の予定がぶつかって"),
            Candidate(TestAbilities.SettingPriorities, 2, "迎えの時間をずらして"),
        ]);
        await Ok(client.PutAsJsonAsync(
            "/api/profile/conditions", new { timeSlots = new[] { "daytime", "evening" }, hoursPerWeek = 10, place = "homeOnly", monthlyIncome = 5 }, Ct));
        var generated = await client.PostAsync("/api/options", null, Ct);
        Assert.Equal(HttpStatusCode.OK, generated.StatusCode);
        var generatedAt = (await Json(generated)).GetProperty("cards").GetProperty("generatedAt").GetString();
        // 「創る」を選ぶと、深めるで AI が業務を見立てる（業務の力が保存データに残る）
        await Ok(client.PutAsJsonAsync("/api/options/choice", new { kind = "card", card = "create", generatedAt }, Ct));
        await Ok(client.PostAsync("/api/deepen", null, Ct));
        await Ok(client.GetAsync("/api/report", Ct));
        // 外す力は、本人に見せた力（もう少し聞かせてほしいことに出した変化への気づき）
        await Ok(client.PostAsync("/api/abilities/noticing-changes/exclude", null, Ct));

        var store = kit.Factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key(user);
        await Rewrite<EpisodeItem>(store, key, EpisodeItem.ItemType);
        await Rewrite<AbilityBookItem>(store, key, AbilityBookItem.ItemType);
        await Rewrite<OptionsItem>(store, key, OptionsItem.ItemType);
        await Rewrite<DeepenItem>(store, key, DeepenItem.ItemType);
        await Rewrite<ReportItem>(store, key, ReportItem.ItemType);

        // 聞いた行動の印と、訂正で打ち消された印も、古い id で置く
        await store.TryUpdateAsync<EpisodeItem>(key, id, e => e with
        {
            Turns =
            [
                .. e.Turns.Select((t, i) => i == e.Turns.Count - 1 && t.Role == TurnRoles.Assistant ? t with { Target = "noticing.2" }
                    : i == 1 ? t with { Withdrawn = ["coordinating.1"] }
                    : t),
            ],
        }, Ct);
        return (client, id);
    }

    /// <summary>保存したアイテムの JSON で、置き換え先の id を古い id に書き換えて、置き直す。</summary>
    private static async Task Rewrite<T>(IDataStore store, string key, string type) where T : Item
    {
        foreach (var item in await store.ListByTypeAsync<T>(key, type, Ct))
        {
            var json = JsonSerializer.Serialize(item, DataConstants.Json);
            var rewritten = Renames.Aggregate(json, (current, r) => current
                .Replace($"\"{r.New}\"", $"\"{r.Old}\"", StringComparison.Ordinal)
                .Replace($"\"{r.New}.", $"\"{r.Old}.", StringComparison.Ordinal));
            Assert.NotEqual(json, rewritten);
            await store.UpsertAsync(JsonSerializer.Deserialize<T>(rewritten, DataConstants.Json)!, Ct);
        }
    }

    private static string[] Paths(string episodeId) =>
    [
        "/api/abilities",
        "/api/episodes",
        $"/api/episodes/{episodeId}",
        "/api/profile",
        "/api/options",
        "/api/deepen",
        "/api/report",
        "/api/next-step",
    ];

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 辞書から消えた力の id を持つ保存データがあっても、どの API も 500 にならない")]
    public async Task LegacyDataDoesNotBreakApis()
    {
        var kit = Setup();
        await using var _f = kit.Factory;
        var (client, id) = await LegacyUser(kit, "legacy-1");

        foreach (var path in Paths(id))
        {
            var response = await client.GetAsync(path, Ct);
            Assert.True(response.StatusCode == HttpStatusCode.OK, $"{path}: {(int)response.StatusCode}");
        }

        // 続きを話せない場面なら 409
        var resumed = await Resume(client, id);
        Assert.Contains(resumed.StatusCode, new[] { HttpStatusCode.OK, HttpStatusCode.Conflict });
    }

    [Fact(DisplayName = "validate-1（すべてそろったときだけ根拠あり）: 辞書から消えた力の根拠と履歴は数えず、応答に古い id も名前も入らない。話した中身は残る")]
    public async Task LegacyAbilitiesAreIgnored()
    {
        var kit = Setup();
        await using var _f = kit.Factory;
        var (client, id) = await LegacyUser(kit, "legacy-2");

        foreach (var path in Paths(id))
        {
            var body = await (await client.GetAsync(path, Ct)).Content.ReadAsStringAsync(Ct);
            foreach (var (_, old) in Renames)
            {
                Assert.DoesNotContain($"\"{old}\"", body, StringComparison.Ordinal);
                Assert.DoesNotContain($"\"{old}.", body, StringComparison.Ordinal);
            }

            Assert.All(OldNames, name => Assert.DoesNotContain(name, body, StringComparison.Ordinal));
        }

        // 力の本は、古い力を数えない。履歴も出さない
        var abilities = await Json(await client.GetAsync("/api/abilities", Ct));
        Assert.All(Array(abilities, "abilities"), a => Assert.Equal("notYet", a.GetProperty("life").GetString()));
        Assert.Empty(Array(abilities, "history"));

        // 話した中身はそのまま残る（保存データも消さない）
        var episode = await GetEpisode(client, id);
        Assert.Contains(Array(episode, "turns"), t => t.GetProperty("text").GetString() == CoordinatingAnswer);
        var stored = await Saved(kit.Factory, "legacy-2", id);
        Assert.Contains(stored.Evidence, e => e.Ability == TestAbilities.Old("coordinating"));
        Assert.Equal("noticing.2", stored.Turns[^1].Target);
    }

    [Fact(DisplayName = "validate-12（本人が見立てを外せる）: 辞書から消えた力の id を外す・戻すと 404")]
    public async Task LegacyAbilityCannotBeExcluded()
    {
        var kit = Setup();
        await using var _f = kit.Factory;
        var (client, _) = await LegacyUser(kit, "legacy-3");

        foreach (var (_, old) in Renames)
        {
            Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/api/abilities/{old}/exclude", null, Ct)).StatusCode);
            Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/api/abilities/{old}/restore", null, Ct)).StatusCode);
        }
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 深めるの業務と問いの力が辞書から消えていたら、力の名前を添えずに返す")]
    public async Task LegacyDeepenAbilitiesHaveNoName()
    {
        var kit = Setup();
        await using var _f = kit.Factory;
        var (client, _) = await LegacyUser(kit, "legacy-4");

        var content = (await Json(await client.GetAsync("/api/deepen", Ct))).GetProperty("content");
        var tasks = Array(content, "tasks");
        Assert.NotEmpty(tasks);
        Assert.All(tasks, t =>
        {
            Assert.Equal(JsonValueKind.Null, t.GetProperty("ability").ValueKind);
            Assert.Equal(JsonValueKind.Null, t.GetProperty("abilityName").ValueKind);
            // 使えるところとして示さない
            Assert.Equal(JsonValueKind.Null, t.GetProperty("usable").ValueKind);
        });
        var questions = Array(content, "questions");
        Assert.NotEmpty(questions);
        Assert.All(questions, q => Assert.Equal(JsonValueKind.Null, q.GetProperty("abilityName").ValueKind));
    }

    [Fact(DisplayName = "report-3（版を残す）: 前の版の力が辞書から消えていたら、その力を除いて返す")]
    public async Task LegacyReportVersionsDropAbilities()
    {
        var kit = Setup();
        await using var _f = kit.Factory;
        var (client, _) = await LegacyUser(kit, "legacy-5");

        var report = await Json(await client.GetAsync("/api/report", Ct));
        Assert.True(report.GetProperty("ready").GetBoolean());
        var versions = Array(report, "previous").Append(report.GetProperty("current")).ToList();
        Assert.All(versions, v => Assert.Empty(Array(v.GetProperty("snapshot"), "abilities")));
        Assert.Empty(Array(report.GetProperty("content"), "abilities"));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: カードと選んだ案の力が辞書から消えていたら、理由と力を出さない")]
    public async Task LegacyCardAbilitiesAreHidden()
    {
        var kit = Setup();
        await using var _f = kit.Factory;
        var (client, _) = await LegacyUser(kit, "legacy-6");

        var options = await Json(await client.GetAsync("/api/options", Ct));
        var chosen = options.GetProperty("choice").GetProperty("card");
        Assert.Equal("create", chosen.GetProperty("kind").GetString());
        // カードと選んだ案のどれにも、辞書から消えた力の理由と力を出さない
        var cards = new[] { options.GetProperty("cards"), chosen };
        var shown = 0;
        foreach (var holder in cards)
        {
            foreach (var name in new[] { "choose", "combine", "create" })
            {
                if (holder.ValueKind == JsonValueKind.Object && holder.TryGetProperty(name, out var card) && card.ValueKind == JsonValueKind.Object)
                {
                    shown++;
                    Assert.Equal(JsonValueKind.Null, card.GetProperty("ability").ValueKind);
                    Assert.Equal(JsonValueKind.Null, card.GetProperty("reason").ValueKind);
                }
            }
        }

        Assert.True(shown > 0);
    }
}
