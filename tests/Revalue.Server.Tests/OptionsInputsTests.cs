using Microsoft.Extensions.Time.Testing;
using Revalue.Server.Data;
using Revalue.Server.Features.Discover;
using Revalue.Server.Features.Foundation.Consent;
using Revalue.Server.Features.Options;
using Revalue.Server.Features.Profile;
using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

public sealed class OptionsInputsTests
{
    private const string User = "u_options";

    private static CancellationToken Ct => TestContext.Current.CancellationToken;

    private static readonly ProfileConditions Conditions = new([TimeSlot.Daytime, TimeSlot.Evening], 10, Place.HomeOnly, 5);
    private static readonly JobCatalog Catalog = JobCatalog.Load();

    private static async Task<(InMemoryDataStore Store, FakeTimeProvider Clock)> Create()
    {
        var clock = new FakeTimeProvider(DateTimeOffset.Parse("2026-11-03T03:00:00Z"));
        var store = new InMemoryDataStore(clock);
        await store.UpsertAsync(new ConsentItem
        {
            Id = ConsentItem.ItemId,
            UserKey = User,
            Type = ConsentItem.ItemType,
            Version = ConsentInfo.CurrentVersion,
            At = clock.GetUtcNow(),
        }, Ct);
        return (store, clock);
    }

    private static Evidence E(Ability ability, int action, string quote) => new(ability, action, quote, 1, 1, false, false, null);

    private static readonly Evidence[] BalancingInterestsAll =
    [
        E(TestAbilities.BalancingInterests, 1, "夫と母の予定がぶつかって"),
        E(TestAbilities.BalancingInterests, 2, "二人に電話しました"),
        E(TestAbilities.BalancingInterests, 3, "迎えの時間をずらしてもらいました"),
    ];

    private static async Task SaveEpisode(IDataStore store, DateTimeOffset at, IReadOnlyList<Evidence> evidence, string status = EpisodeStatus.Finished) =>
        await store.UpsertAsync(new EpisodeItem
        {
            Id = EpisodeItem.NewId(),
            UserKey = User,
            Type = EpisodeItem.ItemType,
            Status = status,
            StartedAt = at,
            FinishedAt = status == EpisodeStatus.Finished ? at.AddMinutes(10) : null,
            Turns =
            [
                new Turn { Role = TurnRoles.Assistant, Text = "最近の一日を教えてください。", At = at },
                new Turn { Role = TurnRoles.User, Text = string.Concat(evidence.Select(e => e.Quote + "。")), AnswerKind = AnswerKind.Free, At = at },
            ],
            Evidence = evidence,
        }, Ct);

    [Fact(DisplayName = "options-7（1 場面で進める）: 条件、話し終えた場面、使える力の順に、足りないものを返す")]
    public async Task ReportsWhatIsMissingInOrder()
    {
        var (store, clock) = await Create();

        var none = await OptionsInputsReader.ReadAsync(store, User, Ct);
        Assert.Equal(Readiness.NeedsConditions, OptionsInputsReader.Check(none));

        await ProfileStore.UpdateAsync(store, User, p => p with { Conditions = Conditions }, clock, Ct);
        var noEpisode = await OptionsInputsReader.ReadAsync(store, User, Ct);
        Assert.Equal(Readiness.NeedsFinishedEpisode, OptionsInputsReader.Check(noEpisode));

        await SaveEpisode(store, clock.GetUtcNow(), []);
        var noAbility = await OptionsInputsReader.ReadAsync(store, User, Ct);
        Assert.True(noAbility.HasFinishedEpisode);
        Assert.Equal(Readiness.NeedsAbility, OptionsInputsReader.Check(noAbility));

        await SaveEpisode(store, clock.GetUtcNow().AddMinutes(1), [BalancingInterestsAll[0]]);
        var checking = await OptionsInputsReader.ReadAsync(store, User, Ct);
        Assert.Equal(Readiness.Ready, OptionsInputsReader.Check(checking));
        var ability = Assert.Single(checking.Abilities);
        Assert.Equal((TestAbilities.BalancingInterests, AbilityState.NeedsCheck), (ability.Ability, ability.State));
        Assert.Equal("夫と母の予定がぶつかって", Assert.Single(ability.Quotes).Quote);
    }

    [Fact(DisplayName = "options-7（1 場面で進める）: 話している途中の場面だけでは、話し終えた場面に数えない")]
    public async Task TalkingEpisodeDoesNotCount()
    {
        var (store, clock) = await Create();
        await ProfileStore.UpdateAsync(store, User, p => p with { Conditions = Conditions }, clock, Ct);
        await SaveEpisode(store, clock.GetUtcNow(), BalancingInterestsAll, EpisodeStatus.Talking);

        var inputs = await OptionsInputsReader.ReadAsync(store, User, Ct);

        Assert.False(inputs.HasFinishedEpisode);
        Assert.Equal(Readiness.NeedsFinishedEpisode, OptionsInputsReader.Check(inputs));
    }

    [Fact(DisplayName = "options-8（理由は本人の言葉とつなぐ）: 外した力は使える力に入らない")]
    public async Task ExcludedAbilityIsNotUsable()
    {
        var (store, clock) = await Create();
        await ProfileStore.UpdateAsync(store, User, p => p with { Conditions = Conditions }, clock, Ct);
        await SaveEpisode(store, clock.GetUtcNow(), BalancingInterestsAll);
        Assert.Equal(AbilityState.Confirmed, Assert.Single((await OptionsInputsReader.ReadAsync(store, User, Ct)).Abilities).State);

        await AbilityBook.SetExcludedAsync(store, User, TestAbilities.BalancingInterests, true, clock, Ct);
        var inputs = await OptionsInputsReader.ReadAsync(store, User, Ct);

        Assert.Empty(inputs.Abilities);
        Assert.Equal([TestAbilities.BalancingInterests], inputs.Excluded);
        // 外さなければ使える力があるので、話が足りないとは返さない
        Assert.True(inputs.HasExcludedUsable);
        Assert.Equal(Readiness.OnlyExcluded, OptionsInputsReader.Check(inputs));
    }

    [Fact(DisplayName = "options-6（本人が選ぶ、保留する、自分で書く）: 元の記録が変わると指紋が変わる")]
    public async Task BasisChangesWhenTheRecordsChange()
    {
        var (store, clock) = await Create();
        await ProfileStore.UpdateAsync(store, User, p => p with { Conditions = Conditions }, clock, Ct);
        await SaveEpisode(store, clock.GetUtcNow(), BalancingInterestsAll);
        var before = await OptionsInputsReader.ReadAsync(store, User, Ct);
        var basis = OptionsInputsReader.Basis(before, Catalog);

        Assert.Equal(basis, OptionsInputsReader.Basis(await OptionsInputsReader.ReadAsync(store, User, Ct), Catalog));
        Assert.NotEqual(basis, OptionsInputsReader.Basis(before with { Conditions = Conditions with { HoursPerWeek = 5 } }, Catalog));
        Assert.NotEqual(basis, OptionsInputsReader.Basis(before with { Preferences = ["家でできる"] }, Catalog));
        Assert.NotEqual(basis, OptionsInputsReader.Basis(before with { Wants = ["人の役に立つ"] }, Catalog));
        Assert.NotEqual(basis, OptionsInputsReader.Basis(before with { Agency = "自分で決めたい" }, Catalog));
        Assert.NotEqual(basis, OptionsInputsReader.Basis(before with { Abilities = [] }, Catalog));
        // 業務マスターが変わったら、前の業務の力で作ったカードを作り直す（05-options.md の「作り直す」）
        Assert.NotEqual(basis, OptionsInputsReader.Basis(before, Catalog with { Version = "other" }));
        // まだ聞けていない力（変化への気づき）を外しても、使える力は変わらないので作り直さない。使える力を外したときは、上の Abilities の変化で変わる
        Assert.Equal(basis, OptionsInputsReader.Basis(before with { Excluded = [TestAbilities.NoticingChanges] }, Catalog));
    }
}
