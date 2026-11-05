using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;
using static Revalue.Server.Tests.DeepenTestKit;

namespace Revalue.Server.Tests;

public sealed class ScriptedDeepenAiTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly ForbiddenWordList Forbidden = ForbiddenWordList.Load();

    public static TheoryData<string> Kinds => ["choose", "combine", "create", "own"];

    private static OptionsItem OptionsOf(string kind) => kind switch
    {
        "choose" => Options(ChooseChoice()),
        "combine" => Options(CombineChoice()),
        "create" => Options(CreateChoice()),
        _ => OwnOptions(),
    };

    [Theory(DisplayName = "deepen-3（最初の一歩は小さく）: 偽物の答えは、どの種類でも照らし合わせを通る")]
    [MemberData(nameof(Kinds))]
    public async Task ScriptedDraftPassesValidation(string kind)
    {
        // いちばんきつい条件: 週 1 時間、夜だけ、家だけ
        var conditions = Conditions(hours: 1, place: Place.HomeOnly, slots: [TimeSlot.Night]);
        var target = Target(OptionsOf(kind), conditions);

        var draft = await new ScriptedDeepenAi().DraftAsync(target, Inputs(conditions), Ct);
        var (content, rejections) = DeepenValidator.Build(draft, target, conditions, Forbidden, Now);

        Assert.Empty(rejections);
        Assert.False(content.StepsFallback);
        Assert.False(content.TasksRejected);
        Assert.Equal(["s1", "s2", "s3"], content.Steps.Select(s => s.Id));
        Assert.Equal(target.Kind == TargetKind.Create ? 1 : 0, content.Steps.Count(s => s.DemandCheck));
        Assert.Equal(target.Drafts ? 2 : 0, content.Tasks.Count);
        var question = Assert.Single(content.Questions);
        Assert.Equal(target.Drafts ? TestAbilities.BalancingInterests : target.Registered[0].ActiveAbilities[0], question.Ability);
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: Testing の環境では、深める AI も偽物になる")]
    public async Task TestingUsesScriptedDeepenAi()
    {
        await using var factory = new RevalueFactory().WithSetting("ANTHROPIC_API_KEY", "placeholder-for-tests");

        Assert.IsType<ScriptedDeepenAi>(factory.Services.GetRequiredService<IDeepenAi>());
    }

    [Fact(DisplayName = "deepen-6（仮の場面での考え方を聞く）: 本番で鍵があれば、深める AI も本物の Claude を使う")]
    public async Task ProductionUsesClaudeDeepenAi()
    {
        await using var factory = new RevalueFactory()
            .WithEnvironment("Production")
            .WithSetting("Cosmos:Endpoint", "https://example.com:443/")
            .WithSetting("ANTHROPIC_API_KEY", "placeholder-for-tests")
            .WithSetting("Claude:Model", "claude-test-model");

        var ai = Assert.IsType<ClaudeDeepenAi>(factory.Services.GetRequiredService<IDeepenAi>());
        Assert.Equal("claude-test-model", ai.Model);
    }
}
