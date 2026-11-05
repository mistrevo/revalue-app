using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Options;
using static Revalue.Server.Tests.DeepenTestKit;

namespace Revalue.Server.Tests;

public sealed class DeepenTargetTests
{
    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 選んだ案がないか保留なら深めず、条件がなければ条件を求める")]
    public void NotReadyStates()
    {
        Assert.Equal(DeepenReadiness.NoChoice, DeepenTargetReader.From(null, Conditions(), Catalog).Readiness);
        Assert.Equal(DeepenReadiness.NoChoice, DeepenTargetReader.From(Options(null), Conditions(), Catalog).Readiness);
        var hold = Options(new OptionChoice(ChoiceKind.Hold, Now, null, null, null, null, null));
        Assert.Equal(DeepenReadiness.Hold, DeepenTargetReader.From(hold, Conditions(), Catalog).Readiness);
        Assert.Equal(DeepenReadiness.NeedsConditions, DeepenTargetReader.From(Options(ChooseChoice()), null, Catalog).Readiness);
        var missingOwn = Options(new OptionChoice(ChoiceKind.Own, Now, null, null, null, null, "none"));
        Assert.Equal(DeepenReadiness.NoChoice, DeepenTargetReader.From(missingOwn, Conditions(), Catalog).Readiness);
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 選んだカードと本人が書いた仕事を、種類と名前と業務で対象にする")]
    public void BuildsTargets()
    {
        var choose = Target(Options(ChooseChoice()));
        Assert.Equal(TargetKind.Choose, choose.Kind);
        Assert.Equal("オンライン秘書", choose.Title);
        Assert.Equal(["online-secretary-arrangement"], choose.Registered.Select(t => t.Id));
        Assert.False(choose.Drafts);

        var combine = Target(Options(CombineChoice()));
        Assert.Equal((TargetKind.Combine, "予定をつなぐ人"), (combine.Kind, combine.Title));
        Assert.Equal(2, combine.Registered.Count);

        var create = Target(Options(CreateChoice()));
        Assert.Equal((TargetKind.Create, "近所の予定合わせ"), (create.Kind, create.Title));
        Assert.Empty(create.Registered);
        Assert.True(create.Drafts);

        var own = Target(OwnOptions());
        Assert.Equal((TargetKind.Own, "地域の窓口の手伝い"), (own.Kind, own.Title));
        Assert.Empty(own.Registered);
        Assert.True(own.Drafts);
    }

    [Fact(DisplayName = "deepen-1（選んだ 1 案だけ深める）: 別の案を選ぶか書いた仕事を直すと指紋が変わり、同じ案を選び直しても条件が変わっても指紋は変わらない")]
    public void BasisChangesOnlyWithTheCase()
    {
        var choose = Target(Options(ChooseChoice()));
        Assert.NotEqual(choose.Basis, Target(Options(CombineChoice())).Basis);
        Assert.NotEqual(Target(OwnOptions("家の近くで")).Basis, Target(OwnOptions("駅の近くで")).Basis);
        Assert.Equal(choose.Basis, Target(Options(ChooseChoice(Now.AddMinutes(1)))).Basis);
        Assert.Equal(choose.Basis, Target(Options(ChooseChoice()), Conditions(hours: 1)).Basis);
        Assert.Equal(64, choose.Basis.Length);
    }
}
