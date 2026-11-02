using System.Net.Http.Json;
using System.Text.Json;
using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.ValidateTestKit;

namespace Revalue.Server.Tests;

public sealed class InsightsTests
{
    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 話し終えた場面に、見えた力と根拠、もう少し聞かせてほしいこと（手がかり）、まだ聞けていない力が入る")]
    public async Task FinishedEpisodeHasInsights()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, [.. CoordinatingAll, Candidate(Ability.Prioritizing, 2, "迎えの時間をずらして")]);

        var insights = (await GetEpisode(client, id)).GetProperty("insights");

        var seen = Assert.Single(Array(insights, "seen"));
        Assert.Equal("coordinating", seen.GetProperty("key").GetString());
        Assert.Equal("調整する力", seen.GetProperty("name").GetString());
        Assert.Equal(
            ["夫と母の予定がぶつかって", "二人に電話して", "迎えの時間をずらしてもらいました"],
            Array(seen, "quotes").Select(q => q.GetProperty("text").GetString()));

        var more = Assert.Single(Array(insights, "moreToHear"));
        Assert.Equal("prioritizing", more.GetProperty("key").GetString());
        Assert.Equal("優先順位をつける力", more.GetProperty("name").GetString());
        Assert.Equal(["迎えの時間をずらして"], Array(more, "quotes").Select(q => q.GetProperty("text").GetString()));
        Assert.Equal(
            [AbilityText.Hint(new ActionRef(Ability.Prioritizing, 1)), AbilityText.Hint(new ActionRef(Ability.Prioritizing, 3))],
            Array(more, "hints").Select(h => h.GetString()));

        var notYet = Assert.Single(Array(insights, "notYet"));
        Assert.Equal("noticing", notYet.GetProperty("key").GetString());
        Assert.Equal("見立てる力", notYet.GetProperty("name").GetString());
        Assert.True(insights.GetProperty("canResume").GetBoolean());
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 読み取りが 3 つの行動に 1 文字の引用を返しても、根拠ありにしない")]
    public async Task OneLetterQuotesDoNotConfirm()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai,
            Candidate(Ability.Prioritizing, 1, "て"), Candidate(Ability.Prioritizing, 2, "て"), Candidate(Ability.Prioritizing, 3, "て"));

        var insights = (await GetEpisode(client, id)).GetProperty("insights");

        Assert.Empty(Array(insights, "seen"));
        Assert.Empty(Array(insights, "moreToHear"));
        Assert.Contains(Array(insights, "notYet"), a => a.GetProperty("key").GetString() == "prioritizing");
        Assert.Empty((await Saved(factory, "g-1", id)).Evidence);
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 話している途中と、力の確かめに使わない印のある場面には見えたことを入れない")]
    public async Task NoInsightsWhileTalkingOrExcluded()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll);
        await Send(client, id, CoordinatingAnswer);

        Assert.Equal(JsonValueKind.Null, (await GetEpisode(client, id)).GetProperty("insights").ValueKind);

        await Finish(client, id);
        var store = factory.Services.GetRequiredService<IDataStore>();
        await store.TryUpdateAsync<EpisodeItem>(TestUsers.Key("g-1"), id, e => e with { ExcludedFromValidation = true }, Ct);

        Assert.Equal(JsonValueKind.Null, (await GetEpisode(client, id)).GetProperty("insights").ValueKind);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: つらい状態のサインが出た場面では、続けて話しても足りない行動を聞かず、根拠も足さない")]
    public async Task SetAsideEpisodeDoesNotAskMissingActionsOrAddEvidence()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => new TurnReading(new HashSet<AnswerSignal> { AnswerSignal.Distress }, []);
        await Send(client, id, "毎日がしんどくて、何もかも嫌になってしまいました。");
        Assert.True((await Saved(factory, "g-1", id)).ExcludedFromValidation);

        // 「続けて話す」で次の答えを送る。読み取りが根拠の候補を返しても、確かめのための問いは出さず、根拠も保存しない
        ai.Reading = _ => ReadingWith(CoordinatingAll[0]);
        await Send(client, id, CoordinatingAnswer);

        Assert.Equal(MoveKind.AskWhatYouDid, ai.Moves[^1]);
        Assert.Null(ai.NextMoves[^1].Target);
        Assert.Empty((await Saved(factory, "g-1", id)).Evidence);
    }

    [Fact(DisplayName = "validate-10（一般論には具体的な出来事を聞く）: 根拠が一般論だけの力には、足りない行動ではなく、最近の一日を一つ聞く手がかりを出す")]
    public async Task GeneralOnlyAbilityHintAsksForConcreteDay()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await FinishedEpisode(client, ai, CoordinatingAll.Select(c => c with { General = true }).ToArray());

        var more = Assert.Single(Array((await GetEpisode(client, id)).GetProperty("insights"), "moreToHear"));

        Assert.Equal([AbilityText.ConcreteDayHint], Array(more, "hints").Select(h => h.GetString()));
    }

    [Fact(DisplayName = "validate-4（根拠は本人の言葉）: 選んだ答えの根拠は fromChoice と、結びついた本人の言葉を持つ")]
    public async Task ChoiceEvidenceHasLinkedText()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        ai.Reading = _ => ReadingWith(CoordinatingAll[0]);
        await Send(client, id, CoordinatingAnswer);
        ai.Reading = _ => ReadingWith(
            CoordinatingAll[0],
            new EvidenceCandidate(Ability.Coordinating, 2, "人に頼んだ", 2, 1, false, "二人に電話して", 1));
        await Send(client, id, "人に頼んだ", "choice");
        await Finish(client, id);

        var more = Assert.Single(Array((await GetEpisode(client, id)).GetProperty("insights"), "moreToHear"));
        var quotes = Array(more, "quotes");
        Assert.Equal(2, quotes.Length);
        Assert.False(quotes[0].GetProperty("fromChoice").GetBoolean());
        Assert.Equal(JsonValueKind.Null, quotes[0].GetProperty("linkedText").ValueKind);
        Assert.Equal("人に頼んだ", quotes[1].GetProperty("text").GetString());
        Assert.True(quotes[1].GetProperty("fromChoice").GetBoolean());
        Assert.Equal("二人に電話して", quotes[1].GetProperty("linkedText").GetString());
    }

    [Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 一覧の canResume は、要確認の力がある話し終えた場面だけ true")]
    public async Task ListHasCanResume()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var confirmed = await FinishedEpisode(client, ai, CoordinatingAll);
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var partial = await FinishedEpisode(client, ai, CoordinatingAll[0]);
        factory.Clock.Advance(TimeSpan.FromMinutes(1));
        var talking = await Start(client);

        var list = await client.GetFromJsonAsync<JsonElement[]>("/api/episodes", Ct);

        var canResume = list!.ToDictionary(e => e.GetProperty("id").GetString()!, e => e.GetProperty("canResume").GetBoolean());
        Assert.Equal(new Dictionary<string, bool> { [confirmed] = false, [partial] = true, [talking] = false }, canResume);
    }

    [Fact(DisplayName = "validate-1（3 つともそろったときだけ根拠あり）: 読み取りが出来事の番号を振り直しても、別の日の行動を同じ出来事としてそろえない")]
    public async Task RenumberedEventsDoNotCombineAcrossDays()
    {
        var (factory, ai) = Create();
        await using var _f = factory;
        var client = await Consenting(factory, "g-1");
        var id = await Start(client);
        const string monday = "月曜は、通院の付き添いと、学校の面談と、町内会の集まりが重なっていました。";
        const string thursday = "木曜は、先に買い物をすませて、洗濯は後回しにしました。雨が降りそうだったので。";

        // どの回の読み取りも、その回の中では月曜と木曜を正しく分けている。3 回目だけ月曜を候補から外し、木曜を出来事 1 と振り直す
        ai.Reading = turns => turns.Count(t => t.Role == TurnRoles.User) switch
        {
            1 => ReadingWith(At(1, "通院の付き添いと、学校の面談と、町内会の集まりが重なっていました", answer: 1, @event: 1)),
            2 => ReadingWith(
                At(1, "通院の付き添いと、学校の面談と、町内会の集まりが重なっていました", answer: 1, @event: 1),
                At(2, "先に買い物をすませて、洗濯は後回しにしました", answer: 2, @event: 2),
                At(3, "雨が降りそうだったので", answer: 2, @event: 2)),
            _ => ReadingWith(
                At(2, "先に買い物をすませて", answer: 2, @event: 1),
                At(3, "雨が降りそうだった", answer: 2, @event: 1)),
        };
        await Send(client, id, monday);
        await Send(client, id, thursday);
        await Send(client, id, "少し覚えています", "choice");
        await Finish(client, id);

        var insights = (await GetEpisode(client, id)).GetProperty("insights");
        Assert.Empty(Array(insights, "seen"));
        var more = Assert.Single(Array(insights, "moreToHear"));
        Assert.Equal("prioritizing", more.GetProperty("key").GetString());
        Assert.Equal([AbilityText.Hint(new ActionRef(Ability.Prioritizing, 1))], Array(more, "hints").Select(h => h.GetString()));
        Assert.Equal(AbilityState.NeedsCheck, AbilityStates.Evaluate((await Saved(factory, "g-1", id)).Evidence).Single(r => r.Ability == Ability.Prioritizing).State);

        var abilities = await client.GetFromJsonAsync<JsonElement>("/api/abilities", Ct);
        var prioritizing = Array(abilities, "abilities").Single(a => a.GetProperty("key").GetString() == "prioritizing");
        Assert.Equal("needsCheck", prioritizing.GetProperty("life").GetString());

        static EvidenceCandidate At(int action, string quote, int answer, int @event) =>
            new(Ability.Prioritizing, action, quote, answer, @event, false, "", 0);
    }
}
