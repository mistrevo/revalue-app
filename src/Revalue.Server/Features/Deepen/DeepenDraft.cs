namespace Revalue.Server.Features.Deepen;

/// <summary>業務の見立ての AI の答え。<paramref name="Ability"/> は力の key。</summary>
public sealed record TaskDraft(string Name, string Detail, string Ability, string Knowledge);

/// <summary>仮の場面の問いの AI の答え。</summary>
public sealed record QuestionDraft(string Situation, string Ability, IReadOnlyList<string> Choices);

/// <summary>最初の一歩の候補の AI の答え。<paramref name="Place"/> は <c>home</c> か <c>out</c>。</summary>
public sealed record StepDraft(string Text, int Hours, string Place, bool DemandCheck);

/// <summary>
/// 深める AI の答え。コード（<see cref="DeepenValidator"/>）が照らし合わせるまでは使わない。
/// </summary>
public sealed record DeepenDraft(IReadOnlyList<TaskDraft> Tasks, IReadOnlyList<QuestionDraft> Questions, IReadOnlyList<StepDraft> Steps);

/// <summary>照らし合わせで落とした部分と、当たった規則の名前。評価とログが規則ごとに数える。<paramref name="Part"/> は tasks、question、steps。</summary>
public sealed record DeepenRejection(string Part, string Rule);
