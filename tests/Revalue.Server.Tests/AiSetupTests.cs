using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class AiSetupTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DateTimeOffset At = DateTimeOffset.Parse("2026-11-03T03:00:00Z");

    private static IReadOnlyList<Turn> Answer(string text) =>
    [
        new Turn { Role = TurnRoles.Assistant, Text = DiscoverText.Opening, Choices = DiscoverText.OpeningChoices, At = At },
        new Turn { Role = TurnRoles.User, Text = text, AnswerKind = AnswerKind.Free, At = At },
    ];

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: Testing では鍵がなくても偽物の AI で動く")]
    public async Task TestingWithoutKeyUsesScripted()
    {
        await using var factory = new RevalueFactory().WithSetting("ANTHROPIC_API_KEY", "");

        Assert.IsType<ScriptedConversationAi>(factory.Services.GetRequiredService<IConversationAi>());
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: Testing では鍵があっても本物の Claude を呼ばない")]
    public async Task TestingWithKeyStillUsesScripted()
    {
        await using var factory = new RevalueFactory().WithSetting("ANTHROPIC_API_KEY", "placeholder-for-tests");

        Assert.IsType<ScriptedConversationAi>(factory.Services.GetRequiredService<IConversationAi>());
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 本番で鍵があれば本物の Claude を使い、モデルは設定から読む")]
    public async Task ProductionWithKeyUsesClaude()
    {
        await using var factory = new RevalueFactory()
            .WithEnvironment("Production")
            .WithSetting("Cosmos:Endpoint", "https://example.com:443/")
            .WithSetting("ANTHROPIC_API_KEY", "placeholder-for-tests")
            .WithSetting("Claude:Model", "claude-test-model");

        var ai = Assert.IsType<ClaudeConversationAi>(factory.Services.GetRequiredService<IConversationAi>());
        Assert.Equal("claude-test-model", ai.Model);
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: 本番で鍵がなければ起動しない")]
    public async Task ProductionWithoutKeyDoesNotStart()
    {
        await using var factory = new RevalueFactory()
            .WithEnvironment("Production")
            .WithSetting("Cosmos:Endpoint", "https://example.com:443/")
            .WithSetting("ANTHROPIC_API_KEY", "");

        var error = Assert.ThrowsAny<Exception>(() => factory.CreateClient());
        Assert.Contains("ANTHROPIC_API_KEY", error.ToString());
    }

    [Fact(DisplayName = "discover-2（受け止めてから一つだけ聞く）: モデルの既定は claude-opus-5-5")]
    public void DefaultModel() => Assert.Equal("claude-opus-5-5", new ClaudeOptions().Model);

    [Theory(DisplayName = "discover-10（つらい状態のサインに応える）: 偽物の AI は目印語でサインを返す")]
    [InlineData("もう死にたいと思うことがある", AnswerSignal.Distress)]
    [InlineData("毎日つらくて眠れない", AnswerSignal.Distress)]
    [InlineData("分からない", AnswerSignal.DontKnow)]
    [InlineData("私には何もない", AnswerSignal.DontKnow)]
    [InlineData("子どもが熱を出して病院へ連れて行った", AnswerSignal.FamilyIllness)]
    [InlineData("昨日は朝から買い物に行った", AnswerSignal.ConcreteEvent)]
    public async Task ScriptedReadsMarkers(string answer, AnswerSignal expected)
    {
        var reading = await new ScriptedConversationAi().ReadAsync(Answer(answer), Ct);

        Assert.Contains(expected, reading.Signals);
    }

    [Fact(DisplayName = "discover-7（返答が少しずつ流れる）: 偽物の AI は返事を数かけらに分け、区切りの行と選択肢 3 つを付ける")]
    public async Task ScriptedReplyHasChoices()
    {
        var ai = new ScriptedConversationAi();
        var splitter = new ReplyStreamSplitter();
        var chunks = 0;
        await foreach (var chunk in ai.StreamReplyAsync(Answer("昨日は朝から買い物に行った"), new NextMove(MoveKind.AskWhatYouDid), Ct))
        {
            chunks++;
            splitter.Push(chunk);
        }

        var parts = splitter.Complete();
        Assert.True(chunks >= 3);
        Assert.False(parts.UsedFallback);
        Assert.Equal(3, parts.Choices.Count);
        Assert.NotEmpty(parts.Body);
    }

    [Fact(DisplayName = "discover-6（一場面ずつ区切り、続きから話せる）: 偽物の AI の締めの返事には区切りも選択肢もない")]
    public async Task ScriptedCloseHasNoChoices()
    {
        var text = "";
        await foreach (var chunk in new ScriptedConversationAi().StreamReplyAsync(Answer("昨日は朝から買い物に行った"), new NextMove(MoveKind.Close), Ct))
        {
            text += chunk;
        }

        Assert.DoesNotContain(ReplyStreamSplitter.Delimiter, text);
        Assert.DoesNotContain("？", text);
    }

    [Fact(DisplayName = "validate-7（見えた力と、もう少し聞きたいことを示す）: 偽物の AI は、行動の目印の言葉があれば答えの文全体を引用にした候補を返し、選んだ答えには返さない")]
    public async Task ScriptedReturnsCandidates()
    {
        const string text = "朝、用事が三つ重なったので、病院を先にしました。";
        var reading = await new ScriptedConversationAi().ReadAsync(Answer(text), Ct);

        Assert.Equal(
            [new ActionRef(Ability.Prioritizing, 1), new ActionRef(Ability.Prioritizing, 2), new ActionRef(Ability.Prioritizing, 3)],
            reading.Candidates!.Select(c => new ActionRef(c.Ability, c.Action)));
        Assert.All(reading.Candidates!, c =>
        {
            Assert.Equal(text, c.Quote);
            Assert.Equal(1, c.Answer);
            Assert.Equal(1, c.Event);
            Assert.False(c.General);
        });

        IReadOnlyList<Turn> chosen = [.. Answer("昨日のこと"), new Turn { Role = TurnRoles.User, Text = "用事が重なった", AnswerKind = AnswerKind.Choice, At = At }];
        Assert.Empty((await new ScriptedConversationAi().ReadAsync(chosen, Ct)).Candidates!);
    }

    [Fact(DisplayName = "validate-2（足りない行動だけ聞き返す）: 偽物の AI の、足りない行動を聞く返事には手がかりが出る")]
    public async Task ScriptedAskMissingActionShowsHint()
    {
        var target = new ActionRef(Ability.Prioritizing, 3);
        var splitter = new ReplyStreamSplitter();
        await foreach (var chunk in new ScriptedConversationAi().StreamReplyAsync(Answer("用事が重なった"), new NextMove(MoveKind.AskMissingAction, target), Ct))
        {
            splitter.Push(chunk);
        }

        var parts = splitter.Complete();
        Assert.Contains(AbilityText.Hint(target), parts.Body);
        Assert.Equal(3, parts.Choices.Count);
    }
}
