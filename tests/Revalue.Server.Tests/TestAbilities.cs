using Revalue.Server.Features.Validate;

namespace Revalue.Server.Tests;

/// <summary>
/// テストで使う力の値。力の id は能力辞書（<c>src/shared/abilities.json</c>）の id で、裏側のコードには決め打ちしない。
/// 行動が 3 つの力（変化への気づき、利害調整力、優先順位設定力）と、行動が 2 つの力を置く。
/// </summary>
public static class TestAbilities
{
    /// <summary>変化への気づき（行動 3 つ。分類は家庭・子育て・人間関係から見える力）。</summary>
    public static readonly Ability NoticingChanges = new("noticing-changes");

    /// <summary>利害調整力（行動 3 つ。分類は調整・実行・仕組み化）。</summary>
    public static readonly Ability BalancingInterests = new("balancing-interests");

    /// <summary>優先順位設定力（行動 3 つ。分類は調整・実行・仕組み化）。</summary>
    public static readonly Ability SettingPriorities = new("setting-priorities");

    /// <summary>要約力（行動 2 つ。分類は対話・コミュニケーション）。</summary>
    public static readonly Ability Summarizing = new("summarizing");

    /// <summary>傾聴力（行動 2 つ。分類は対話・コミュニケーション）。</summary>
    public static readonly Ability ActiveListening = new("active-listening");

    /// <summary>段取り力（行動 2 つ。分類は調整・実行・仕組み化）。</summary>
    public static readonly Ability PlanningSteps = new("planning-steps");

    /// <summary>論点整理力（行動 3 つ。分類は対話・コミュニケーション）。</summary>
    public static readonly Ability OrganizingIssues = new("organizing-issues");

    /// <summary>共感力（行動 2 つ。分類は共感・安心・対人支援）。</summary>
    public static readonly Ability Empathy = new("empathy");

    /// <summary>粘り強さ（行動 2 つ。分類は実行・挑戦）。</summary>
    public static readonly Ability Persistence = new("persistence");

    /// <summary>辞書から消えた力の id（<c>noticing</c>、<c>coordinating</c>、<c>prioritizing</c> など）を持つ値。保存データの古い id を作る。</summary>
    public static Ability Old(string id) => new(id);
}
