using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;
using Revalue.Server.Features.Profile;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

public sealed class ProfileApiTests
{
    private static readonly object[] Chosen = [new { text = "人の役に立つことをしたい", source = "chosen" }];

    private static readonly object ValidConditions =
        new { timeSlots = new[] { "morning", "evening" }, hoursPerWeek = 10, place = "homeOnly", monthlyIncome = (int?)null };

    private static async Task<JsonElement> Get(HttpClient client)
    {
        var response = await client.GetAsync("/api/profile", Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static async Task<JsonElement> PutOk(HttpClient client, string part, object body)
    {
        var response = await client.PutAsJsonAsync($"/api/profile/{part}", body, Ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        return await Json(response);
    }

    private static async Task<List<string>> StoredProfile(RevalueFactory factory)
    {
        var kept = new List<string>();
        await foreach (var json in factory.Services.GetRequiredService<IDataStore>().DumpRawJsonAsync(Ct))
        {
            if (json.Contains("\"type\":\"profile\"", StringComparison.Ordinal))
            {
                kept.Add(json);
            }
        }

        return kept;
    }

    private static async Task AssertRejected(RevalueFactory factory, HttpClient client, string part, string rawJson)
    {
        var before = await StoredProfile(factory);
        var response = await client.PutAsync($"/api/profile/{part}", new StringContent(rawJson, Encoding.UTF8, "application/json"), Ct);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Equal(before, await StoredProfile(factory));
    }

    private static string[] Texts(JsonElement dto, string property) =>
        ValidateTestKit.Array(dto, property).Select(e => e.GetProperty("text").GetString()!).ToArray();

    [Fact(DisplayName = "profile-1（5 つを分けて残す）: 好みを置き換えても、やりたいこと、条件、主体性は変わらない")]
    public async Task ReplacingOneKeepsTheOthers()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-1");
        await PutOk(client, "wants", new { entries = Chosen });
        await PutOk(client, "conditions", ValidConditions);
        await PutOk(client, "agency", new { text = "家族との時間を大事にしたい" });

        await PutOk(client, "preferences", new
        {
            entries = new object[]
            {
                new { text = "自分のペースで進める", source = "written" },
                new { text = "決まった手順がある", source = "chosen" },
            },
        });

        var dto = await Get(client);
        Assert.Equal(["自分のペースで進める", "決まった手順がある"], Texts(dto, "preferences"));
        Assert.Equal(["人の役に立つことをしたい"], Texts(dto, "wants"));
        Assert.Equal(10, dto.GetProperty("conditions").GetProperty("hoursPerWeek").GetInt32());
        Assert.Equal("家族との時間を大事にしたい", dto.GetProperty("agency").GetString());
        var asked = dto.GetProperty("asked");
        Assert.True(asked.GetProperty("preferences").GetBoolean());
        Assert.True(asked.GetProperty("wants").GetBoolean());
        Assert.True(asked.GetProperty("agency").GetBoolean());
    }

    [Fact(DisplayName = "profile-1（5 つを分けて残す）: まだ何も答えていない人には、空の記録と、どの問いにも答えていないことを返す")]
    public async Task FirstVisitReturnsEmptyProfile()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-2");
        var dto = await Get(client);
        Assert.Empty(ValidateTestKit.Array(dto, "preferences"));
        Assert.Empty(ValidateTestKit.Array(dto, "wants"));
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("conditions").ValueKind);
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("agency").ValueKind);
        var asked = dto.GetProperty("asked");
        Assert.False(asked.GetProperty("preferences").GetBoolean());
        Assert.False(asked.GetProperty("wants").GetBoolean());
        Assert.False(asked.GetProperty("agency").GetBoolean());
        var questions = dto.GetProperty("questions");
        Assert.Equal("どんな進め方や環境が、自分に合っていると思いますか？", questions.GetProperty("preferences").GetProperty("question").GetString());
        Assert.Equal(3, questions.GetProperty("wants").GetProperty("choices").GetArrayLength());
        Assert.Equal(7, dto.GetProperty("conditionOptions").GetProperty("hoursPerWeek").GetArrayLength());
        Assert.Equal(7, dto.GetProperty("conditionOptions").GetProperty("monthlyIncome").GetArrayLength());
        Assert.Empty(await StoredProfile(factory));
    }

    [Fact(DisplayName = "profile-3（条件を先に聞く）: 時間帯、週あたりの時間、場所、収入の目安を選んで入れられ、まだ決めていない収入も入れられる")]
    public async Task ConditionsCanBeSet()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-3");
        await PutOk(client, "conditions", new { timeSlots = new[] { "evening", "morning" }, hoursPerWeek = 10, place = "homeOnly", monthlyIncome = (int?)null });
        var conditions = (await Get(client)).GetProperty("conditions");
        Assert.Equal(["morning", "evening"], conditions.GetProperty("timeSlots").EnumerateArray().Select(e => e.GetString()).ToArray());
        Assert.Equal(10, conditions.GetProperty("hoursPerWeek").GetInt32());
        Assert.Equal("homeOnly", conditions.GetProperty("place").GetString());
        Assert.Equal(JsonValueKind.Null, conditions.GetProperty("monthlyIncome").ValueKind);

        await PutOk(client, "conditions", new { timeSlots = new[] { "night" }, hoursPerWeek = 40, place = "canGoOut", monthlyIncome = 8 });
        Assert.Equal(8, (await Get(client)).GetProperty("conditions").GetProperty("monthlyIncome").GetInt32());
    }

    [Theory(DisplayName = "profile-3（条件を先に聞く）: 選択肢にない条件は 400 にし、何も保存しない")]
    [InlineData("""{"timeSlots":["morning"],"hoursPerWeek":7,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("""{"timeSlots":["morning"],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":4}""")]
    [InlineData("""{"timeSlots":[],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("""{"timeSlots":["morning","morning"],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("""{"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("""{"timeSlots":["morning"],"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("""{"timeSlots":["morning"],"hoursPerWeek":10,"monthlyIncome":null}""")]
    public async Task InvalidConditionsAre400(string raw)
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-4");
        await PutOk(client, "conditions", ValidConditions);
        await AssertRejected(factory, client, "conditions", raw);
    }

    [Theory(DisplayName = "profile-3（条件を先に聞く）: 知らない値は 400 にし、何も保存しない")]
    [InlineData("preferences", """{"entries":[{"text":"自分のペースで進められる","source":"guessed"}]}""")]
    [InlineData("wants", """{"entries":[{"text":"人の役に立つことをしたい","source":"guessed"}]}""")]
    [InlineData("conditions", """{"timeSlots":["midnight"],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["morning"],"hoursPerWeek":10,"place":"space","monthlyIncome":null}""")]
    [InlineData("agency", """{"text":123}""")]
    // 数の値（定義にないもの、定義にあるもの、数を書いた文字列）も選択肢の言葉ではないので断る
    [InlineData("preferences", """{"entries":[{"text":"自分のペースで進められる","source":5}]}""")]
    [InlineData("wants", """{"entries":[{"text":"近所で働きたい","source":5}]}""")]
    [InlineData("wants", """{"entries":[{"text":"人の役に立つことをしたい","source":0}]}""")]
    [InlineData("wants", """{"entries":[{"text":"近所で働きたい","source":"5"}]}""")]
    [InlineData("conditions", """{"timeSlots":[9],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["morning"],"hoursPerWeek":10,"place":7,"monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":[9],"hoursPerWeek":10,"place":7,"monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":[0],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["morning"],"hoursPerWeek":10,"place":1,"monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["9"],"hoursPerWeek":10,"place":"7","monthlyIncome":null}""")]
    public async Task UnknownEnumValuesAre400(string part, string raw)
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-5");
        await PutOk(client, "preferences", new { entries = new[] { new { text = "決まった手順がある", source = "chosen" } } });
        await AssertRejected(factory, client, part, raw);
    }

    [Fact(DisplayName = "profile-3（条件を先に聞く）: JSON を通らずに定義にない時間帯、場所、出どころが来ても、照らし合わせで断る")]
    public void ChecksRejectUndefinedEnumValues()
    {
        Assert.NotNull(ProfileEndpoints.CheckConditions(new ConditionsRequest([TimeSlot.Morning], 10, Place.HomeOnly, null)));
        Assert.Null(ProfileEndpoints.CheckConditions(new ConditionsRequest([(TimeSlot)9], 10, Place.HomeOnly, null)));
        Assert.Null(ProfileEndpoints.CheckConditions(new ConditionsRequest([TimeSlot.Morning], 10, (Place)7, null)));

        Assert.NotNull(ProfileEndpoints.CheckEntries(new EntriesRequest([new ProfileEntry("近所で働きたい", EntrySource.Written)]), ProfileText.WantChoices));
        Assert.Null(ProfileEndpoints.CheckEntries(new EntriesRequest([new ProfileEntry("近所で働きたい", (EntrySource)5)]), ProfileText.WantChoices));
    }

    [Fact(DisplayName = "profile-5（好みとやりたいことを一つずつ聞く）: 選んだ答えは選択肢の言葉だけ受け取る")]
    public async Task ChosenMustBeAChoice()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-6");
        await AssertRejected(factory, client, "preferences", """{"entries":[{"text":"人の役に立つことをしたい","source":"chosen"}]}""");
        await AssertRejected(factory, client, "wants", """{"entries":[{"text":"自分のペースで進められる","source":"chosen"}]}""");
        await AssertRejected(factory, client, "wants", """{"entries":[{"text":"自分のペースで進めたい","source":"chosen"}]}""");
        // 選択肢と同じ言葉でも、書いたものとしてなら受け取る
        await PutOk(client, "wants", new { entries = new[] { new { text = "自分のペースで進められる", source = "written" } } });
    }

    [Fact(DisplayName = "profile-4（本人が直せる）: 好みは 0〜5 項目で置き換えられ、空にもできる。6 項目と 101 文字は 400")]
    public async Task PreferencesRange()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-7");
        object Entry(int i) => new { text = $"好み{i}", source = "written" };
        await PutOk(client, "preferences", new { entries = Enumerable.Range(1, 5).Select(Entry).ToArray() });
        Assert.Equal(5, ValidateTestKit.Array(await Get(client), "preferences").Length);

        var six = JsonSerializer.Serialize(new { entries = Enumerable.Range(1, 6).Select(Entry).ToArray() });
        await AssertRejected(factory, client, "preferences", six);
        await AssertRejected(factory, client, "preferences", JsonSerializer.Serialize(new { entries = new[] { new { text = new string('あ', 101), source = "written" } } }));
        await PutOk(client, "preferences", new { entries = new[] { new { text = new string('あ', 100), source = "written" } } });

        var emptied = await PutOk(client, "preferences", new { entries = System.Array.Empty<object>() });
        Assert.Empty(ValidateTestKit.Array(emptied, "preferences"));
        Assert.True(emptied.GetProperty("asked").GetProperty("preferences").GetBoolean());
    }

    [Fact(DisplayName = "profile-4（本人が直せる）: 書いた言葉の前後の空白を落とし、空白だけは 400、同じ言葉は 1 つにまとめる")]
    public async Task EntriesAreTrimmedAndDeduplicated()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-8");
        await AssertRejected(factory, client, "preferences", """{"entries":[{"text":"  　 ","source":"written"}]}""");
        var dto = await PutOk(client, "preferences", new
        {
            entries = new object[]
            {
                new { text = "  朝のうちに片づけたい ", source = "written" },
                new { text = "朝のうちに片づけたい", source = "written" },
                new { text = "決まった手順がある", source = "chosen" },
                new { text = "決まった手順がある", source = "written" },
            },
        });
        Assert.Equal(["朝のうちに片づけたい", "決まった手順がある"], Texts(dto, "preferences"));
        Assert.Equal("chosen", ValidateTestKit.Array(dto, "preferences")[1].GetProperty("source").GetString());
    }

    [Fact(DisplayName = "profile-6（主体性は本人が書く）: 主体性は書いた言葉をそのまま保存し、空なら書いていないことにする。501 文字は 400")]
    public async Task AgencyIsStoredAsWritten()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-9");
        var dto = await PutOk(client, "agency", new { text = "  子どもとの時間を削らずに始めたい  " });
        Assert.Equal("子どもとの時間を削らずに始めたい", dto.GetProperty("agency").GetString());
        Assert.True(dto.GetProperty("asked").GetProperty("agency").GetBoolean());

        await AssertRejected(factory, client, "agency", JsonSerializer.Serialize(new { text = new string('あ', 501) }));
        await PutOk(client, "agency", new { text = new string('あ', 500) });

        dto = await PutOk(client, "agency", new { text = "" });
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("agency").ValueKind);
        Assert.True(dto.GetProperty("asked").GetProperty("agency").GetBoolean());
        dto = await PutOk(client, "agency", new { text = "   " });
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("agency").ValueKind);
    }

    [Fact(DisplayName = "profile-1（5 つを分けて残す）: 2 つの画面で好みとやりたいことを同時に保存しても、どちらも残る")]
    public async Task ConcurrentUpdatesKeepBoth()
    {
        var (factory, _) = Create(interrupting: true);
        var client = await Consenting(factory, "g-10");
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        store.RunOnceBeforeWriting("profile", async () => await PutOk(client, "wants", new { entries = Chosen }));

        await PutOk(client, "preferences", new { entries = new[] { new { text = "決まった手順がある", source = "chosen" } } });

        var dto = await Get(client);
        Assert.Equal(["決まった手順がある"], Texts(dto, "preferences"));
        Assert.Equal(["人の役に立つことをしたい"], Texts(dto, "wants"));
    }

    [Fact(DisplayName = "profile-1（5 つを分けて残す）: 全部消すと 5 つの記録も消え、了解し直すと空から始まる")]
    public async Task DeleteAllRemovesProfile()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-11");
        await PutOk(client, "agency", new { text = "家族との時間を大事にしたい" });
        Assert.NotEmpty(await StoredProfile(factory));

        var deleted = await client.DeleteAsync("/api/me", Ct);
        Assert.Equal(HttpStatusCode.NoContent, deleted.StatusCode);
        Assert.Empty(await StoredProfile(factory));

        client = await Consenting(factory, "g-11");
        var dto = await Get(client);
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("agency").ValueKind);
        Assert.False(dto.GetProperty("asked").GetProperty("agency").GetBoolean());
    }

    [Fact(DisplayName = "profile-1（5 つを分けて残す）: 了解していない人は 5 つの記録を読み書きできない")]
    public async Task ConsentIsRequired()
    {
        var (factory, _) = Create();
        var client = factory.CreateUserClient("g-12");
        var read = await client.GetAsync("/api/profile", Ct);
        var write = await client.PutAsJsonAsync("/api/profile/agency", new { text = "x" }, Ct);
        var other = await client.GetAsync("/api/abilities", Ct);
        Assert.Equal(other.StatusCode, read.StatusCode);
        Assert.Equal(other.StatusCode, write.StatusCode);
        Assert.NotEqual(HttpStatusCode.OK, read.StatusCode);
        Assert.Empty(await StoredProfile(factory));
    }

    [Fact(DisplayName = "profile-2（できることは根拠とつなぐ）: 根拠ありの力は根拠の本人の言葉と一緒に seen に、要確認の力は checking に入り、未確認の力は入らない")]
    public async Task CanDoSplitsSeenAndChecking()
    {
        var (factory, ai) = Create();
        var client = await Consenting(factory, "g-13");
        var first = await FinishedEpisode(client, ai, CoordinatingAll);
        await FinishedEpisode(client, ai, Candidate(Revalue.Server.Features.Validate.Ability.Prioritizing, 1, "迎えの時間をずらして"));

        var canDo = (await Get(client)).GetProperty("canDo");
        var seen = ValidateTestKit.Array(canDo, "seen");
        var seenOne = Assert.Single(seen);
        Assert.Equal("coordinating", seenOne.GetProperty("key").GetString());
        Assert.Equal("調整する力", seenOne.GetProperty("name").GetString());
        Assert.Equal(first, seenOne.GetProperty("episodeId").GetString());
        Assert.Equal(
            ["夫と母の予定がぶつかって", "二人に電話して", "迎えの時間をずらしてもらいました"],
            ValidateTestKit.Array(seenOne, "quotes").Select(q => q.GetProperty("text").GetString()).ToArray());

        var checking = Assert.Single(ValidateTestKit.Array(canDo, "checking"));
        Assert.Equal("prioritizing", checking.GetProperty("key").GetString());
        Assert.NotEmpty(ValidateTestKit.Array(checking, "quotes"));
        Assert.False(canDo.GetProperty("hasExcluded").GetBoolean());
        Assert.DoesNotContain("noticing", canDo.GetRawText());
    }

    [Fact(DisplayName = "profile-2（できることは根拠とつなぐ）: 本人が外した力は、できることに入れず、外した力があることだけを返す")]
    public async Task ExcludedAbilityIsNotShown()
    {
        var (factory, ai) = Create();
        var client = await Consenting(factory, "g-14");
        await FinishedEpisode(client, ai, CoordinatingAll);

        var excluded = await client.PostAsync("/api/abilities/coordinating/exclude", null, Ct);
        Assert.Equal(HttpStatusCode.OK, excluded.StatusCode);
        var canDo = (await Get(client)).GetProperty("canDo");
        Assert.Empty(ValidateTestKit.Array(canDo, "seen"));
        Assert.Empty(ValidateTestKit.Array(canDo, "checking"));
        Assert.True(canDo.GetProperty("hasExcluded").GetBoolean());

        var restored = await client.PostAsync("/api/abilities/coordinating/restore", null, Ct);
        Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
        canDo = (await Get(client)).GetProperty("canDo");
        Assert.Single(ValidateTestKit.Array(canDo, "seen"));
        Assert.False(canDo.GetProperty("hasExcluded").GetBoolean());
    }
}
