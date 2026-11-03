using Revalue.Server.Features.Options;

namespace Revalue.Server.Ai;

/// <summary>
/// 仕事の選択肢の AI。条件に合う候補と使える力から、3 枚のカードの下書きを書く。下書きはコード（<see cref="OptionsValidator"/>）が照らし合わせるまでは使わない。
/// テストと開発では偽物（<see cref="ScriptedOptionsAi"/>）に差し替える。
/// </summary>
public interface IOptionsAi
{
    /// <exception cref="ConversationAiException">AI が断った、または失敗した。</exception>
    Task<OptionsDraft> DraftAsync(OptionsInputs inputs, OptionCandidates candidates, CancellationToken ct);
}
