using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

public sealed class ResumeTests
{
    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きを話すと、話している途中に戻り、足りない行動の手がかりを添えた問いで始まる")]
    public async Task ResumeReopensWithHintQuestion()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        // 利害調整力は 2 つ、優先順位設定力は 1 つ。行動の多い利害調整力の、足りない行動 3 を聞く
        var id = await FinishedEpisode(client, ai,
            BalancingInterestsAll[0], BalancingInterestsAll[1], Candidate(TestAbilities.SettingPriorities, 2, "迎えの時間をずらして"));
        // 区切る前の最後の問いに答えていないと、その行動は続きの最初の問いで聞かない。聞ける形にするため、聞いた記録を外す
        await factory.Services.GetRequiredService<IDataStore>().TryUpdateAsync<EpisodeItem>(
            TestUsers.Key("g-1"), id, e => e with { Turns = [.. e.Turns.Select(t => t with { Target = null })] }, Ct);

        var response = await Resume(client, id);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var episode = await Json(response);
        Assert.Equal("talking", episode.GetProperty("status").GetString());
        Assert.Equal(JsonValueKind.Null, episode.GetProperty("finishedAt").ValueKind);
        Assert.Equal(JsonValueKind.Null, episode.GetProperty("insights").ValueKind);
        var question = Array(episode, "turns")[^1];
        Assert.Equal("assistant", question.GetProperty("role").GetString());
        // 受け止めの一文、聞く力の根拠のうちいちばん短い本人の言葉の映し返し、足りない行動の問い一つ、の順（4-rules.md の「対話の決まり」）
        Assert.Equal(
            AbilityText.ResumeLead + "前に「二人に電話して」と話してくれましたね。その日、みんなの都合を合わせたり、別の案を出したりしたことはありましたか？",
            question.GetProperty("text").GetString());
        Assert.Contains("二人に電話して", CoordinatingAnswer, StringComparison.Ordinal);
        Assert.Equal(AbilityText.ResumeChoices, Array(question, "choices").Select(c => c.GetString()));
        Assert.Equal("resume", question.GetProperty("move").GetString());
        Assert.Equal("balancing-interests.3", question.GetProperty("target").GetString());

        // 続きの答えを送れる
        ai.Reading = _ => ReadingWith(BalancingInterestsAll[0], BalancingInterestsAll[1]);
        await Send(client, id, "少し覚えています");
        Assert.Equal(6, (await Saved(factory, "g-1", id)).Turns.Count);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 答えずに区切った問いと同じ行動は、続きの最初の問いで聞かない")]
    public async Task ResumeDoesNotAskUnansweredAction()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        var last = (await Saved(factory, "g-1", id)).Turns[^1];
        Assert.Equal(TurnRoles.Assistant, last.Role);
        Assert.Equal("balancing-interests.3", last.Target);

        var question = Array(await Json(await Resume(client, id)), "turns")[^1];

        Assert.False(question.TryGetProperty("target", out var target) && target.ValueKind != JsonValueKind.Null);
        Assert.Equal(AbilityText.ResumeOpening(null, "二人に電話して"), question.GetProperty("text").GetString());
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 答えずに区切った問いのあとに訂正があっても、その問いの行動は続きの最初の問いで聞かない")]
    public async Task ResumeDoesNotAskUnansweredActionAfterCorrection()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        await factory.Services.GetRequiredService<IDataStore>().TryUpdateAsync<EpisodeItem>(TestUsers.Key("g-1"), id, e => e with
        {
            Turns = [.. e.Turns, new Turn { Role = TurnRoles.User, Text = "夫は母とは別の人です", AnswerKind = AnswerKind.Correction, At = e.StartedAt }],
        }, Ct);

        var question = Array(await Json(await Resume(client, id)), "turns")[^1];

        Assert.False(question.TryGetProperty("target", out var target) && target.ValueKind != JsonValueKind.Null);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの問いに答えずにまた区切ってから続きを開くと、問いを足さず、その問いから続ける")]
    public async Task ResumeAgainWithoutAnswerKeepsQuestion()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);

        await Resume(client, id);
        var first = await Saved(factory, "g-1", id);
        await Finish(client, id);
        var response = await Resume(client, id);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var second = await Saved(factory, "g-1", id);
        Assert.Equal(first.Turns.Count, second.Turns.Count);
        Assert.Equal((first.Turns[^1].Text, first.Turns[^1].Target), (second.Turns[^1].Text, second.Turns[^1].Target));
        Assert.Equal(first.Turns[^1].Choices, second.Turns[^1].Choices);
        Assert.Equal(EpisodeStatus.Talking, second.Status);
        Assert.Null(second.FinishedAt);
        Assert.Equal(second.UserTurnCount + NextMovePolicy.ResumeExtraTurns, second.TurnLimit);
        Assert.Equal(first.Turns.Count, Array(await Json(response), "turns").Length);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの問いに答えずに区切ったあとに訂正したら、訂正を読んだうえで新しい続きの問いを足し、前の続きの問いの行動は聞かない")]
    public async Task ResumeAfterCorrectionAddsNewQuestion()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var candidates = new[] { BalancingInterestsAll[0], BalancingInterestsAll[1], Candidate(TestAbilities.SettingPriorities, 2, "迎えの時間をずらして") };
        var id = await FinishedEpisode(client, ai, candidates);

        await Resume(client, id);
        var first = (await Saved(factory, "g-1", id)).Turns[^1];
        Assert.Equal(EpisodeInsights.ResumeMove, first.Move);
        Assert.NotNull(first.Target);
        await Finish(client, id);
        Assert.Equal(HttpStatusCode.OK, (await Correct(client, id, "迎えは夫ではなく母に頼みました")).StatusCode);
        var corrected = await Saved(factory, "g-1", id);
        Assert.Equal(AnswerKind.Correction, corrected.Turns[^1].AnswerKind);

        var response = await Resume(client, id);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var after = await Saved(factory, "g-1", id);
        Assert.Equal(corrected.Turns.Count + 1, after.Turns.Count);
        var question = after.Turns[^1];
        Assert.Equal(TurnRoles.Assistant, question.Role);
        Assert.Equal(EpisodeInsights.ResumeMove, question.Move);
        Assert.NotEqual(first.Target, question.Target);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 問いを足さずに続きを開いた場面を飛ばすと、前に話し終えていた姿に戻る")]
    public async Task SkipAfterResumeWithoutNewQuestionKeepsFinished()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        await Resume(client, id);
        await Finish(client, id);
        var before = await Saved(factory, "g-1", id);
        await Resume(client, id);

        Assert.Equal(HttpStatusCode.Created, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);

        var after = await Saved(factory, "g-1", id);
        Assert.Equal(EpisodeStatus.Finished, after.Status);
        Assert.Equal(before.TurnLimit, after.TurnLimit);
        Assert.Equal(before.Turns.Select(t => (t.Role, t.Text, t.Move)), after.Turns.Select(t => (t.Role, t.Text, t.Move)));
        Assert.Equal(before.Evidence, after.Evidence);
        Assert.False(after.ExcludedFromValidation);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 答えずに区切った問いの行動を避けて、ほかの要確認の力の足りない行動を聞く。続きの中では、続きの問いで聞いた力に絞る（revisit-4（いまの話を聞き切る））")]
    public async Task ResumeAsksNextActionAndAvoidedActionStaysAskable()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        // 利害調整力は 2 つ、優先順位設定力は 1 つ。区切る前の最後の問いは、利害調整力 3 を聞いていた（答えていない）
        var id = await FinishedEpisode(client, ai,
            BalancingInterestsAll[0], BalancingInterestsAll[1], Candidate(TestAbilities.SettingPriorities, 2, "迎えの時間をずらして"));
        Assert.Equal("balancing-interests.3", (await Saved(factory, "g-1", id)).Turns[^1].Target);

        var question = Array(await Json(await Resume(client, id)), "turns")[^1];

        // 利害調整力 3 は避け、次の要確認の力（優先順位設定力）の足りない行動を聞く
        Assert.Equal("setting-priorities.1", question.GetProperty("target").GetString());
        Assert.Equal(
            AbilityText.ResumeOpening(new ActionRef(TestAbilities.SettingPriorities, 1), "迎えの時間をずらして"),
            question.GetProperty("text").GetString());

        // 続きの問いで聞いた力（優先順位設定力）に絞る。利害調整力 3 はまだ 1 回しか聞いていないが、続きの答えのあと、そちらへは移らない
        ai.Reading = _ => ReadingWith(BalancingInterestsAll[0], BalancingInterestsAll[1], Candidate(TestAbilities.SettingPriorities, 2, "迎えの時間をずらして"));
        await Send(client, id, "少し覚えています");

        Assert.Equal(new NextMove(MoveKind.AskMissingAction, new ActionRef(TestAbilities.SettingPriorities, 1)), ai.NextMoves[^1]);
    }

    [Fact(DisplayName = "revisit-4（いまの話を聞き切る）: 続きの問いで聞いた力の根拠が続きの答えの出来事になければ、答えずに区切った別の力の行動へは移らない")]
    public async Task ResumeFocusDoesNotReturnToAvoidedAbility()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai,
            BalancingInterestsAll[0], BalancingInterestsAll[1], Candidate(TestAbilities.SettingPriorities, 2, "迎えの時間をずらして"));
        Assert.Equal("setting-priorities.1", Array(await Json(await Resume(client, id)), "turns")[^1].GetProperty("target").GetString());

        ai.Reading = _ => ReadingWith(BalancingInterestsAll[0], BalancingInterestsAll[1]);
        await Send(client, id, "少し覚えています");

        Assert.Equal(new NextMove(MoveKind.AskWhatYouDid), ai.NextMoves[^1]);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 問いを足さずに続きを開くとき、印を書き換える直前にほかの画面で印が変わったら、話し終えた状態に戻す")]
    public async Task ResumeWithoutNewQuestionRevertsWhenMarkChanged()
    {
        var (factory, ai) = Create(interrupting: true);
        await using var _f = factory;
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);
        await Finish(client, id);
        var before = await Saved(factory, "g-1", id);
        var key = TestUsers.Key("g-1");

        // 印を書き換える直前に、ほかの要求が新しい場面と印を書いた（中の保存先に直接書く）
        var otherId = EpisodeItem.NewId();
        store.RunOnceBeforeWriting(TalkingMarkItem.ItemId, async inner =>
        {
            await inner.UpsertAsync(EpisodeItem.Start(key, factory.Clock.GetUtcNow(), DiscoverText.Opening, DiscoverText.OpeningChoices, "opening") with { Id = otherId }, Ct);
            await inner.UpsertAsync(new TalkingMarkItem { Id = TalkingMarkItem.ItemId, UserKey = key, Type = TalkingMarkItem.ItemType, EpisodeId = otherId }, Ct);
        });

        var response = await Resume(client, id);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(otherId, (await Json(response)).GetProperty("episodeId").GetString());
        var saved = await Saved(factory, "g-1", id);
        Assert.Equal(EpisodeStatus.Finished, saved.Status);
        Assert.Equal(before.FinishedAt, saved.FinishedAt);
        Assert.Equal(before.TurnLimit, saved.TurnLimit);
        Assert.Equal(before.Turns.Select(t => (t.Role, t.Text, t.Move)), saved.Turns.Select(t => (t.Role, t.Text, t.Move)));
        Assert.Equal(
            (before.BeforeResume?.TurnCount, before.BeforeResume?.FinishedAt, before.BeforeResume?.TurnLimit, before.BeforeResume?.ResumedAt),
            (saved.BeforeResume?.TurnCount, saved.BeforeResume?.FinishedAt, saved.BeforeResume?.TurnLimit, saved.BeforeResume?.ResumedAt));
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きを話すと、往復の上限が 4 増える")]
    public async Task ResumeExtendsTurnLimit()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0]);

        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);

        var saved = await Saved(factory, "g-1", id);
        Assert.Equal(1 + NextMovePolicy.ResumeExtraTurns, saved.TurnLimit);
        Assert.Equal(4, NextMovePolicy.ResumeExtraTurns);
        Assert.Null(saved.FinishedAt);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの問いに「その日のほかのことを話したい」を選ぶと、足りない行動ではなく、同じ日のほかの時間や出来事を聞く")]
    public async Task ResumeChoiceOtherThingsAsksOtherPartOfDay()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        // 最初の往復で利害調整力 3 を聞いた記録を外す（足りない行動をまだ聞ける形にする）
        await factory.Services.GetRequiredService<IDataStore>().TryUpdateAsync<EpisodeItem>(
            TestUsers.Key("g-1"), id, e => e with { Turns = [.. e.Turns.Select(t => t with { Target = null })] }, Ct);
        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);

        ai.Reading = _ => ReadingWith(BalancingInterestsAll[0], BalancingInterestsAll[1]);
        await Send(client, id, AbilityText.ResumeChoiceOtherThings, "choice");

        Assert.Equal(new NextMove(MoveKind.AskOtherPartOfDay), ai.NextMoves[^1]);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 続きの問いに「とくに思い当たりません」を選ぶと、同じ行動を聞き直さない。書いた答えなら聞き直せる")]
    public async Task ResumeChoiceNoneDoesNotAskAgain()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");

        // 話し終えた場面を作り、最初の往復で利害調整力 3 を聞いた記録を外す（続きの問いで 1 回目に聞く形にする）
        async Task<string> ResumedOnce()
        {
            var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
            await factory.Services.GetRequiredService<IDataStore>().TryUpdateAsync<EpisodeItem>(
                TestUsers.Key("g-1"), id, e => e with { Turns = [.. e.Turns.Select(t => t with { Target = null })] }, Ct);
            var question = Array(await Json(await Resume(client, id)), "turns")[^1];
            Assert.Equal("balancing-interests.3", question.GetProperty("target").GetString());
            ai.Reading = _ => ReadingWith(BalancingInterestsAll[0], BalancingInterestsAll[1]);
            return id;
        }

        var chosen = await ResumedOnce();
        await Send(client, chosen, AbilityText.ResumeChoiceNone, "choice");

        Assert.Equal(new NextMove(MoveKind.AskWhatYouDid), ai.NextMoves[^1]);

        // 区切ってもう一度続きを開いても、同じ行動は聞き直さない（ほかに聞ける行動がないので、手がかりを添えない問いで始める）
        await Finish(client, chosen);
        var reopened = Array(await Json(await Resume(client, chosen)), "turns")[^1];
        Assert.True(!reopened.TryGetProperty("target", out var reopenedTarget) || reopenedTarget.ValueKind == JsonValueKind.Null);

        // 同じ言葉を書いた答えでは、いつもどおり 2 回まで聞く
        await Finish(client, chosen);
        var written = await ResumedOnce();
        await Send(client, written, AbilityText.ResumeChoiceNone);

        Assert.Equal(new NextMove(MoveKind.AskMissingAction, new ActionRef(TestAbilities.BalancingInterests, 3)), ai.NextMoves[^1]);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 続きの問いは、2 回聞いた行動を避けて、ほかの足りない行動を聞く")]
    public async Task ResumeSkipsActionsAskedTwice()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0]);
        var store = factory.Services.GetRequiredService<IDataStore>();
        await store.TryUpdateAsync<EpisodeItem>(TestUsers.Key("g-1"), id, e => e with
        {
            Turns =
            [
                .. e.Turns,
                new Turn { Role = TurnRoles.Assistant, Text = "1 回目", Target = "balancing-interests.2", Move = "askMissingAction", At = e.StartedAt },
                new Turn { Role = TurnRoles.User, Text = "覚えていません", AnswerKind = AnswerKind.Free, At = e.StartedAt },
                new Turn { Role = TurnRoles.Assistant, Text = "2 回目", Target = "balancing-interests.2", Move = "askMissingAction", At = e.StartedAt },
                new Turn { Role = TurnRoles.User, Text = "覚えていません", AnswerKind = AnswerKind.Free, At = e.StartedAt },
            ],
        }, Ct);

        var episode = await Json(await Resume(client, id));

        Assert.Equal("balancing-interests.3", Array(episode, "turns")[^1].GetProperty("target").GetString());
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 足りない行動をどれも 2 回聞いた場面は、手がかりを添えない問いで続ける")]
    public async Task ResumeWithoutHintWhenAllAskedTwice()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        var store = factory.Services.GetRequiredService<IDataStore>();
        await store.TryUpdateAsync<EpisodeItem>(TestUsers.Key("g-1"), id, e => e with
        {
            Turns =
            [
                .. e.Turns,
                new Turn { Role = TurnRoles.Assistant, Text = "1 回目", Target = "balancing-interests.3", Move = "askMissingAction", At = e.StartedAt },
                new Turn { Role = TurnRoles.User, Text = "覚えていません", AnswerKind = AnswerKind.Free, At = e.StartedAt },
                new Turn { Role = TurnRoles.Assistant, Text = "2 回目", Target = "balancing-interests.3", Move = "askMissingAction", At = e.StartedAt },
                new Turn { Role = TurnRoles.User, Text = "覚えていません", AnswerKind = AnswerKind.Free, At = e.StartedAt },
            ],
        }, Ct);

        var response = await Resume(client, id);

        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        var question = Array(await Json(response), "turns")[^1];
        Assert.Equal(AbilityText.ResumeOpening(null, "二人に電話して"), question.GetProperty("text").GetString());
        Assert.False(question.TryGetProperty("target", out _));
        Assert.Equal("resume", question.GetProperty("move").GetString());
    }

    [Fact(DisplayName = "validate-10（一般論には具体的な出来事を聞く）: 根拠が一般論だけの場面の続きは、「その日」を前提にせず、最近の一日を一つ聞く")]
    public async Task ResumeOnGeneralOnlyAsksForConcreteDay()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll.Select(c => c with { General = true }).ToArray());

        var question = Array(await Json(await Resume(client, id)), "turns")[^1];

        Assert.Equal(
            AbilityText.ResumeLead + "前に「二人に電話して」と話してくれましたね。特別な日でなくてかまいません。いつものことの中から、いちばん最近の一日のことを、聞かせてもらえますか？",
            question.GetProperty("text").GetString());
        Assert.DoesNotContain("その日", question.GetProperty("text").GetString(), StringComparison.Ordinal);
        Assert.Equal(AbilityText.ConcreteDayChoices, Array(question, "choices").Select(c => c.GetString()));
        Assert.False(question.TryGetProperty("target", out _));
    }

    [Fact(DisplayName = "validate-10（一般論には具体的な出来事を聞く）: 一般論だけの力と、出来事の中で足りない力があれば、出来事の中の足りない行動を聞く")]
    public async Task ResumePrefersConcreteAbilityOverGeneralOnly()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        // 利害調整力は一般論で 3 つ、優先順位設定力は出来事の中で 1 つ
        var id = await FinishedEpisode(client, ai,
            [.. BalancingInterestsAll.Select(c => c with { General = true }), Candidate(TestAbilities.SettingPriorities, 2, "迎えの時間をずらして")]);
        // 区切る前の最後の問いの行動は聞かないので、聞いた記録を外す
        await factory.Services.GetRequiredService<IDataStore>().TryUpdateAsync<EpisodeItem>(
            TestUsers.Key("g-1"), id, e => e with { Turns = [.. e.Turns.Select(t => t with { Target = null })] }, Ct);

        var question = Array(await Json(await Resume(client, id)), "turns")[^1];

        Assert.Equal("setting-priorities.1", question.GetProperty("target").GetString());
        Assert.Contains("前に「迎えの時間をずらして」と話してくれましたね。", question.GetProperty("text").GetString(), StringComparison.Ordinal);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの映し返しは、聞く力の根拠のうち、一般論でない、いちばん短い本人の言葉。選んだ答えなら結びついた言葉")]
    public void ResumeMirrorQuotePicksShortestOwnWords()
    {
        static EpisodeItem Episode(params Evidence[] evidence) => new()
        {
            Id = "episode-x",
            UserKey = "u",
            Type = EpisodeItem.ItemType,
            Status = EpisodeStatus.Finished,
            StartedAt = DateTimeOffset.UnixEpoch,
            Evidence = evidence,
        };
        static Evidence E(Ability ability, int action, string quote, bool general = false) => new(ability, action, quote, 1, 1, general, false, null);
        var coordinating3 = new ActionRef(TestAbilities.BalancingInterests, 3);

        // 聞く力（利害調整力）の根拠から選ぶ。ほかの力の、より短い言葉は使わない
        Assert.Equal("二人に電話して", EpisodeInsights.ResumeMirrorQuote(
            Episode(E(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって"), E(TestAbilities.BalancingInterests, 2, "二人に電話して"), E(TestAbilities.SettingPriorities, 1, "重なった")),
            coordinating3));

        // 選んだ答えの根拠なら、選んだ文ではなく、結びついた本人の言葉
        var chosen = new Evidence(TestAbilities.BalancingInterests, 1, "相手の都合を聞いた", 2, 1, false, true, "夫と母の予定がぶつかって");
        Assert.Equal("夫と母の予定がぶつかって", EpisodeInsights.ResumeMirrorQuote(Episode(chosen), coordinating3));

        // 聞く行動がなければ、要確認の力すべてから選ぶ。一般論の言葉は、短くても後にする
        Assert.Equal("夫と母の予定がぶつかって", EpisodeInsights.ResumeMirrorQuote(
            Episode(E(TestAbilities.NoticingChanges, 1, "いつも様子を見ています", general: true), E(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって")),
            null));
        Assert.Equal("いつも様子を見ています", EpisodeInsights.ResumeMirrorQuote(Episode(E(TestAbilities.NoticingChanges, 1, "いつも様子を見ています", general: true)), null));

        Assert.Null(EpisodeInsights.ResumeMirrorQuote(Episode(), null));
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 要確認がない場面、印のある場面、話している途中の場面は 409")]
    public async Task NotResumableIs409()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var store = factory.Services.GetRequiredService<IDataStore>();
        var confirmed = await FinishedEpisode(client, ai, BalancingInterestsAll);
        var nothing = await FinishedEpisode(client, ai);
        var excluded = await FinishedEpisode(client, ai, BalancingInterestsAll[0]);
        await store.TryUpdateAsync<EpisodeItem>(TestUsers.Key("g-1"), excluded, e => e with { ExcludedFromValidation = true }, Ct);
        var talking = await Start(client);
        var before = await StoredContent(store);
        Assert.Contains(before, j => j.Contains("\"type\":\"episode\"", StringComparison.Ordinal));

        var results = new[]
        {
            await Resume(client, confirmed),
            await Resume(client, nothing),
            await Resume(client, excluded),
            await Resume(client, talking),
        };

        Assert.All(results, r => Assert.Equal(HttpStatusCode.Conflict, r.StatusCode));
        Assert.Equal("/problems/episode-finished", (await Json(results[0])).GetProperty("type").GetString());
        Assert.Equal("/problems/episode-finished", (await Json(results[1])).GetProperty("type").GetString());
        Assert.Equal("/problems/episode-excluded", (await Json(results[2])).GetProperty("type").GetString());
        var inProgress = await Json(results[3]);
        Assert.Equal("/problems/episode-in-progress", inProgress.GetProperty("type").GetString());
        Assert.Equal(talking, inProgress.GetProperty("episodeId").GetString());
        Assert.Equal(before, await StoredContent(store));
        Assert.Equal(HttpStatusCode.NotFound, (await Resume(client, "episode-none")).StatusCode);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: ほかに話している途中の場面があれば 409 とその id")]
    public async Task OtherTalkingEpisodeIs409()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var partial = await FinishedEpisode(client, ai, BalancingInterestsAll[0]);
        var talking = await Start(client);

        var response = await Resume(client, partial);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        var problem = await Json(response);
        Assert.Equal("/problems/episode-in-progress", problem.GetProperty("type").GetString());
        Assert.Equal(talking, problem.GetProperty("episodeId").GetString());
        var saved = await Saved(factory, "g-1", partial);
        Assert.Equal(EpisodeStatus.Finished, saved.Status);
        Assert.Equal(3, saved.Turns.Count);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きを話すのと同時にほかの画面で新しい場面を始めても、途中の場面は 1 つ")]
    public async Task ResumeRaceKeepsOneTalkingEpisode()
    {
        var (factory, ai) = Create(interrupting: true);
        await using var _f = factory;
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var partial = await FinishedEpisode(client, ai, BalancingInterestsAll[0]);
        var before = await Saved(factory, "g-1", partial);

        // 印を読んだあと、続ける場面を書き換える直前に、ほかの画面で「話す」を押す
        HttpResponseMessage? other = null;
        store.RunOnceBeforeWriting(partial, async () => other = await client.PostAsync("/api/episodes", null, Ct));

        var response = await Resume(client, partial);

        Assert.Equal(HttpStatusCode.Created, other!.StatusCode);
        var otherId = (await Json(other)).GetProperty("id").GetString();
        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(otherId, (await Json(response)).GetProperty("episodeId").GetString());

        var saved = await Saved(factory, "g-1", partial);
        Assert.Equal(EpisodeStatus.Finished, saved.Status);
        Assert.Equal(before.FinishedAt, saved.FinishedAt);
        Assert.Equal(before.TurnLimit, saved.TurnLimit);
        Assert.Equal(before.Turns.Count, saved.Turns.Count);
        var talking = (await store.ListByTypeAsync<EpisodeItem>(TestUsers.Key("g-1"), EpisodeItem.ItemType, Ct))
            .Where(e => e.Status == EpisodeStatus.Talking)
            .Select(e => e.Id);
        Assert.Equal([otherId], talking);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きを話している場面を飛ばすと、続きで足したやりとりと根拠だけを残さず、話し終えた姿に戻す")]
    public async Task SkipAfterResumeKeepsFinishedPart()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        var before = await Saved(factory, "g-1", id);
        var beforeInsights = (await GetEpisode(client, id)).GetProperty("insights").GetRawText();

        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);
        ai.Reading = _ => ReadingWith(BalancingInterestsAll[0], BalancingInterestsAll[1], Candidate(TestAbilities.NoticingChanges, 1, "いつもと違う", answer: 2));
        await Send(client, id, "その朝は、子どもの様子がいつもと違うと思いました");

        var skip = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);

        Assert.Equal(HttpStatusCode.Created, skip.StatusCode);
        Assert.NotEqual(id, (await Json(skip)).GetProperty("id").GetString());
        var after = await Saved(factory, "g-1", id);
        Assert.Equal(EpisodeStatus.Finished, after.Status);
        Assert.Equal(before.FinishedAt, after.FinishedAt);
        Assert.Equal(before.TurnLimit, after.TurnLimit);
        Assert.Equal(before.Turns.Select(t => (t.Role, t.Text, t.Move)), after.Turns.Select(t => (t.Role, t.Text, t.Move)));
        Assert.Equal(before.Evidence, after.Evidence);
        Assert.Null(after.BeforeResume);
        Assert.False(after.ExcludedFromValidation);
        Assert.Equal(beforeInsights, (await GetEpisode(client, id)).GetProperty("insights").GetRawText());

        // 見えた力も続きを話す前に戻る。前に話し終えていた利害調整力は下がらない
        var abilities = await client.GetFromJsonAsync<JsonElement>("/api/abilities", Ct);
        var life = Array(abilities, "abilities").ToDictionary(a => a.GetProperty("key").GetString()!, a => a.GetProperty("life").GetString());
        Assert.Equal("needsCheck", life["balancing-interests"]);
        Assert.Equal("notYet", life["noticing-changes"]);
        Assert.DoesNotContain(
            Array(abilities, "history"),
            h => h.GetProperty("key").GetString() == "balancing-interests" && h.GetProperty("reason").GetString() == "skip");
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きを話すと押してすぐ飛ばしても、話し終えていた場面と見えた力は残る")]
    public async Task SkipRightAfterResumeKeepsEpisode()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0], BalancingInterestsAll[1]);
        Assert.Equal(3, (await Saved(factory, "g-1", id)).Turns.Count);

        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await client.PostAsync($"/api/episodes/{id}/skip", null, Ct)).StatusCode);

        var episode = await GetEpisode(client, id);
        Assert.Equal("finished", episode.GetProperty("status").GetString());
        Assert.Equal(3, Array(episode, "turns").Length);
        Assert.Equal("balancing-interests", Assert.Single(Array(episode.GetProperty("insights"), "moreToHear")).GetProperty("key").GetString());
        var history = Array(await client.GetFromJsonAsync<JsonElement>("/api/abilities", Ct), "history");
        Assert.Equal(
            [("balancing-interests", "notYet", "needsCheck", "talk")],
            history.Select(h => (
                h.GetProperty("key").GetString(), h.GetProperty("from").GetString(), h.GetProperty("to").GetString(), h.GetProperty("reason").GetString())));
    }

    [Fact(DisplayName = "discover-10（つらい状態のサインに応える）: 続きでつらい状態のサインが出た場面を飛ばすと、続きは残さず、力の確かめに使わない印は残し、つらい状態のサインのあとの入口と同じ問いで始める")]
    public async Task SkipAfterResumeWithDistressKeepsMark()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, BalancingInterestsAll[0]);
        var before = await Saved(factory, "g-1", id);

        Assert.Equal(HttpStatusCode.OK, (await Resume(client, id)).StatusCode);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, []);
        await Send(client, id, "最近ずっと眠れなくて、つらいです");

        var skip = await client.PostAsync($"/api/episodes/{id}/skip", null, Ct);
        Assert.Equal(HttpStatusCode.Created, skip.StatusCode);

        // 続きの中でサインが出た場面を飛ばしたあとも、つらい状態のサインのあとの入口と同じ問いで始める（discover-5（つらい話は飛ばせる））
        var next = (await Json(skip)).GetProperty("turns")[0];
        Assert.Equal(DiscoverText.OpeningAfterDistress, next.GetProperty("text").GetString());
        Assert.Equal(DiscoverText.OpeningAfterDistressChoices, next.GetProperty("choices").EnumerateArray().Select(c => c.GetString()!).ToArray());

        var after = await Saved(factory, "g-1", id);
        Assert.Equal(EpisodeStatus.Finished, after.Status);
        Assert.Equal(before.Turns.Count, after.Turns.Count);
        Assert.DoesNotContain(after.Turns, t => t.Text.Contains("眠れなくて", StringComparison.Ordinal));
        Assert.True(after.ExcludedFromValidation);
        Assert.Equal(JsonValueKind.Null, (await GetEpisode(client, id)).GetProperty("insights").ValueKind);

        // 場面は残る（確かめには使わない）ので、確かめに使わないことにした履歴も残す。場面ごと消したときだけ外す
        var history = Array(await client.GetFromJsonAsync<JsonElement>("/api/abilities", Ct), "history");
        Assert.Contains(history, h => h.GetProperty("reason").GetString() == "setAside" && h.GetProperty("episodeId").GetString() == id);
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 印を書き換える直前にほかの画面で印が変わったら、続けた場面を話し終えた状態に戻す")]
    public async Task ResumeRevertsWhenMarkChanged()
    {
        var (factory, ai) = Create(interrupting: true);
        await using var _f = factory;
        var store = (InterruptingDataStore)factory.Services.GetRequiredService<IDataStore>();
        var client = await Consenting(factory, "g-1");
        var partial = await FinishedEpisode(client, ai, BalancingInterestsAll[0]);
        var before = await Saved(factory, "g-1", partial);
        var key = TestUsers.Key("g-1");

        // 印を書き換える直前に、ほかの要求が新しい場面と印を書いた（中の保存先に直接書く）
        var otherId = EpisodeItem.NewId();
        store.RunOnceBeforeWriting(TalkingMarkItem.ItemId, async inner =>
        {
            await inner.UpsertAsync(EpisodeItem.Start(key, factory.Clock.GetUtcNow(), DiscoverText.Opening, DiscoverText.OpeningChoices, "opening") with { Id = otherId }, Ct);
            await inner.UpsertAsync(new TalkingMarkItem { Id = TalkingMarkItem.ItemId, UserKey = key, Type = TalkingMarkItem.ItemType, EpisodeId = otherId }, Ct);
        });

        var response = await Resume(client, partial);

        Assert.Equal(HttpStatusCode.Conflict, response.StatusCode);
        Assert.Equal(otherId, (await Json(response)).GetProperty("episodeId").GetString());
        var saved = await Saved(factory, "g-1", partial);
        Assert.Equal(EpisodeStatus.Finished, saved.Status);
        Assert.Equal(before.FinishedAt, saved.FinishedAt);
        Assert.Equal(before.TurnLimit, saved.TurnLimit);
        Assert.Equal(before.Turns.Count, saved.Turns.Count);
    }
}
