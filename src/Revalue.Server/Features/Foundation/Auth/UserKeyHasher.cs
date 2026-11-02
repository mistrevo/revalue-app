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
        : this(config, environment: null)
    {
    }

    /// <summary>
    /// 開発環境（Development）だけは、鍵がなければ起動ごとの乱数を鍵にする。手元はインメモリの保存先で、
    /// 止めればデータも消えるので、鍵が変わっても困らない。それ以外の環境では、鍵がなければ起動を止める。
    /// </summary>
    [ActivatorUtilitiesConstructor]
    public UserKeyHasher(IConfiguration config, IHostEnvironment? environment)
    {
        var secret = config["Auth:UserKeySecret"];
        if (!string.IsNullOrEmpty(secret))
        {
            _secret = Encoding.UTF8.GetBytes(secret);
            return;
        }

        if (environment?.IsDevelopment() == true)
        {
            _secret = RandomNumberGenerator.GetBytes(32);
            return;
        }

        throw new InvalidOperationException("Auth:UserKeySecret is not set.");
    }

    public string Hash(string provider, string principalId)
    {
        var data = Encoding.UTF8.GetBytes($"{provider}:{principalId}");
        return "u_" + Convert.ToHexStringLower(HMACSHA256.HashData(_secret, data));
    }
}
