using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Report;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

/// <summary>
/// 業務マスターに置き換える前に保存したデータ（いまの 12 業務の id と、前の名前「日程の調整」「月の締めの手伝い」を持つカードと選んだ案）。
/// 業務は id で業務マスターを引くので、どの画面の API も 200 で、名前は写しのまま、時間帯と収入の目安はいまの業務マスターで計算し直す。
/// </summary>
public sealed class SavedTaskDataTests
{
    private static (RevalueFactory Factory, FakeConversationAi Ai) Setup()
    {
        var ai = new FakeConversationAi();
        var factory = new RevalueFactory().WithTestServices(services =>
        {
            services.AddSingleton<IConversationAi>(ai);
            services.AddSingleton<IOptionsAi>(new FakeOptionsAi());
            services.AddSingleton<IDeepenAi>(new FakeDeepenAi());
        });
        return (factory, ai);
    }

    private static async Task Ok(Task<HttpResponseMessage> request) => Assert.Equal(HttpStatusCode.OK, (await request).StatusCode);

    /// <summary>
    /// 利害調整力が根拠ありの人で、カードを一度作ってから、カードの業務を前の名前と前の時間帯、前の収入の目安に置き換え、
    /// 「選ぶ」を選んだ案にする。カードの元の記録の指紋と力は、作ったときのまま残す。
    /// </summary>
    private static async Task<HttpClient> SavedUser(RevalueFactory factory, FakeConversationAi ai, string user)
    {
        var client = await Consenting(factory, user);
        await FinishedEpisode(client, ai, BalancingInterestsAll);
        await Ok(client.PutAsJsonAsync(
            "/api/profile/conditions", new { timeSlots = new[] { "daytime", "evening" }, hoursPerWeek = 10, place = "homeOnly", monthlyIncome = 5 }, Ct));
        await Ok(client.PostAsync("/api/options", null, Ct));

        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key(user);
        var item = (await store.ListByTypeAsync<OptionsItem>(key, OptionsItem.ItemType, Ct)).Single();
        var generated = item.Cards!;
        var ability = (generated.Choose?.Ability ?? generated.Combine?.Ability)!;
        var oldRange = new WorkRange(3, 10, 4000, 80000);

        CardTask Old(string id, string occupationId, string occupationName, string name, string detail) =>
            new(id, occupationId, occupationName, name, detail, ability.Ability, [TimeSlot.Daytime], TaskPlace.Home, []);

        var choose = new ChooseCard(
            "online-secretary", "オンライン秘書", "連絡や予定の段取りを、オンラインで手伝う仕事",
            [
                Old("online-secretary-schedule", "online-secretary", "オンライン秘書", "日程の調整", "関わる人と連絡を取り合って、会う日時を決める"),
                Old("online-secretary-arrangement", "online-secretary", "オンライン秘書", "出張や会食の手配", "行き先と予算を聞いて、移動と店の候補をまとめる"),
            ],
            oldRange, "理由です。", ability);
        var combine = new CombineCard(
            "小さな事務所の段取り係",
            [
                Old("online-secretary-schedule", "online-secretary", "オンライン秘書", "日程の調整", "関わる人と連絡を取り合って、会う日時を決める"),
                Old("accounting-monthly", "accounting-clerk", "経理事務", "月の締めの手伝い", "月末に数字をそろえる手伝い"),
            ],
            oldRange, "理由です。", ability);

        await store.UpsertAsync(item with
        {
            Cards = generated with { Choose = choose, Combine = combine, Missing = [] },
            Choice = new OptionChoice(ChoiceKind.Card, DateTimeOffset.Parse("2026-11-03T07:00:00Z"), CardKind.Choose, choose, null, null, null),
        }, Ct);
        return client;
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 業務マスターに置き換える前に保存したカードと選んだ案は、写しの名前のまま出し、カードの時間帯と収入の目安はいまの業務マスターの値で計算し直す")]
    public async Task OldCardsKeepNamesAndRecomputeRange()
    {
        var (factory, ai) = Setup();
        await using var _f = factory;
        var client = await SavedUser(factory, ai, "saved-1");

        var response = await client.GetAsync("/api/options", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var dto = await Json(response);

        var cards = dto.GetProperty("cards");
        var choose = cards.GetProperty("choose");
        var tasks = Array(choose, "tasks");
        Assert.Equal("日程の調整", tasks[0].GetProperty("name").GetString());
        Assert.Equal("出張や会食の手配", tasks[1].GetProperty("name").GetString());
        // 時間帯はいまの業務マスターの値（昼と夜）で、本人の時間帯に入るものに計算し直す
        Assert.Equal(["daytime", "evening"], tasks[0].GetProperty("timeSlots").EnumerateArray().Select(e => e.GetString()).ToArray());
        // 時給の下限 1,300 円で計算し直す（1 時間 x 1,300 円 x 4 週を 1,000 円単位で切り下げて 5,000 円。前の値は 4,000 円）
        var range = choose.GetProperty("range");
        Assert.Equal(5000, range.GetProperty("minMonthlyYen").GetInt32());
        Assert.Equal(80000, range.GetProperty("maxMonthlyYen").GetInt32());

        var combine = cards.GetProperty("combine");
        Assert.Equal("月の締めの手伝い", Array(combine, "tasks")[1].GetProperty("name").GetString());

        var chosen = dto.GetProperty("choice").GetProperty("card").GetProperty("choose");
        Assert.Equal("日程の調整", Array(chosen, "tasks")[0].GetProperty("name").GetString());
        // 選んだ案は選んだときの中身の写しなので、収入の目安も選んだときのまま
        Assert.Equal(4000, chosen.GetProperty("range").GetProperty("minMonthlyYen").GetInt32());
    }

    [Fact(DisplayName = "deepen-2（業務ごとに照らす）: 前に選んだ案の業務は、いまの業務マスターの名前と力で照らし、深めた中身を作り直さない")]
    public async Task OldChoiceIsLightedByTheCurrentCatalog()
    {
        var (factory, ai) = Setup();
        await using var _f = factory;
        var client = await SavedUser(factory, ai, "saved-2");

        await Ok(client.PostAsync("/api/deepen", null, Ct));
        var response = await client.GetAsync("/api/deepen", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var content = (await Json(response)).GetProperty("content");

        Assert.False(content.GetProperty("stale").GetBoolean());
        var tasks = Array(content, "tasks");
        Assert.Equal(["会議や面会の日程調整", "出張や会食の手配"], tasks.Select(t => t.GetProperty("name").GetString()).ToArray());
        var generatedAt = content.GetProperty("generatedAt").GetDateTimeOffset();

        // もう一度開いても作り直さない
        var again = (await Json(await client.GetAsync("/api/deepen", Ct))).GetProperty("content");
        Assert.Equal(generatedAt, again.GetProperty("generatedAt").GetDateTimeOffset());
        Assert.False(again.GetProperty("stale").GetBoolean());
    }

    [Fact(DisplayName = "report-3（版を残す）: 前の版を持つ人のレポートは開け、前の版はそのまま残る")]
    public async Task OldVersionsRemain()
    {
        var (factory, ai) = Setup();
        await using var _f = factory;
        var client = await SavedUser(factory, ai, "saved-3");
        await Ok(client.PostAsync("/api/deepen", null, Ct));

        var first = await Json(await client.GetAsync("/api/report", Ct));
        Assert.True(first.GetProperty("ready").GetBoolean());
        // 条件を変えて第 2 版を作る
        await Ok(client.PutAsJsonAsync(
            "/api/profile/conditions", new { timeSlots = new[] { "daytime", "evening" }, hoursPerWeek = 5, place = "homeOnly", monthlyIncome = 5 }, Ct));
        var second = await Json(await client.GetAsync("/api/report", Ct));
        var previousBefore = Array(second, "previous").Length;
        var currentNumber = second.GetProperty("current").GetProperty("number").GetInt32();
        Assert.True(previousBefore >= 1);

        var response = await client.GetAsync("/api/report", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var third = await Json(response);
        Assert.True(Array(third, "previous").Length >= previousBefore);
        Assert.True(third.GetProperty("current").GetProperty("number").GetInt32() >= currentNumber);
        // 選んだ案の業務の名前は、写しのまま
        Assert.Contains("日程の調整", Array(third.GetProperty("content").GetProperty("choice"), "tasks").Select(t => t.GetString()));
    }

    [Fact(DisplayName = "report-3（版を残す）: 確かめる条件を持たない前の形の版も開け、その版の確かめる条件は空で返る")]
    public async Task OldSnapshotWithoutChecksReadsAsEmpty()
    {
        var (factory, ai) = Setup();
        await using var _f = factory;
        var client = await SavedUser(factory, ai, "saved-4");
        await Ok(client.PostAsync("/api/deepen", null, Ct));
        Assert.True((await Json(await client.GetAsync("/api/report", Ct))).GetProperty("ready").GetBoolean());

        // 第 1 版を、確かめる条件（checks）を持たない前の保存の形にする。保存の JSON から消して、読み直したものを置く
        var store = factory.Services.GetRequiredService<IDataStore>();
        var removed = 0;
        Assert.NotNull(await store.TryUpdateAsync<ReportItem>(TestUsers.Key("saved-4"), ReportItem.ItemId, item =>
        {
            var node = JsonSerializer.SerializeToNode(item, DataConstants.Json)!;
            foreach (var gap in node["versions"]!.AsArray().SelectMany(v => v!["snapshot"]!["notYet"]!["taskGaps"]!.AsArray()))
            {
                removed += gap!.AsObject().Remove("checks") ? 1 : 0;
            }

            return node.Deserialize<ReportItem>(DataConstants.Json)!;
        }, Ct));
        Assert.True(removed > 0);

        // 条件を変えて第 2 版を作る。前の形の第 1 版は、確かめる条件を空の配列で返す
        await Ok(client.PutAsJsonAsync(
            "/api/profile/conditions", new { timeSlots = new[] { "daytime", "evening" }, hoursPerWeek = 5, place = "homeOnly", monthlyIncome = 5 }, Ct));
        var response = await client.GetAsync("/api/report", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var report = await Json(response);
        var first = Assert.Single(Array(report, "previous"), v => v.GetProperty("number").GetInt32() == 1);
        var gaps = Array(first.GetProperty("snapshot").GetProperty("notYet"), "taskGaps");
        Assert.NotEmpty(gaps);
        Assert.All(gaps, g => Assert.Empty(Array(g, "checks")));
    }
}
