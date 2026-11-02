namespace Revalue.Server.Ai;

/// <summary>AI の呼び出し 1 回で使ったトークン数。<see cref="Call"/> は "read"（読み取り）か "reply"（返事）など。</summary>
public sealed record AiUsage(string Call, long InputTokens, long CacheReadTokens, long CacheWriteTokens, long OutputTokens);

/// <summary>トークン数を受け取る数え役。評価がトークン数と費用を結果に残すために使う。製品では登録しない。</summary>
public interface IAiUsageMeter
{
    void Record(AiUsage usage);
}
