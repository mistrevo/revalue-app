using System.Collections.Concurrent;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.TestHost;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Time.Testing;

namespace Revalue.Server.Tests;

/// <summary>
/// テスト用に裏側を丸ごと立ち上げる。環境・設定・時計・ログを差し替える。
/// </summary>
public sealed class RevalueFactory : WebApplicationFactory<Program>
{
    public const string TestSecret = "test-secret-not-for-production";

    private readonly string _environment;
    private readonly Dictionary<string, string?> _settings;
    private readonly Action<IServiceCollection>? _testServices;
    private readonly LogCollector _logs = new();

    static RevalueFactory()
    {
        // テストでは裏側を何百回も立ち上げる。立ち上げのたびに設定ファイル（appsettings.json）の変更を見張ると、CI の Linux では
        // 見張りの数の上限（inotify の 128）に達し、裏側が立ち上がらなくなる。テストでは設定ファイルを読み直さないので、見張りを作らない
        Environment.SetEnvironmentVariable("DOTNET_hostBuilder__reloadConfigOnChange", "false");
    }

    public RevalueFactory() : this("Testing", new Dictionary<string, string?>(), null)
    {
    }

    private RevalueFactory(string environment, Dictionary<string, string?> settings, Action<IServiceCollection>? testServices)
    {
        _environment = environment;
        _settings = settings;
        _testServices = testServices;
        // 日本時間 2026-11-02 12:00
        Clock = new FakeTimeProvider(new DateTimeOffset(2026, 11, 2, 3, 0, 0, TimeSpan.Zero));
    }

    /// <summary>差し替えた時計。テストで進める。</summary>
    public FakeTimeProvider Clock { get; }

    /// <summary>アプリが書いたログを 1 行ずつ集めたもの（例外の中身も含む）。</summary>
    public IReadOnlyList<string> CapturedLogs => _logs.Lines.ToArray();

    /// <summary>環境を変えたファクトリを返す。</summary>
    public RevalueFactory WithEnvironment(string environment) =>
        new(environment, new Dictionary<string, string?>(_settings), _testServices);

    /// <summary>設定を足したファクトリを返す。</summary>
    public RevalueFactory WithSetting(string key, string? value)
    {
        var settings = new Dictionary<string, string?>(_settings) { [key] = value };
        return new RevalueFactory(_environment, settings, _testServices);
    }

    /// <summary>サービスを差し替えたファクトリを返す（保存先を包んで、決まった順で割り込ませるときなど）。</summary>
    public RevalueFactory WithTestServices(Action<IServiceCollection> configure) =>
        new(_environment, new Dictionary<string, string?>(_settings), configure);

    /// <summary>組み込み認証と同じヘッダーを付けた、ログイン済みのクライアント。</summary>
    public HttpClient CreateUserClient(string principalId)
    {
        var client = CreateClient();
        client.DefaultRequestHeaders.Add("X-MS-CLIENT-PRINCIPAL-IDP", "google");
        client.DefaultRequestHeaders.Add("X-MS-CLIENT-PRINCIPAL-ID", principalId);
        return client;
    }

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment(_environment);
        builder.UseSetting("Auth:UserKeySecret", TestSecret);
        foreach (var (key, value) in _settings)
        {
            builder.UseSetting(key, value);
        }

        builder.UseWebRoot(Path.Combine(AppContext.BaseDirectory, "TestWebRoot"));

        builder.ConfigureLogging(logging => logging.AddProvider(_logs));
        builder.ConfigureTestServices(services =>
        {
            services.AddSingleton<TimeProvider>(Clock);
            _testServices?.Invoke(services);
        });
    }

    private sealed class LogCollector : ILoggerProvider
    {
        public ConcurrentQueue<string> Lines { get; } = new();

        public ILogger CreateLogger(string categoryName) => new CollectingLogger(categoryName, Lines);

        public void Dispose()
        {
        }
    }

    private sealed class CollectingLogger(string category, ConcurrentQueue<string> lines) : ILogger
    {
        public IDisposable? BeginScope<TState>(TState state) where TState : notnull => null;

        public bool IsEnabled(LogLevel logLevel) => logLevel != LogLevel.None;

        public void Log<TState>(LogLevel logLevel, EventId eventId, TState state, Exception? exception, Func<TState, Exception?, string> formatter)
        {
            var line = $"{logLevel} {category}: {formatter(state, exception)}";
            if (exception is not null)
            {
                line += " " + exception;
            }

            lines.Enqueue(line);
        }
    }
}
