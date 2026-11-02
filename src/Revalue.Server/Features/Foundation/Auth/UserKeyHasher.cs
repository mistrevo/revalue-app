using System.Security.Cryptography;
using System.Text;

namespace Revalue.Server.Features.Foundation.Auth;

/// <summary>
/// ログインした人の ID を、鍵を使って元に戻せない「利用者キー」に変える。
/// 「プロバイダー名:ID」を HMAC-SHA256 にかけ、先頭に u_ を付ける。
/// </summary>
public sealed class UserKeyHasher
{
    private readonly byte[] _secret;

    public UserKeyHasher(IConfiguration config)
    {
        var secret = config["Auth:UserKeySecret"];
        if (string.IsNullOrEmpty(secret))
        {
            throw new InvalidOperationException("Auth:UserKeySecret is not set.");
        }

        _secret = Encoding.UTF8.GetBytes(secret);
    }

    public string Hash(string provider, string principalId)
    {
        var data = Encoding.UTF8.GetBytes($"{provider}:{principalId}");
        return "u_" + Convert.ToHexStringLower(HMACSHA256.HashData(_secret, data));
    }
}
