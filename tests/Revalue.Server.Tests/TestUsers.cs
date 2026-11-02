using Microsoft.Extensions.Configuration;
using Revalue.Server.Features.Foundation.Auth;

namespace Revalue.Server.Tests;

/// <summary>テストで使う利用者キーの作り方。ヘッダーの ID から、裏側と同じキーを求める。</summary>
public static class TestUsers
{
    public static string Key(string principalId, string provider = "google") =>
        new UserKeyHasher(new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?> { ["Auth:UserKeySecret"] = RevalueFactory.TestSecret })
            .Build()).Hash(provider, principalId);
}
