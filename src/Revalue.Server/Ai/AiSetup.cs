using Anthropic;

namespace Revalue.Server.Ai;

public static class AiSetup
{
    /// <summary>Claude の鍵の設定名。SDK と同じ環境変数の名前。</summary>
    public const string ApiKeySetting = "ANTHROPIC_API_KEY";

    /// <summary>
    /// 会話の AI を登録する。
    /// - Testing: 鍵があっても偽物（<see cref="ScriptedConversationAi"/>）。テストで Claude を呼ばないため（Claude の判断）
    /// - Development: 鍵があれば本物、なければ偽物
    /// - それ以外（Production）: 鍵があれば本物。なければ、決まった返事のまま動き続けないよう起動を止める（Claude の判断）
    /// </summary>
    public static IServiceCollection AddConversationAi(this IServiceCollection services, IConfiguration config, IHostEnvironment environment)
    {
        services.Configure<ClaudeOptions>(config.GetSection("Claude"));

        var apiKey = config[ApiKeySetting];
        var hasKey = !string.IsNullOrWhiteSpace(apiKey);
        if (environment.IsEnvironment("Testing") || (environment.IsDevelopment() && !hasKey))
        {
            services.AddSingleton<IConversationAi, ScriptedConversationAi>();
            return services;
        }

        if (!hasKey)
        {
            throw new InvalidOperationException($"{ApiKeySetting} is required outside Development and Testing.");
        }

        services.AddSingleton(_ => new AnthropicClient { ApiKey = apiKey });
        services.AddSingleton<IConversationAi, ClaudeConversationAi>();
        return services;
    }
}
