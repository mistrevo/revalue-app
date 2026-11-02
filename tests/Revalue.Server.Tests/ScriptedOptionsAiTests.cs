using Microsoft.Extensions.DependencyInjection;
using Revalue.Server.Ai;
using Revalue.Server.Features.Foundation;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class ScriptedOptionsAiTests
{
    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly DateTimeOffset Now = DateTimeOffset.Parse("2026-11-03T03:00:00Z");
    private static readonly JobCatalog Catalog = JobCatalog.Load();
    private static readonly ForbiddenWordList Forbidden = ForbiddenWordList.Load();

    private static Evidence E(Ability ability, int action, string quote) => new(ability, action, quote, 1, 1, false, false, null);

    private static OptionsInputs Inputs(int hours = 10, Place place = Place.HomeOnly, TimeSlot[]? slots = null, Ability ability = Ability.Coordinating) =>
        new(
            new ProfileConditions(slots ?? [TimeSlot.Evening, TimeSlot.Daytime], hours, place, null),
            true,
            [new UsableAbility(ability, AbilityState.NeedsCheck, [E(ability, 1, "架空-夫と母の予定がぶつかって"), E(ability, 2, "架空-班の 2 家族に連絡しました")])],
            [],
            [],
            [],
            null);

    [Theory(DisplayName = "options-1（3 枚を同じ重さで示す）: 偽物の答えは、照らし合わせを通る 3 枚になる")]
    [InlineData(Ability.Coordinating)]
    [InlineData(Ability.Noticing)]
    [InlineData(Ability.Prioritizing)]
    public async Task ScriptedDraftPassesValidation(Ability ability)
    {
        var inputs = Inputs(ability: ability);
        var candidates = OptionCandidates.From(Catalog, inputs);
        Assert.True(candidates.CanCombine);

        var draft = await new ScriptedOptionsAi().DraftAsync(inputs, candidates, Ct);
        var (cards, rejections) = OptionsValidator.Build(draft, candidates, inputs, Catalog, Forbidden, Now);

        Assert.Empty(rejections);
        Assert.Empty(cards.Missing);
        Assert.NotNull(cards.Choose);
        Assert.NotNull(cards.Combine);
        Assert.NotNull(cards.Create);
        Assert.Equal(ability, cards.Choose.Ability.Ability);
        Assert.Equal(["架空-夫と母の予定がぶつかって"], cards.Create.Ability.Quotes.Select(q => q.Quote));
        Assert.Equal(10, cards.Create.HoursPerWeek);
        Assert.Equal([TimeSlot.Daytime], cards.Create.TimeSlots);
        Assert.Contains("「架空-夫と母の予定がぶつかって」", cards.Choose.Reason);
    }

    [Fact(DisplayName = "options-4（創るは根拠を引けるときだけ）: 偽物は、候補で作れないカードを作らないと答え、創るは本人の条件の中で作る")]
    public async Task ScriptedDraftRespectsCandidates()
    {
        // 週 1 時間、夜だけ: 条件に合う業務がない
        var inputs = Inputs(hours: 1, slots: [TimeSlot.Night]);
        var candidates = OptionCandidates.From(Catalog, inputs);

        var draft = await new ScriptedOptionsAi().DraftAsync(inputs, candidates, Ct);
        var (cards, rejections) = OptionsValidator.Build(draft, candidates, inputs, Catalog, Forbidden, Now);

        Assert.False(draft.Choose.Made);
        Assert.False(draft.Combine.Made);
        Assert.Empty(rejections);
        Assert.Equal(
            [new MissingCard(CardKind.Choose, MissingReason.NoFit), new MissingCard(CardKind.Combine, MissingReason.NoFit)],
            cards.Missing);
        Assert.Equal((1, TaskPlace.Home), (cards.Create!.HoursPerWeek, cards.Create.Place));
        Assert.Equal([TimeSlot.Night], cards.Create.TimeSlots);
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: Testing では鍵があっても、仕事の選択肢の AI は偽物を使う")]
    public async Task TestingUsesScriptedOptionsAi()
    {
        await using var factory = new RevalueFactory().WithSetting("ANTHROPIC_API_KEY", "placeholder-for-tests");

        Assert.IsType<ScriptedOptionsAi>(factory.Services.GetRequiredService<IOptionsAi>());
    }

    [Fact(DisplayName = "options-2（選ぶは登録した職種から）: 本番で鍵があれば、仕事の選択肢の AI も本物の Claude を使う")]
    public async Task ProductionUsesClaudeOptionsAi()
    {
        await using var factory = new RevalueFactory()
            .WithEnvironment("Production")
            .WithSetting("Cosmos:Endpoint", "https://example.com:443/")
            .WithSetting("ANTHROPIC_API_KEY", "placeholder-for-tests")
            .WithSetting("Claude:Model", "claude-test-model");

        var ai = Assert.IsType<ClaudeOptionsAi>(factory.Services.GetRequiredService<IOptionsAi>());
        Assert.Equal("claude-test-model", ai.Model);
    }
}
