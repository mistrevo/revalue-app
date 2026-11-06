using Revalue.Server.Features.Foundation.Consent;
using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;

namespace Revalue.Server.Tests;

public sealed class EpisodeTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static async Task<HttpClient> Consenting(RevalueFactory factory, string id)
    {
        var client = factory.CreateUserClient(id);
        var consent = await client.PostAsJsonAsync("/api/consent", new { version = ConsentInfo.CurrentVersion }, Ct);
        Assert.Equal(HttpStatusCode.NoContent, consent.StatusCode);
        return client;
    }

    private static async Task<JsonElement> Json(HttpResponseMessage response) =>
        await response.Content.ReadFromJsonAsync<JsonElement>(Ct);

    private static async Task<JsonElement> Start(HttpClient client)
    {
        var response = await client.PostAsync("/api/episodes", null, Ct);
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);
        return await Json(response);
    }

    /// <summary>保存先に、利用者の答えを足した場面を直接書く（答えを送る API は 02 の Task 4 で作る）。</summary>
    private static async Task AddUserAnswer(RevalueFactory factory, string principalId, string episodeId, string text)
    {
        var store = factory.Services.GetRequiredService<IDataStore>();
        var key = TestUsers.Key(principalId);
        var episode = (await store.GetAsync<EpisodeItem>(key, episodeId, Ct))!;
        await store.UpsertAsync(episode with
        {
            Turns = [.. episode.Turns, new Turn { Role = TurnRoles.User, Text = text, AnswerKind = AnswerKind.Free, At = factory.Clock.GetUtcNow() }],
        }, Ct);
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 新しい場面は、ここ数日で印象に残っている出来事を、気持ちの種類から一つ選んでもらう問いで始まる")]
    public async Task NewEpisodeStartsWithConcreteDayQuestion()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");

        var episode = await Start(client);

        Assert.StartsWith("episode-", episode.GetProperty("id").GetString());
        Assert.Equal("talking", episode.GetProperty("status").GetString());
        var turns = episode.GetProperty("turns");
        Assert.Equal(1, turns.GetArrayLength());
        var first = turns[0];
        Assert.Equal("assistant", first.GetProperty("role").GetString());
        Assert.Equal(DiscoverText.Opening, first.GetProperty("text").GetString());
        Assert.DoesNotContain("強み", first.GetProperty("text").GetString());
        Assert.Contains("印象に残っている出来事", first.GetProperty("text").GetString(), StringComparison.Ordinal);
        Assert.Equal(DiscoverText.OpeningChoices, first.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());
        Assert.Equal(9, DiscoverText.OpeningChoices.Count);
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 本人が答えた話し終えた場面があれば、新しい場面は、「また」と添えた、いつもと違う最初の問いで始まる")]
    public async Task SecondEpisodeAsksAnotherDay()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var first = (await Start(client)).GetProperty("id").GetString()!;
        await AddUserAnswer(factory, "g-1", first, "昨日は子どもを送ってから買い物に行きました");
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync($"/api/episodes/{first}/finish", null, Ct)).StatusCode);

        var turn = (await Start(client)).GetProperty("turns")[0];

        Assert.Equal(DiscoverText.OpeningAnotherDay, turn.GetProperty("text").GetString());
        Assert.NotEqual(DiscoverText.Opening, turn.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.OpeningChoices, turn.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());
        Assert.Equal("opening", turn.GetProperty("move").GetString());
        // 前に話した日を指さず、「別の日」も求めない（前の場面が一般論だけの人や、つらい話で区切った人もいるため）
        Assert.DoesNotContain("別の", DiscoverText.OpeningAnotherDay, StringComparison.Ordinal);
        Assert.DoesNotContain("前に話", DiscoverText.OpeningAnotherDay, StringComparison.Ordinal);
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 答えずに区切った場面しかなければ、新しい場面は、いつもの最初の問いで始まる")]
    public async Task SecondEpisodeAfterUnansweredKeepsOpening()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var first = (await Start(client)).GetProperty("id").GetString()!;
        Assert.Equal(HttpStatusCode.OK, (await client.PostAsync($"/api/episodes/{first}/finish", null, Ct)).StatusCode);

        var turn = (await Start(client)).GetProperty("turns")[0];

        Assert.Equal(DiscoverText.Opening, turn.GetProperty("text").GetString());
    }

    /// <summary>保存先に、本人が答えた話し終えた場面を直接書く。<paramref name="excluded"/> は、つらい状態のサインで力の確かめに使わない印。</summary>
    private static async Task AddFinishedEpisode(RevalueFactory factory, string principalId, DateTimeOffset at, bool excluded)
    {
        var store = factory.Services.GetRequiredService<IDataStore>();
        await store.UpsertAsync(new EpisodeItem
        {
            Id = EpisodeItem.NewId(),
            UserKey = TestUsers.Key(principalId),
            Type = EpisodeItem.ItemType,
            Status = EpisodeStatus.Finished,
            StartedAt = at,
            FinishedAt = at.AddMinutes(10),
            ExcludedFromValidation = excluded,
            Turns =
            [
                new Turn { Role = TurnRoles.Assistant, Text = DiscoverText.Opening, Choices = DiscoverText.OpeningChoices, Move = "opening", At = at },
                new Turn { Role = TurnRoles.User, Text = "架空の答え。昨日は朝から子どもの支度をした", AnswerKind = AnswerKind.Free, At = at },
                excluded
                    ? new Turn { Role = TurnRoles.Assistant, Text = DiscoverText.DistressText, Move = TalkStream.MoveName(MoveKind.Distress), At = at }
                    : new Turn { Role = TurnRoles.Assistant, Text = "架空の返事。話してくれてありがとうございます。", Move = "close", At = at },
            ],
        }, Ct);
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: いちばん新しい話し終えた場面がつらい状態のサインで終わっていれば、新しい場面は気持ちを聞かない問いで始まる")]
    public async Task AfterDistressEpisodeStartsWithoutFeelings()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var now = factory.Clock.GetUtcNow();
        await AddFinishedEpisode(factory, "g-1", now.AddDays(-2), excluded: false);
        await AddFinishedEpisode(factory, "g-1", now.AddDays(-1), excluded: true);

        var turn = (await Start(client)).GetProperty("turns")[0];

        Assert.Equal(DiscoverText.OpeningAfterDistress, turn.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.OpeningAfterDistressChoices, turn.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());
        Assert.Equal("opening", turn.GetProperty("move").GetString());
    }

    [Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: つらい状態のサインの場面のあとに、ふつうに話し終えた場面があれば、「また」の気持ちの問いに戻る")]
    public async Task NormalEpisodeAfterDistressReturnsToAnotherDay()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var now = factory.Clock.GetUtcNow();
        await AddFinishedEpisode(factory, "g-1", now.AddDays(-2), excluded: true);
        await AddFinishedEpisode(factory, "g-1", now.AddDays(-1), excluded: false);

        var turn = (await Start(client)).GetProperty("turns")[0];

        Assert.Equal(DiscoverText.OpeningAnotherDay, turn.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.OpeningChoices, turn.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面があると新しく始められない")]
    public async Task CannotStartWhileTalking()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var first = await Start(client);

        var second = await client.PostAsync("/api/episodes", null, Ct);

        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
        var problem = await Json(second);
        Assert.Equal("/problems/episode-in-progress", problem.GetProperty("type").GetString());
        Assert.Equal(first.GetProperty("id").GetString(), problem.GetProperty("episodeId").GetString());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 区切ると話し終えた状態になり、新しく始められる")]
    public async Task FinishThenStartAgain()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString();

        var finished = await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);

        Assert.Equal(HttpStatusCode.OK, finished.StatusCode);
        var body = await Json(finished);
        Assert.Equal("finished", body.GetProperty("status").GetString());
        Assert.Equal(factory.Clock.GetUtcNow(), body.GetProperty("finishedAt").GetDateTimeOffset());

        // 話し終えた場面をもう一度区切ることはできない
        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/episodes/{id}/finish", null, Ct)).StatusCode);

        var next = await Start(client);
        Assert.NotEqual(id, next.GetProperty("id").GetString());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面は、開き直すとそのまま読める")]
    public async Task TalkingEpisodeCanBeReopened()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;
        await AddUserAnswer(factory, "g-1", id, "架空の答え。昨日は朝から子どもの支度をした");

        var reopened = await client.GetAsync($"/api/episodes/{id}", Ct);

        Assert.Equal(HttpStatusCode.OK, reopened.StatusCode);
        var body = await Json(reopened);
        Assert.Equal("talking", body.GetProperty("status").GetString());
        Assert.Equal(2, body.GetProperty("turns").GetArrayLength());
        Assert.Equal("free", body.GetProperty("turns")[1].GetProperty("answerKind").GetString());
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: 一覧に途中と話し終えた場面が新しい順に出る")]
    public async Task ListShowsEpisodesNewestFirst()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var older = (await Start(client)).GetProperty("id").GetString()!;
        const string answer = "架空の答え。昨日はスーパーで買い物をして、帰りに保育園へ寄って子どもを迎えた";
        await AddUserAnswer(factory, "g-1", older, answer);
        await client.PostAsync($"/api/episodes/{older}/finish", null, Ct);
        factory.Clock.Advance(TimeSpan.FromMinutes(5));
        var newer = (await Start(client)).GetProperty("id").GetString()!;

        var response = await client.GetAsync("/api/episodes", Ct);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var list = (await Json(response)).EnumerateArray().ToArray();
        Assert.Equal([newer, older], list.Select(e => e.GetProperty("id").GetString()));
        Assert.Equal("talking", list[0].GetProperty("status").GetString());
        Assert.Equal(0, list[0].GetProperty("userTurnCount").GetInt32());
        Assert.Equal("", list[0].GetProperty("preview").GetString());
        Assert.Equal("finished", list[1].GetProperty("status").GetString());
        Assert.Equal(1, list[1].GetProperty("userTurnCount").GetInt32());
        Assert.Equal(answer[..30], list[1].GetProperty("preview").GetString());
        Assert.True(list[1].TryGetProperty("startedAt", out _));
        Assert.Equal(JsonValueKind.Null, list[0].GetProperty("finishedAt").ValueKind);
        Assert.Equal(JsonValueKind.String, list[1].GetProperty("finishedAt").ValueKind);
    }

    [Fact(DisplayName = "discover-12（開くとトークが出る）: 一覧に、つらい状態のサインで力の確かめに使わない場面かが出る")]
    public async Task ListShowsExcludedFromValidation()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var now = factory.Clock.GetUtcNow();
        await AddFinishedEpisode(factory, "g-1", now.AddDays(-2), excluded: true);
        await AddFinishedEpisode(factory, "g-1", now.AddDays(-1), excluded: false);

        var list = (await Json(await client.GetAsync("/api/episodes", Ct))).EnumerateArray().ToArray();

        // 新しい順。開いたときに、打ち明けた場面の会話を最初に出さないために画面が使う
        Assert.Equal([false, true], list.Select(e => e.GetProperty("excludedFromValidation").GetBoolean()));
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: ほかの人のエピソードは読めない")]
    public async Task OtherUsersEpisodesAreNotFound()
    {
        await using var factory = new RevalueFactory();
        var owner = await Consenting(factory, "g-1");
        var other = await Consenting(factory, "g-2");
        var id = (await Start(owner)).GetProperty("id").GetString();

        Assert.Equal(HttpStatusCode.NotFound, (await other.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsync($"/api/episodes/{id}/finish", null, Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await other.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);
        Assert.Empty((await Json(await other.GetAsync("/api/episodes", Ct))).EnumerateArray());

        // 持ち主のほうは、何も変わっていない
        var mine = await Json(await owner.GetAsync($"/api/episodes/{id}", Ct));
        Assert.Equal("talking", mine.GetProperty("status").GetString());
    }

    [Fact(DisplayName = "discover-8（話した出来事が残る）: エピソードでないアイテムの id では読めない")]
    public async Task NonEpisodeIdsAreNotFound()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/episodes/consent", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync("/api/episodes/consent/skip", null, Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync("/api/episodes/episode-missing", Ct)).StatusCode);

        // 場面を始めると置く、話している途中の場面の印も、エピソードとしては読めない
        await Start(client);
        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{TalkingMarkItem.ItemId}", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await client.PostAsync($"/api/episodes/{TalkingMarkItem.ItemId}/skip", null, Ct)).StatusCode);
        Assert.Single(await List(client));
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 飛ばすと元の場面は消え、最初とは違う問いで新しい場面が始まる")]
    public async Task SkipDeletesAndStartsWithDifferentQuestion()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;
        const string marker = "架空の飛ばしたい話-目印-7f3a";
        await AddUserAnswer(factory, "g-1", id, marker);

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Created, skipped.StatusCode);
        var next = await Json(skipped);
        Assert.NotEqual(id, next.GetProperty("id").GetString());
        Assert.Equal("talking", next.GetProperty("status").GetString());
        var first = next.GetProperty("turns")[0];
        Assert.Equal(DiscoverText.AfterSkip, first.GetProperty("text").GetString());
        Assert.NotEqual(DiscoverText.Opening, DiscoverText.AfterSkip);
        Assert.Equal(DiscoverText.AfterSkipChoices, first.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());

        Assert.Equal(HttpStatusCode.NotFound, (await client.GetAsync($"/api/episodes/{id}", Ct)).StatusCode);
        var store = factory.Services.GetRequiredService<IDataStore>();
        await foreach (var json in store.DumpRawJsonAsync(Ct))
        {
            Assert.DoesNotContain(marker, json);
        }

        var list = (await Json(await client.GetAsync("/api/episodes", Ct))).EnumerateArray().ToArray();
        Assert.Single(list);
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 話し終えた場面は飛ばせない")]
    public async Task FinishedEpisodeCannotBeSkipped()
    {
        await using var factory = new RevalueFactory();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString();
        await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);

        Assert.Equal(HttpStatusCode.Conflict, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);
    }

    [Fact(DisplayName = "foundation-2（始める前に保存するものを示す）: 了解していない人はエピソードの API を使えない")]
    public async Task EpisodesRequireConsent()
    {
        await using var factory = new RevalueFactory();
        var client = factory.CreateUserClient("g-1");

        Assert.Equal(HttpStatusCode.Forbidden, (await client.GetAsync("/api/episodes", Ct)).StatusCode);
        Assert.Equal(HttpStatusCode.Forbidden, (await client.PostAsync("/api/episodes", null, Ct)).StatusCode);
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 区切る直前に 1 往復が保存されても、その 1 往復を残して区切る")]
    public async Task FinishKeepsRoundSavedJustBefore()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;

        // 区切りを書く直前に、ほかの画面の答えと返事が保存される
        store.RunOnceBeforeWriting(id, async () =>
        {
            var sent = await client.PostAsJsonAsync($"/api/episodes/{id}/messages", new { text = "昨日は買い物に行きました。", kind = "free" }, Ct);
            Assert.Contains("event: done", await sent.Content.ReadAsStringAsync(Ct));
        });

        var finished = await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);

        Assert.Equal(HttpStatusCode.OK, finished.StatusCode);
        var body = await Json(finished);
        Assert.Equal("finished", body.GetProperty("status").GetString());
        Assert.Equal(3, body.GetProperty("turns").GetArrayLength());
        var saved = (await store.GetAsync<EpisodeItem>(TestUsers.Key("g-1"), id, Ct))!;
        Assert.Equal(EpisodeStatus.Finished, saved.Status);
        Assert.Equal(3, saved.Turns.Count);
    }

    private static async Task<JsonElement[]> List(HttpClient client) =>
        (await Json(await client.GetAsync("/api/episodes", Ct))).EnumerateArray().ToArray();

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 飛ばす直前にほかの画面で区切られたら、話し終えた場面を消さない")]
    public async Task SkipKeepsEpisodeFinishedJustBefore()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;
        await AddUserAnswer(factory, "g-1", id, "架空の答え。昨日は公園で子どもと遊んだ");

        // 飛ばす場面を消す直前に、ほかの画面で区切る
        store.RunOnceBeforeWriting(id, async () =>
        {
            var finish = await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);
            Assert.Equal(HttpStatusCode.OK, finish.StatusCode);
        });

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Conflict, skipped.StatusCode);
        Assert.Equal("/problems/episode-finished", (await Json(skipped)).GetProperty("type").GetString());
        var kept = (await store.GetAsync<EpisodeItem>(TestUsers.Key("g-1"), id, Ct))!;
        Assert.Equal(EpisodeStatus.Finished, kept.Status);
        Assert.Equal(2, kept.Turns.Count);
        // 新しい場面も作らない
        Assert.Equal([id], (await List(client)).Select(e => e.GetProperty("id").GetString()));
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 二つの画面から同時に飛ばしても、新しい場面は 1 つだけできる")]
    public async Task ConcurrentSkipsStartOnlyOneEpisode()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;

        // 飛ばす場面を消す直前に、ほかの画面からも飛ばす
        HttpResponseMessage? other = null;
        store.RunOnceBeforeWriting(id, async () => other = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct));

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Created, other!.StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, skipped.StatusCode);
        var only = Assert.Single(await List(client));
        Assert.Equal((await Json(other)).GetProperty("id").GetString(), only.GetProperty("id").GetString());
        Assert.Equal("talking", only.GetProperty("status").GetString());
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 二つの画面から同時に「話す」を押しても、途中の場面は 1 つだけできる")]
    public async Task ConcurrentStartsCreateOnlyOneEpisode()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");

        // 新しい場面を書く直前に、ほかの画面からも始める
        HttpResponseMessage? other = null;
        store.RunOnceBeforeWriting(EpisodeItem.IsEpisodeId, async () => other = await client.PostAsync("/api/episodes", null, Ct));

        var first = await client.PostAsync("/api/episodes", null, Ct);

        Assert.Equal(HttpStatusCode.Created, other!.StatusCode);
        var otherId = (await Json(other)).GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.Conflict, first.StatusCode);
        var problem = await Json(first);
        Assert.Equal("/problems/episode-in-progress", problem.GetProperty("type").GetString());
        Assert.Equal(otherId, problem.GetProperty("episodeId").GetString());
        Assert.Equal([otherId], (await List(client)).Select(e => e.GetProperty("id").GetString()));
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 飛ばしたあとの場面を作る直前にほかの画面で場面が始まったら、2 つ目を作らずにその場面を知らせる")]
    public async Task SkipDoesNotStartSecondEpisodeWhenAnotherStarted()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;

        // 飛ばした場面を消したあと、新しい場面を書く直前に、ほかの画面で「話す」を押す
        HttpResponseMessage? other = null;
        store.RunOnceBeforeWriting(i => EpisodeItem.IsEpisodeId(i) && i != id, async () => other = await client.PostAsync("/api/episodes", null, Ct));

        var skipped = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Created, other!.StatusCode);
        var otherId = (await Json(other)).GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.Conflict, skipped.StatusCode);
        var problem = await Json(skipped);
        Assert.Equal("/problems/episode-in-progress", problem.GetProperty("type").GetString());
        Assert.Equal(otherId, problem.GetProperty("episodeId").GetString());
        // 飛ばした場面は消えたまま。途中の場面は、ほかの画面で始めた 1 つだけ
        Assert.Null(await store.GetAsync<EpisodeItem>(TestUsers.Key("g-1"), id, Ct));
        Assert.Equal([otherId], (await List(client)).Select(e => e.GetProperty("id").GetString()));
    }

    [Fact(DisplayName = "discover-5（つらい話は飛ばせる）: 区切る直前に飛ばされたら、消した場面を作り直さない")]
    public async Task FinishAfterSkipDoesNotResurrect()
    {
        await using var factory = new RevalueFactory().WithTestServices(InterruptingDataStore.Install);
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = (await Start(client)).GetProperty("id").GetString()!;

        store.RunOnceBeforeWriting(id, async () =>
        {
            var skip = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
            Assert.Equal(HttpStatusCode.Created, skip.StatusCode);
        });

        var finished = await client.PostAsync($"/api/episodes/{id}/finish", null, Ct);

        Assert.Equal(HttpStatusCode.NotFound, finished.StatusCode);
        Assert.Null(await store.GetAsync<EpisodeItem>(TestUsers.Key("g-1"), id, Ct));
    }
}
