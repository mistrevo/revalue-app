using Revalue.Server.Features.Deepen;
using Revalue.Server.Features.Options;

namespace Revalue.Server.Ai;

/// <summary>
/// 選んだ案を深める AI。業務の見立て（「創る」と本人が書いた仕事だけ）、仮の場面の問い、最初の一歩の候補を 1 回で書く。
/// 答えはコード（<see cref="DeepenValidator"/>）が照らし合わせるまでは使わない。根拠の本人の言葉は渡さない（06-deepen.md）。
/// テストと開発では偽物（<see cref="ScriptedDeepenAi"/>）に差し替える。
/// </summary>
public interface IDeepenAi
{
    /// <param name="inputs">条件、好み、やりたいこと、主体性だけを使う。力の状態と根拠の言葉は使わない。</param>
    /// <exception cref="ConversationAiException">AI が断った、または失敗した。</exception>
    Task<DeepenDraft> DraftAsync(DeepenTarget target, OptionsInputs inputs, CancellationToken ct);
}
