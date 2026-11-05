using System.Net;
using System.Net.Http.Json;
using System.Text;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;
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
        Assert.Equal([1, 3, 5, 10, 15, 20, 30, 40], ValidateTestKit.Array(dto.GetProperty("conditionOptions"), "hoursPerWeek").Select(e => e.GetInt32()).ToArray());
        Assert.Equal([1, 3, 5, 8, 10, 15, 20], ValidateTestKit.Array(dto.GetProperty("conditionOptions"), "monthlyIncome").Select(e => e.GetInt32()).ToArray());
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

        // 使える時間が少ない人も、実際より多い時間を選ばずに済む
        await PutOk(client, "conditions", new { timeSlots = new[] { "daytime" }, hoursPerWeek = 1, place = "homeOnly", monthlyIncome = (int?)null });
        Assert.Equal(1, (await Get(client)).GetProperty("conditions").GetProperty("hoursPerWeek").GetInt32());
    }

    [Theory(DisplayName = "profile-3（条件を先に聞く）: 選択肢にない条件は 400 にし、何も保存しない")]
    [InlineData("""{"timeSlots":["morning"],"hoursPerWeek":7,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("""{"timeSlots":["morning"],"hoursPerWeek":2,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("""{"timeSlots":["morning"],"hoursPerWeek":0,"place":"homeOnly","monthlyIncome":null}""")]
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
    // カンマでつないだ名前（値のビット和として読むと、選んでいない「夜」や「外に出ることもできる」に化ける）、
    // 前後の空白、大文字小文字の違い、名前でない null も、名前と完全には一致しないので断る
    [InlineData("conditions", """{"timeSlots":["daytime, evening"],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["daytime,evening"],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["morning"],"hoursPerWeek":10,"place":"homeOnly, canGoOut","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":[" morning "],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["morning"],"hoursPerWeek":10,"place":"homeOnly ","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["Morning"],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":["morning"],"hoursPerWeek":10,"place":"HomeOnly","monthlyIncome":null}""")]
    [InlineData("conditions", """{"timeSlots":[null],"hoursPerWeek":10,"place":"homeOnly","monthlyIncome":null}""")]
    [InlineData("wants", """{"entries":[{"text":"人の役に立つことをしたい","source":"chosen, written"}]}""")]
    [InlineData("wants", """{"entries":[{"text":"人の役に立つことをしたい","source":"Written"}]}""")]
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

        Assert.NotNull(ProfileEndpoints.CheckEntries(new EntriesRequest([new EntryRequest("近所で働きたい", EntrySource.Written)]), ProfileText.WantChoices));
        Assert.Null(ProfileEndpoints.CheckEntries(new EntriesRequest([new EntryRequest("近所で働きたい", (EntrySource)5)]), ProfileText.WantChoices));
        Assert.Null(ProfileEndpoints.CheckEntries(new EntriesRequest([new EntryRequest("近所で働きたい", null)]), ProfileText.WantChoices));
        Assert.Null(ProfileEndpoints.CheckEntries(new EntriesRequest([new EntryRequest("人の役に立つことをしたい", null)]), ProfileText.WantChoices));
    }

    [Theory(DisplayName = "profile-5（好みとやりたいことを一つずつ聞く）: 選んだか書いたかや、言葉のない項目は 400 にし、何も保存しない")]
    // source がないとき、選択肢の言葉を「選んだ答え」として扱わない
    [InlineData("preferences", """{"entries":[{"text":"自分のペースで進められる"}]}""")]
    [InlineData("wants", """{"entries":[{"text":"近所で働きたい"}]}""")]
    [InlineData("wants", """{"entries":[{"text":"人の役に立つことをしたい","source":null}]}""")]
    [InlineData("wants", """{"entries":[{"source":"written"}]}""")]
    [InlineData("wants", """{"entries":[null]}""")]
    [InlineData("wants", """{}""")]
    public async Task EntriesWithoutSourceOrTextAre400(string part, string raw)
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-15");
        await PutOk(client, "preferences", new { entries = new[] { new { text = "決まった手順がある", source = "chosen" } } });
        await AssertRejected(factory, client, part, raw);
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

    [Fact(DisplayName = "profile-4（本人が直せる）: 見た目は 1 文字でも、結合文字を重ねて長くした書いた答えは 400 にする")]
    public async Task EntriesAreLimitedInUtf16Length()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-16");
        object Written(string text) => new { entries = new[] { new { text, source = "written" } } };

        // "a" に結合文字（U+0301）を重ねると、見た目は 1 文字のまま長くなる
        var piled = "a" + new string('\u0301', ProfileText.MaxEntryUtf16Length);
        await AssertRejected(factory, client, "preferences", JsonSerializer.Serialize(Written(piled)));
        await AssertRejected(factory, client, "wants", JsonSerializer.Serialize(Written("a" + new string('\u0301', 200_000))));
        await PutOk(client, "preferences", Written(piled[..ProfileText.MaxEntryUtf16Length]));

        // 絵文字のように 1 文字が 2 つ分の長さのものも、100 文字までは受け取る
        var emoji = string.Concat(Enumerable.Repeat("😀", ProfileText.MaxEntryLength));
        Assert.Equal([emoji], Texts(await PutOk(client, "wants", Written(emoji)), "wants"));
        await AssertRejected(factory, client, "wants", JsonSerializer.Serialize(Written(emoji + "😀")));
    }

    [Fact(DisplayName = "profile-4（本人が直せる）: 見える文字がない書いた答えは、空白だけのときと同じく 400 にする")]
    public async Task InvisibleEntriesAre400()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-17");
        // 幅のない空白（U+200B）、つなぎの文字、BOM、制御文字、ハングルの埋め字、点字の空白、結合文字だけ
        foreach (var invisible in new[] { "\u200B", " \u200B\u3000", "\u200C\u200D\u2060", "\uFEFF", "\u0001", "\u3164", "\u2800", "\u0301" })
        {
            await AssertRejected(factory, client, "preferences", JsonSerializer.Serialize(new { entries = new[] { new { text = invisible, source = "written" } } }));
        }

        // 見える文字があれば、絵文字をつなぐ文字（U+200D）を含んでいても受け取る
        var dto = await PutOk(client, "preferences", new { entries = new[] { new { text = "家族で👨\u200D👩\u200D👧", source = "written" } } });
        Assert.Equal(["家族で👨\u200D👩\u200D👧"], Texts(dto, "preferences"));
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

    [Fact(DisplayName = "profile-6（主体性は本人が書く）: 見える文字がない主体性は書いていないことにし、結合文字を重ねて長くしたものは 400 にする")]
    public async Task AgencyIgnoresInvisibleTextAndIsLimitedInUtf16Length()
    {
        var (factory, _) = Create();
        var client = await Consenting(factory, "g-18");
        await PutOk(client, "agency", new { text = "家族との時間を大事にしたい" });

        var dto = await PutOk(client, "agency", new { text = " \u200B\u2060\u3000" });
        Assert.Equal(JsonValueKind.Null, dto.GetProperty("agency").ValueKind);
        Assert.True(dto.GetProperty("asked").GetProperty("agency").GetBoolean());

        var piled = "b" + new string('\u0301', ProfileText.MaxAgencyUtf16Length);
        await AssertRejected(factory, client, "agency", JsonSerializer.Serialize(new { text = piled }));
        await AssertRejected(factory, client, "agency", JsonSerializer.Serialize(new { text = "b" + new string('\u0301', 200_000) }));
        dto = await PutOk(client, "agency", new { text = piled[..ProfileText.MaxAgencyUtf16Length] });
        Assert.Equal(ProfileText.MaxAgencyUtf16Length, dto.GetProperty("agency").GetString()!.Length);
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
        var first = await FinishedEpisode(client, ai, BalancingInterestsAll);
        await FinishedEpisode(client, ai, Candidate(TestAbilities.SettingPriorities, 1, "迎えの時間をずらして"));

        var canDo = (await Get(client)).GetProperty("canDo");
        var seen = ValidateTestKit.Array(canDo, "seen");
        var seenOne = Assert.Single(seen);
        Assert.Equal("balancing-interests", seenOne.GetProperty("key").GetString());
        Assert.Equal("利害調整力", seenOne.GetProperty("name").GetString());
        Assert.Equal(first, seenOne.GetProperty("episodeId").GetString());
        Assert.Equal(
            ["夫と母の予定がぶつかって", "二人に電話して", "迎えの時間をずらしてもらいました"],
            ValidateTestKit.Array(seenOne, "quotes").Select(q => q.GetProperty("text").GetString()).ToArray());

        var checking = Assert.Single(ValidateTestKit.Array(canDo, "checking"));
        Assert.Equal("setting-priorities", checking.GetProperty("key").GetString());
        Assert.NotEmpty(ValidateTestKit.Array(checking, "quotes"));
        Assert.False(canDo.GetProperty("hasExcluded").GetBoolean());
        Assert.DoesNotContain("noticing-changes", canDo.GetRawText());
    }

    [Fact(DisplayName = "profile-2（できることは根拠とつなぐ）: できることには見せた力だけが入り、根拠に行動の文が添えてある")]
    public async Task CanDoHasOnlyShownAbilitiesWithActionText()
    {
        var (factory, ai) = Create();
        var client = await Consenting(factory, "g-15");
        // 利害調整力（行動 3 つ）と段取り力（行動 2 つ）が同じ出来事でそろう。同じ分類なので、見せるのは利害調整力だけ
        await FinishedEpisode(client, ai,
        [
            .. BalancingInterestsAll,
            Candidate(TestAbilities.PlanningSteps, 1, "夫と母の予定がぶつかって"),
            Candidate(TestAbilities.PlanningSteps, 2, "迎えの時間をずらしてもらいました"),
        ]);

        var canDo = (await Get(client)).GetProperty("canDo");

        var seen = Assert.Single(ValidateTestKit.Array(canDo, "seen"));
        Assert.Equal("balancing-interests", seen.GetProperty("key").GetString());
        Assert.Equal(
            Enumerable.Range(1, 3).Select(n => AbilityCatalog.ActionText(new ActionRef(TestAbilities.BalancingInterests, n))),
            ValidateTestKit.Array(seen, "quotes").Select(q => q.GetProperty("action").GetString()));
        Assert.Empty(ValidateTestKit.Array(canDo, "checking"));
        Assert.DoesNotContain("planning-steps", canDo.GetRawText(), StringComparison.Ordinal);
    }

    [Fact(DisplayName = "profile-2（できることは根拠とつなぐ）: 本人が外した力は、できることに入れず、外した力があることだけを返す")]
    public async Task ExcludedAbilityIsNotShown()
    {
        var (factory, ai) = Create();
        var client = await Consenting(factory, "g-14");
        await FinishedEpisode(client, ai, BalancingInterestsAll);

        var excluded = await client.PostAsync("/api/abilities/balancing-interests/exclude", null, Ct);
        Assert.Equal(HttpStatusCode.OK, excluded.StatusCode);
        var canDo = (await Get(client)).GetProperty("canDo");
        Assert.Empty(ValidateTestKit.Array(canDo, "seen"));
        Assert.Empty(ValidateTestKit.Array(canDo, "checking"));
        Assert.True(canDo.GetProperty("hasExcluded").GetBoolean());

        var restored = await client.PostAsync("/api/abilities/balancing-interests/restore", null, Ct);
        Assert.Equal(HttpStatusCode.OK, restored.StatusCode);
        canDo = (await Get(client)).GetProperty("canDo");
        Assert.Single(ValidateTestKit.Array(canDo, "seen"));
        Assert.False(canDo.GetProperty("hasExcluded").GetBoolean());
    }
}
