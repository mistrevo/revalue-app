using System.Net;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

public sealed class CorrectionTests
{
    private const string CorrectionText = "電話をしたのは私ではなく、夫でした。";

    /// <summary>訂正の前は調整する力の 3 つ、訂正のあとは 2 つの候補を返す読み取り。</summary>
    private static TurnReading ReadBeforeAndAfterCorrection(IReadOnlyList<Turn> turns) =>
        turns[^1].AnswerKind == AnswerKind.Correction
            ? ReadingWith(CoordinatingAll[0], CoordinatingAll[2])
            : ReadingWith(CoordinatingAll);

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 訂正を送ると読み直し、状態が変わった力の履歴に correction が残る")]
    public async Task CorrectionRereadsAndRecordsHistory()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = ReadBeforeAndAfterCorrection;
        await Send(client, id, CoordinatingAnswer);
        await Finish(client, id);
        Assert.Single(Array((await GetEpisode(client, id)).GetProperty("insights"), "seen"));
        factory.Clock.Advance(TimeSpan.FromMinutes(5));

        var response = await Correct(client, id, "  " + CorrectionText + "  ");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var episode = await Json(response);
        Assert.Equal("finished", episode.GetProperty("status").GetString());
        var last = Array(episode, "turns")[^1];
        Assert.Equal("user", last.GetProperty("role").GetString());
        Assert.Equal("correction", last.GetProperty("answerKind").GetString());
        Assert.Equal(CorrectionText, last.GetProperty("text").GetString());
        var insights = episode.GetProperty("insights");
        Assert.Empty(Array(insights, "seen"));
        var more = Assert.Single(Array(insights, "moreToHear"));
        Assert.Equal("coordinating", more.GetProperty("key").GetString());
        // 訂正で打ち消された行動（本人から電話をかけたこと）は、訂正のターンに印を残し、手がかりとして聞き直さない。
        // 足りないのがその行動だけなら、手がかりは出さない
        Assert.Equal(["coordinating.2"], Array(last, "withdrawn").Select(w => w.GetString()));
        Assert.Empty(Array(more, "hints"));
        Assert.True(insights.GetProperty("canResume").GetBoolean());

        // 訂正のときは場面全体を読み直した結果で置き換える（前の根拠と合わせない）
        var saved = await Saved(factory, "g-1", id);
        Assert.Equal([1, 3], saved.Evidence.Select(e => e.Action));

        var abilities = await Json(await client.GetAsync("/api/abilities", Ct));
        var change = abilities.GetProperty("history")[0];
        Assert.Equal("correction", change.GetProperty("reason").GetString());
        Assert.Equal("coordinating", change.GetProperty("key").GetString());
        Assert.Equal("confirmed", change.GetProperty("from").GetString());
        Assert.Equal("needsCheck", change.GetProperty("to").GetString());
        Assert.Equal(id, change.GetProperty("episodeId").GetString());
        Assert.Equal(factory.Clock.GetUtcNow(), change.GetProperty("at").GetDateTimeOffset());
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 訂正で打ち消された行動は、見えた力の手がかりにも、続きの最初の問いにも、続きの中の聞き返しにも出さない")]
    public async Task WithdrawnActionIsNotAskedAgain()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = ReadBeforeAndAfterCorrection;
        await Send(client, id, CoordinatingAnswer);
        await Finish(client, id);
        Assert.Equal(HttpStatusCode.OK, (await Correct(client, id, CorrectionText)).StatusCode);

        var abilities = await Json(await client.GetAsync("/api/abilities", Ct));
        var coordinating = Array(abilities, "abilities").Single(a => a.GetProperty("key").GetString() == "coordinating");
        Assert.Equal("needsCheck", coordinating.GetProperty("life").GetString());
        Assert.Empty(Array(coordinating, "hints"));

        // 足りない行動がほかになければ、続きは手がかりを添えない問いで始める
        var resumed = await Resume(client, id);
        Assert.Equal(HttpStatusCode.OK, resumed.StatusCode);
        var question = Array(await Json(resumed), "turns")[^1];
        Assert.False(question.TryGetProperty("target", out _));
        Assert.EndsWith(AbilityText.ResumeOpenAsk, question.GetProperty("text").GetString(), StringComparison.Ordinal);

        // 続きの中で、読み取りが同じ出来事の行動 1 と 3 を返しても、打ち消された行動 2 は聞き返さない
        ai.Reading = _ => ReadingWith(CoordinatingAll[0], CoordinatingAll[2]);
        await Send(client, id, "少し覚えています");
        Assert.DoesNotContain(ai.NextMoves, m => m.Target == new ActionRef(Ability.Coordinating, 2));
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 訂正で打ち消された行動が、足りない行動のうち一部なら、ほかの足りない行動の手がかりは出す")]
    public async Task OtherMissingHintsRemain()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        // 訂正の前は調整する力の 1 と 2、訂正のあとは 1 だけ
        ai.Reading = turns => turns[^1].AnswerKind == AnswerKind.Correction
            ? ReadingWith(CoordinatingAll[0])
            : ReadingWith(CoordinatingAll[0], CoordinatingAll[1]);
        await Send(client, id, CoordinatingAnswer);
        await Finish(client, id);

        var episode = await Json(await Correct(client, id, CorrectionText));

        Assert.Equal(["coordinating.2"], Array(Array(episode, "turns")[^1], "withdrawn").Select(w => w.GetString()));
        var more = Assert.Single(Array(episode.GetProperty("insights"), "moreToHear"));
        Assert.Equal([AbilityText.Hint(new ActionRef(Ability.Coordinating, 3))], Array(more, "hints").Select(h => h.GetString()));
        // 区切る前の最後の問いに答えていないと、その行動は続きの最初の問いで聞かない。聞ける形にするため、聞いた記録を外す
        await factory.Services.GetRequiredService<IDataStore>().TryUpdateAsync<EpisodeItem>(
            TestUsers.Key("g-1"), id, e => e with { Turns = [.. e.Turns.Select(t => t with { Target = null })] }, Ct);
        var question = Array(await Json(await Resume(client, id)), "turns")[^1];
        Assert.Equal("coordinating.3", question.GetProperty("target").GetString());
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 打ち消された行動がない訂正では、訂正のターンに印を残さない")]
    public async Task CorrectionWithoutWithdrawalHasNoMark()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, CoordinatingAll[0]);
        ai.Reading = _ => ReadingWith(CoordinatingAll[0], CoordinatingAll[1]);

        var episode = await Json(await Correct(client, id, "二人に電話したのは私です。"));

        Assert.False(Array(episode, "turns")[^1].TryGetProperty("withdrawn", out _));
        Assert.Null((await Saved(factory, "g-1", id)).Turns[^1].Withdrawn);
    }

    [Fact(DisplayName = "validate-8（訂正したら確かめ直す）: 話している途中、印のある場面、空や長すぎる訂正は断り、何も保存しない")]
    public async Task CorrectionRejectsWrongStateAndInvalidText()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var excluded = await FinishedEpisode(client, ai, CoordinatingAll);
        await store.TryUpdateAsync<EpisodeItem>(TestUsers.Key("g-1"), excluded, e => e with { ExcludedFromValidation = true }, Ct);
        var finished = await FinishedEpisode(client, ai, CoordinatingAll);
        var talking = await Start(client);
        var before = await StoredContent(store);
        Assert.Contains(before, j => j.Contains("\"type\":\"episode\"", StringComparison.Ordinal));
        var reads = ai.ReadCalls;

        var results = new[]
        {
            await Correct(client, talking, CorrectionText),
            await Correct(client, excluded, CorrectionText),
            await Correct(client, finished, ""),
            await Correct(client, finished, "   "),
            await Correct(client, finished, null),
            await Correct(client, finished, new string('あ', TalkStream.MaxAnswerLength + 1)),
            await Correct(client, "episode-none", CorrectionText),
        };

        Assert.Equal(
            [HttpStatusCode.Conflict, HttpStatusCode.Conflict, HttpStatusCode.BadRequest, HttpStatusCode.BadRequest,
             HttpStatusCode.BadRequest, HttpStatusCode.BadRequest, HttpStatusCode.NotFound],
            results.Select(r => r.StatusCode));
        var inProgress = await Json(results[0]);
        Assert.Equal("/problems/episode-in-progress", inProgress.GetProperty("type").GetString());
        Assert.Equal(talking, inProgress.GetProperty("episodeId").GetString());
        Assert.Equal("/problems/episode-excluded", (await Json(results[1])).GetProperty("type").GetString());
        Assert.Equal("/problems/invalid-answer", (await Json(results[2])).GetProperty("type").GetString());
        Assert.Equal(reads, ai.ReadCalls);
        Assert.Equal(before, await StoredContent(store));

        // 見た目は 1 文字のまま、結合文字（U+0301）を重ねて中身だけを長くした訂正は断る
        var combining = await Correct(client, finished, "あ" + new string('\u0301', TalkStream.MaxAnswerUtf16Length));
        Assert.Equal(HttpStatusCode.BadRequest, combining.StatusCode);
        Assert.Equal(reads, ai.ReadCalls);

        // 2,000 文字ちょうどは受け取る（絵文字などの合成された文字は 1 文字と数える）
        var longest = await Correct(client, finished, string.Concat(Enumerable.Repeat("👨‍👩‍👧", TalkStream.MaxAnswerLength)));
        Assert.Equal(HttpStatusCode.OK, longest.StatusCode);
    }

    [Theory(DisplayName = "validate-8（訂正したら確かめ直す）: AI が失敗・拒否したら 503 と種類を返し、相談窓口を添え、何も保存しない")]
    [InlineData(ConversationAiException.Failure)]
    [InlineData(ConversationAiException.Refusal)]
    public async Task AiFailureSavesNothing(string kind)
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, CoordinatingAll);
        var before = await Saved(factory, "g-1", id);
        ai.FailNextRead = kind;

        var response = await Correct(client, id, CorrectionText);

        Assert.Equal(HttpStatusCode.ServiceUnavailable, response.StatusCode);
        var problem = await Json(response);
        Assert.Equal(kind, problem.GetProperty("kind").GetString());
        // 読み取りの失敗は、つらい状態のサインを見落としているかもしれないので、話す画面と同じく窓口を添える
        Assert.Equal("support", problem.GetProperty("notice").GetProperty("kind").GetString());
        Assert.Equal(DiscoverText.SupportLinkUrl, problem.GetProperty("notice").GetProperty("linkUrl").GetString());
        var after = await Saved(factory, "g-1", id);
        Assert.Equal(before.Turns.Count, after.Turns.Count);
        Assert.Equal(before.Evidence, after.Evidence);
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 訂正にサインがあれば、決まった言葉の返事と相談窓口を出し、印を付ける")]
    public async Task DistressInCorrection()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, CoordinatingAll);
        var before = await Saved(factory, "g-1", id);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, [Candidate(Ability.Noticing, 1, "眠れなくて")]);

        var response = await Correct(client, id, "最近ずっと眠れなくて、つらいです。");

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var episode = await Json(response);
        var turns = Array(episode, "turns");
        Assert.Equal("correction", turns[^2].GetProperty("answerKind").GetString());
        Assert.Equal(DiscoverText.DistressText, turns[^1].GetProperty("text").GetString());
        Assert.Equal("distress", turns[^1].GetProperty("move").GetString());
        Assert.Equal("distress", episode.GetProperty("notice").GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, episode.GetProperty("insights").ValueKind);

        var saved = await Saved(factory, "g-1", id);
        Assert.True(saved.ExcludedFromValidation);
        Assert.Equal(before.Evidence, saved.Evidence);
        Assert.Equal(EpisodeStatus.Finished, saved.Status);
        Assert.Equal(0, ai.Moves.Count(m => m == MoveKind.Distress));

        // 場面を確かめに使わなくなったことを、訂正とは別の理由で履歴に残す（validate-8 の「なぜ」を取り違えない）
        var change = (await Json(await client.GetAsync("/api/abilities", Ct))).GetProperty("history")[0];
        Assert.Equal("coordinating", change.GetProperty("key").GetString());
        Assert.Equal("setAside", change.GetProperty("reason").GetString());
        Assert.Equal("confirmed", change.GetProperty("from").GetString());
        Assert.Equal("notYet", change.GetProperty("to").GetString());
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 話している途中にサインが出て場面を確かめに使わなくなったら、履歴の理由は setAside")]
    public async Task DistressWhileTalkingRecordsSetAside()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll);
        await Send(client, id, CoordinatingAnswer);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, []);

        await Send(client, id, "最近ずっと眠れなくて、つらいです。");

        var history = Array(await Json(await client.GetAsync("/api/abilities", Ct)), "history");
        Assert.Equal(
            [("coordinating", "setAside", "confirmed", "notYet"), ("coordinating", "talk", "notYet", "confirmed")],
            history.Select(h => (
                h.GetProperty("key").GetString(), h.GetProperty("reason").GetString(), h.GetProperty("from").GetString(), h.GetProperty("to").GetString())));
    }

    [Fact(DisplayName = "foundation-6（使いすぎを穏やかに止める）: 訂正にも送信回数の上限が効く")]
    public async Task DailyLimitApplies()
    {
        var (factory, ai) = Create(baseFactory: new RevalueFactory().WithSetting("Limits:MessagesPerDay", "2"));
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, CoordinatingAll);

        var second = await Correct(client, id, CorrectionText);
        var third = await Correct(client, id, CorrectionText);

        Assert.Equal(HttpStatusCode.OK, second.StatusCode);
        Assert.Equal(HttpStatusCode.TooManyRequests, third.StatusCode);
    }

    [Fact(DisplayName = "common-2（ログに中身を書かない）: 訂正の文と引用はログに出ない")]
    public async Task LogsHaveNoCorrectionText()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, CoordinatingAll);
        ai.Reading = _ => ReadingWith(Candidate(Ability.Coordinating, 2, "目印の訂正ことば", answer: 2));

        Assert.Equal(HttpStatusCode.OK, (await Correct(client, id, "目印の訂正ことばです。")).StatusCode);
        ai.FailNextRead = ConversationAiException.Failure;
        Assert.Equal(HttpStatusCode.ServiceUnavailable, (await Correct(client, id, "目印の訂正ことば その 2")).StatusCode);

        Assert.DoesNotContain(factory.CapturedLogs, l => l.Contains("目印の訂正ことば", StringComparison.Ordinal));
    }
}
