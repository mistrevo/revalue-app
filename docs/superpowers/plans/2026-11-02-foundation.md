# 01 foundation（基盤） Implementation Plan

> **For agentic workers:** このリポジトリでは、計画は run-plan スキル（`.claude/workflows/run-plan.js`）で回す（CLAUDE.md）。Superpowers の subagent-driven-development / executing-plans は使わない。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 案内・はじめに（了解）・全部消す・自動で消える・送信回数の上限・人と結びつかない数・公開 URL へのデプロイの土台を、テストつきで作る。

**Architecture:** ASP.NET Core（.NET 10 Minimal API）1 つが API と React の画面を配る。ログインは本番では Container Apps の組み込み認証（Google）が受け持ち、裏側はヘッダーから利用者キー（HMAC）を作る。データは `IDataStore` の裏に Cosmos DB とインメモリの 2 実装を置き、テストはインメモリと `FakeTimeProvider` で TTL と日本時間の日付を再現する。

**Tech Stack:** .NET 10、xUnit v3、Microsoft.AspNetCore.Mvc.Testing、Microsoft.Extensions.TimeProvider.Testing、Microsoft.Azure.Cosmos 3.x、Azure.Identity、React 19 + TypeScript + Vite、Tailwind CSS 4、shadcn/ui、React Router、Vitest + Testing Library、Bicep、GitHub Actions、Docker。

**Spec:** `docs/specs/01-foundation.md`（あわせて `docs/specs/00-common.md`、`docs/specs/00-tech-stack.md`）

## Global Constraints

- 版・置き場所・コマンドは `docs/specs/00-tech-stack.md` に従う。雛形は公式の作り方（`dotnet new web`、`dotnet new xunit3`、`npm create vite@latest` の `react-ts`、`@tailwindcss/vite`、`npx shadcn@latest init`）で作る
- このまとまりでは Claude を呼ばない。`Anthropic` パッケージも入れない
- テスト名に受け入れ基準の呼び名とタイトルを入れる。C# は `[Fact(DisplayName = "foundation-1（案内はログインなしで見られる）: …")]`、画面は `it('foundation-1（案内はログインなしで見られる）: …')`
- 利用者のデータの TTL は 30 日 = `2592000` 秒。日本時間は UTC+9 固定（夏時間なし）。1 日の区切りは日本時間の 0 時
- 送信回数の上限の既定: `Limits:MessagesPerDay = 100`、`Limits:MessagesPerDayTotal = 1000`
- 了解の版: `"2026-11-02"`
- ProblemDetails の `type`: 未ログイン `/problems/login-required`（401）、未了解 `/problems/consent-required`（403）、上限 `/problems/daily-limit`（429、拡張 `resetAt` に日本時間の翌日 0 時を `+09:00` 付きの ISO 8601 で）
- 読んでよい認証ヘッダーは `X-MS-CLIENT-PRINCIPAL-IDP` と `X-MS-CLIENT-PRINCIPAL-ID` だけ。`X-MS-CLIENT-PRINCIPAL-NAME` と `X-MS-CLIENT-PRINCIPAL` は読まない
- 使わない言葉の一覧は `src/shared/forbidden-words.json` の 1 か所: `["診断","判定","スコア","根拠なし","不得意","まだ強みとは言えません","あなたに向いている仕事は","点数","順位"]`
- ログに書いてよいのは、利用者キー、件数、かかった時間、エラーの種類だけ。リクエストとレスポンスの中身は書かない
- 鍵をリポジトリに書かない。`appsettings.json` に鍵を置かない。テストでは `Auth:UserKeySecret` にテスト用の固定値を設定から渡す
- 公開リポジトリ。テストやサンプルの名前・メールアドレスは架空にし、ドメインは `example.com` を使う
- コミットメッセージは日本語。呼び名はタイトルとセットで書く

## Review Focus

1. 本番の設定で、外から `X-Dev-User` のような偽のログインや開発用の `/.auth/login/google` を使われる → 効かない（未ログイン扱い・404）。Task 2 のテストで押さえる
2. 開発用ログインの `post_login_redirect_uri` に `https://evil.example.com` や `//evil.example.com` を渡される → 外へは飛ばさず `/start` へ。Task 2 のテストで押さえる
3. 日本時間の 0 時の前後（UTC 14:59 と 15:00）で、送信回数と「その日に初めて使った」が切り替わる。UTC の日付で切り替えない。Task 3 と Task 5 のテストで押さえる
4. 古い版で了解した人 → 了解していない扱いになり、はじめにの画面へ進む。Task 4 のテストで押さえる
5. 画面のルーターが `/.auth/login/google` を横取りする → ログインのリンクは素の `<a href>` にする。Task 8 のテストで押さえる

---

## ファイルの地図

```
Revalue.slnx
Dockerfile
.dockerignore
src/shared/forbidden-words.json                     使わない言葉（C# と TS の両方から読む）
src/Revalue.Server/
  Program.cs                                          組み立てだけ。各機能の Add*/Map* を呼ぶ
  Properties/launchSettings.json                      http://localhost:5080
  appsettings.json                                    鍵以外の既定値（Limits、Cosmos の名前）
  Foundation/Jst.cs                                   日本時間の今日・翌日 0 時
  Foundation/Problems.cs                              ProblemDetails の type と生成
  Foundation/Auth/UserKeyHasher.cs                    利用者キー（HMAC）
  Foundation/Auth/EasyAuthHandler.cs                  組み込み認証のヘッダーを読む
  Foundation/Auth/DevAuth.cs                          開発用の偽ログイン（Development だけ）
  Foundation/Auth/AuthSetup.cs                        AddRevalueAuth / MapDevAuth / ClaimsPrincipal.GetUserKey
  Foundation/DailyTouchMiddleware.cs                  その日に初めて使ったら TTL を数え直す
  Foundation/RequestLogMiddleware.cs                  中身を書かないアクセスログ
  Foundation/Consent/ConsentEndpoints.cs              /api/me、/api/consent、DELETE /api/me
  Foundation/Consent/RequireConsentFilter.cs          未了解なら 403
  Foundation/Limits/DailyLimitFilter.cs               上限を超えたら 429。RequireDailyLimit()
  Foundation/Counting/Counter.cs                      CountOnceAsync と /api/stats
  Data/Item.cs                                        保存するアイテムの基底と定数
  Data/IDataStore.cs
  Data/InMemoryDataStore.cs                           TimeProvider で TTL を再現
  Data/CosmosDataStore.cs
  Data/DataSetup.cs                                   Cosmos__Endpoint があれば Cosmos、なければインメモリ
  Ai/Prompts/.gitkeep                                 プロンプトの置き場所（中身は 02 から）
tests/Revalue.Server.Tests/
  RevalueFactory.cs                                   WebApplicationFactory。環境・設定・時計・ログの差し替え
  TestWebRoot/index.html                              SPA のフォールバックを確かめる仮の index.html
  *Tests.cs                                           Task ごと
src/web/                                              Vite の react-ts
  vite.config.ts                                      outDir ../Revalue.Server/wwwroot、/api と /.auth を 5080 へ転送
  src/copy.ts                                         画面の文言
  src/api.ts                                          API の呼び出し
  src/components/DailyLimitNotice.tsx
  src/components/RequireUser.tsx                      ログインと了解で画面を出し分け
  src/pages/{Landing,Start,Home,Settings}.tsx
  src/App.tsx                                         ルーティング
  src/**/*.test.tsx
infra/main.bicep
infra/README.md                                       最初の 1 回の手順
.github/workflows/ci.yml
.github/workflows/deploy.yml
```

---

### Task 1: 雛形、ヘルスチェック、SPA の配信、ProblemDetails

**Files:**
- Create: `Revalue.slnx`、`src/Revalue.Server/*`（`dotnet new web`）、`src/Revalue.Server/Foundation/Problems.cs`、`src/Revalue.Server/Ai/Prompts/.gitkeep`、`src/shared/forbidden-words.json`
- Create: `tests/Revalue.Server.Tests/*`（`dotnet new xunit3`）、`RevalueFactory.cs`、`TestWebRoot/index.html`、`HostingTests.cs`、`ForbiddenWordsTests.cs`

**Interfaces:**
- Produces: `public partial class Program`（テストから参照）。`static class Problems { const string LoginRequired = "/problems/login-required"; const string ConsentRequired = "/problems/consent-required"; const string DailyLimit = "/problems/daily-limit"; static IResult Create(int status, string type, string title, IDictionary<string, object?>? extensions = null) }`
- Produces: `RevalueFactory : WebApplicationFactory<Program>`。既定で環境 `Testing`、設定 `Auth:UserKeySecret = "test-secret-not-for-production"`、`UseWebRoot(TestWebRoot)`、`FakeTimeProvider` を `TimeProvider` として登録し `Clock` プロパティで公開、ログを集める `CapturedLogs`（`IReadOnlyList<string>`）。`HttpClient CreateUserClient(string principalId)` は `X-MS-CLIENT-PRINCIPAL-IDP: google` と `X-MS-CLIENT-PRINCIPAL-ID: <principalId>` を付ける。`WithEnvironment(string env)` で環境を変えたファクトリを返す
- Produces: `src/shared/forbidden-words.json`（Global Constraints の配列）

- [ ] **Step 1: 雛形を作る**
  `dotnet new sln -n Revalue`（.NET 10 は `.slnx`）、`dotnet new web -o src/Revalue.Server`、`dotnet new install xunit.v3.templates` → `dotnet new xunit3 -o tests/Revalue.Server.Tests`、両方を sln に足し、テストから Server を参照する。`Microsoft.AspNetCore.Mvc.Testing` と `Microsoft.Extensions.TimeProvider.Testing` をテストに入れる。版は入れたときの最新の安定版で固定。

- [ ] **Step 2: 失敗するテストを書く（`HostingTests.cs`）**
  - `foundation-7（公開 URL で動く）: GET /api/health は未ログインでも 200` — 本文の `status` が `"ok"`
  - `foundation-1（案内はログインなしで見られる）: /api 以外の知らないパスは index.html を返す` — `GET /settings` が 200、`text/html`、本文に TestWebRoot の目印 `revalue-test-root`
  - `foundation-1（案内はログインなしで見られる）: /api の知らないパスは 404 の ProblemDetails` — `GET /api/nope`（ログイン済みのクライアントで）が 404、`application/problem+json`

- [ ] **Step 3: 失敗するテストを書く（`ForbiddenWordsTests.cs`）**
  - `common-1（使わない言葉を出さない）: プロンプトに使わない言葉がない` — `src/Revalue.Server/Ai/Prompts/**/*.md` をすべて読み、`forbidden-words.json` のどの語も含まない（ファイルが 0 件でも通る）

- [ ] **Step 4: `dotnet test` で失敗を確かめる**

- [ ] **Step 5: 実装する**
  `Program.cs` で `AddProblemDetails()`、`GET /api/health` → `{ status = "ok" }`、`UseDefaultFiles` / `UseStaticFiles`、`/api` 以外のフォールバックだけ `index.html`（`/api/{**rest}` は 404 の ProblemDetails）。`launchSettings.json` は `http://localhost:5080`。

- [ ] **Step 6: `dotnet test` が通ることを確かめ、コミットする**
  `雛形とヘルスチェック、SPA の配信を作る（foundation-7 公開 URL で動く の土台）`

---

### Task 2: ログインと利用者キー

**Files:**
- Create: `Foundation/Auth/UserKeyHasher.cs`、`EasyAuthHandler.cs`、`DevAuth.cs`、`AuthSetup.cs`
- Modify: `Program.cs`
- Test: `tests/Revalue.Server.Tests/AuthTests.cs`

**Interfaces:**
- Consumes: Task 1 の `Problems`、`RevalueFactory`
- Produces: `sealed class UserKeyHasher(IConfiguration config) { string Hash(string provider, string principalId) }` — `"u_" + 小文字 16 進(HMACSHA256(key: UTF8(Auth:UserKeySecret), data: UTF8($"{provider}:{principalId}")))`。秘密が空なら起動時に例外
- Produces: `static class AuthSetup { IServiceCollection AddRevalueAuth(this IServiceCollection, IHostEnvironment); void MapDevAuth(this WebApplication) /* Development のときだけ経路を足す */ ; string? GetUserKey(this ClaimsPrincipal) /* claim "user_key" */ }`
- Produces: `/api` のグループ `api`（`MapGroup("/api").RequireAuthorization()`、`/api/health` だけ `AllowAnonymous`）。未ログインの challenge は 401 + `Problems.LoginRequired`
- Produces: 開発用ログイン: cookie `revalue_dev_user`。`GET /.auth/login/google?post_login_redirect_uri=…` で値 `dev-user` を入れてリダイレクト、`GET /.auth/logout?post_logout_redirect_uri=…` で消してリダイレクト。開発用の利用者キーは `Hash("dev", <cookie の値>)`

- [ ] **Step 1: 失敗するテストを書く**
  - `foundation-5（名前とメールアドレスを残さない）: 同じ人は同じ利用者キー、違う人は違うキー、元の ID を含まない` — `Hash("google","123")` が 2 回同じ、`Hash("google","456")` と違う、`"123"` を含まない、`u_` で始まり 64 桁の 16 進が続く
  - `foundation-1（案内はログインなしで見られる）: 未ログインの /api は 401 の ProblemDetails` — `GET /api/me` が 401、`type` が `/problems/login-required`
  - `foundation-1（案内はログインなしで見られる）: 組み込み認証のヘッダーがあればログイン扱い` — `CreateUserClient("g-1")` で `GET /api/nope` が 404（401 ではない）
  - `foundation-5（名前とメールアドレスを残さない）: Testing と Production では偽のログインが効かない` — cookie `revalue_dev_user=x` だけを付けた `GET /api/me` が 401。`GET /.auth/login/google` が 404
  - `foundation-5（名前とメールアドレスを残さない）: Development では偽のログインで入れる` — `WithEnvironment("Development")` で `/.auth/login/google?post_login_redirect_uri=/start` が 302 で `/start` へ、cookie を付けた `GET /api/nope` が 404
  - `foundation-5（名前とメールアドレスを残さない）: 開発用ログインは外のサイトへ飛ばさない` — `post_login_redirect_uri` が `https://evil.example.com` と `//evil.example.com` のとき、`Location` は `/start`

- [ ] **Step 2: `dotnet test --filter` で失敗を確かめる**

- [ ] **Step 3: 実装する**
  `EasyAuthHandler : AuthenticationHandler<AuthenticationSchemeOptions>`（scheme `"EasyAuth"`）は 2 つのヘッダーがそろったときだけ claim `user_key` を作る。`DevAuthHandler`（scheme `"Dev"`）は Development のときだけ登録し、既定の scheme にする（それ以外の環境では `"EasyAuth"` が既定）。challenge は ProblemDetails を書く。リダイレクト先は `/` で始まり `//` で始まらないものだけ許す。

- [ ] **Step 4: `dotnet test` が通ることを確かめ、コミットする**
  `ログインと利用者キーを作る（foundation-1 案内はログインなしで見られる、foundation-5 名前とメールアドレスを残さない）`

---

### Task 3: データの保存先と、自動で消す仕組み

**Files:**
- Create: `Data/Item.cs`、`IDataStore.cs`、`InMemoryDataStore.cs`、`CosmosDataStore.cs`、`DataSetup.cs`、`Foundation/Jst.cs`、`Foundation/DailyTouchMiddleware.cs`
- Modify: `Program.cs`、`appsettings.json`
- Test: `DataStoreTests.cs`、`JstTests.cs`、`AutoDeleteTests.cs`

**Interfaces:**
- Produces: `abstract record Item { string Id; string UserKey; string Type; int? Ttl }`（JSON は camelCase の `id`、`userKey`、`type`、`ttl`）。`static class DataConstants { const int UserTtlSeconds = 2592000; const string GlobalPartition = "global"; }`
- Produces: `interface IDataStore`
  - `Task<T?> GetAsync<T>(string userKey, string id, CancellationToken ct) where T : Item`
  - `Task UpsertAsync<T>(T item, CancellationToken ct) where T : Item` — 利用者のパーティション（`global` 以外）では、`Ttl` が null なら `UserTtlSeconds` を入れて保存する
  - `Task<IReadOnlyList<T>> ListByTypeAsync<T>(string userKey, string type, CancellationToken ct) where T : Item`
  - `Task<int> CountAllAsync(string userKey, CancellationToken ct)` — テストと確認用
  - `Task DeleteAllAsync(string userKey, CancellationToken ct)`
  - `Task TouchAllAsync(string userKey, CancellationToken ct)` — その人のアイテムをすべて書き直し、TTL を数え直す
  - `Task<long> IncrementAsync(string userKey, string id, string type, int? ttl, CancellationToken ct)` — 数のアイテム（`count` プロパティ）を 1 増やして新しい値を返す。なければ作る
  - `IAsyncEnumerable<string> DumpRawJsonAsync(CancellationToken ct)` — インメモリだけ。保存した生の JSON を全部返す（Task 6 のテスト用）。Cosmos では `NotSupportedException`
- Produces: `static class Jst { DateOnly Today(TimeProvider t); DateTimeOffset NextMidnight(TimeProvider t) /* +09:00 */ }`
- Produces: `record ActivityItem : Item`（`Id = "activity"`、`Type = "activity"`、`string LastActiveDate`（`yyyy-MM-dd`、日本時間））。`DailyTouchMiddleware` は認証のあと、ログインした人の `LastActiveDate` が今日（日本時間）でなければ `TouchAllAsync` してから更新する
- Produces: `DataSetup.AddRevalueData(IServiceCollection, IConfiguration)` — `Cosmos:Endpoint` があれば `CosmosDataStore`（`DefaultAzureCredential`、DB `Cosmos:Database` 既定 `revalue`、コンテナ `Cosmos:Container` 既定 `items`、System.Text.Json の camelCase）、なければ `InMemoryDataStore`（シングルトン）

- [ ] **Step 1: 失敗するテストを書く**
  - `JstTests`: UTC `2026-11-02T14:59:59Z` の今日は `2026-11-02`、`15:00:00Z` は `2026-11-03`。`NextMidnight` は `2026-11-03T00:00:00+09:00`（UTC 14:59 のとき）
  - `DataStoreTests`（インメモリ）: 保存・取得・種類で一覧・`DeleteAllAsync` で 0 件・`IncrementAsync` が 1→2。利用者のアイテムは `Ttl == 2592000`、`global` のアイテムは渡した `ttl` のまま
  - `foundation-4（使わなければ自動で消える）: 30 日たつと消える` — 保存して時計を 30 日進めると `GetAsync` が null、`CountAllAsync` が 0
  - `foundation-4（使わなければ自動で消える）: 29 日目に使うと、そこから 30 日残る` — ログイン済みで `GET /api/nope` を叩いて活動を作る → 時計を 29 日進めて再び叩く → さらに 29 日進めてもアイテムが残る → さらに 2 日進めると消える
  - `foundation-4（使わなければ自動で消える）: Cosmos に保存するアイテムには ttl が付く` — `CosmosDataStore` が送る JSON を作る関数（`internal static string Serialize<T>(T item)` など）に `"ttl":2592000` が入る。本物の Cosmos には接続しない

- [ ] **Step 2: 失敗を確かめる**

- [ ] **Step 3: 実装する**
  インメモリは `ConcurrentDictionary<(userKey,id), (string json, DateTimeOffset writtenAt)>`。期限切れ（`now >= writtenAt + ttl`）は読むときに見えなくする。Cosmos の全部消すは `DeleteAllItemsByPartitionKeyStreamAsync` が使えればそれを、使えなければ id を集めて 1 件ずつ消す（microsoft-learn で確かめる）。増やすのは `PatchItemAsync` の `PatchOperation.Increment("/count", 1)`、404 なら作る。

- [ ] **Step 4: `dotnet test` が通ることを確かめ、コミットする**
  `データの保存先と、使わなければ自動で消す仕組みを作る（foundation-4 使わなければ自動で消える）`

---

### Task 4: はじめに（了解）と、全部消す

**Files:**
- Create: `Foundation/Consent/ConsentEndpoints.cs`、`RequireConsentFilter.cs`
- Modify: `Program.cs`
- Test: `ConsentTests.cs`、`DeleteAllTests.cs`

**Interfaces:**
- Consumes: `IDataStore`、`GetUserKey()`、`Problems`
- Produces: `record ConsentItem : Item`（`Id = "consent"`、`Type = "consent"`、`string Version`、`DateTimeOffset At`）。`static class ConsentInfo { const string CurrentVersion = "2026-11-02"; }`
- Produces: `GET /api/me` → `{ consented: bool, consentVersion: string?, currentVersion: string }`。`consented` は記録があり版が `CurrentVersion` と同じときだけ true
- Produces: `POST /api/consent`（本文 `{ version }`）→ 版が違えば 400、同じなら 204
- Produces: `DELETE /api/me` → `DeleteAllAsync(userKey)` → 204
- Produces: `RouteGroupBuilder/RouteHandlerBuilder.RequireConsent()` — 未了解なら 403 + `Problems.ConsentRequired`。02 以降の API はすべてこれを付ける

- [ ] **Step 1: 失敗するテストを書く**
  - `foundation-2（始める前に保存するものを示す）: 初めての人は了解していない` — `GET /api/me` が `consented: false`、`currentVersion: "2026-11-02"`
  - `foundation-2（始める前に保存するものを示す）: 了解するまで、了解の要る API は 403` — `GET /api/stats`（Task 5 で作る。ここでは了解の要るテスト用の確認として `/api/stats` を先に `RequireConsent` 付きで空の 200 を返す形で置いてよい）が 403、`type` が `/problems/consent-required`
  - `foundation-2（始める前に保存するものを示す）: 了解すると記録が残る` — `POST /api/consent {version:"2026-11-02"}` が 204、そのあと `GET /api/me` が `consented: true`、保存した `ConsentItem.At` が時計の時刻
  - `foundation-2（始める前に保存するものを示す）: 古い版の了解は了解していない扱い` — 版 `"2026-10-01"` の `ConsentItem` を直接保存 → `consented: false`、了解の要る API は 403
  - `foundation-2（始める前に保存するものを示す）: 違う版で了解しようとすると 400`
  - `foundation-3（いつでも全部消せる）: 消すと、その人のアイテムが 1 件も残らない` — 利用者 A と B が了解し、A が `DELETE /api/me` → A の `CountAllAsync` が 0、A の `GET /api/me` が `consented: false`、B は `consented: true` のまま、`global` のアイテム数は変わらない

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装する** → **Step 4: 通ることを確かめ、コミットする**
  `はじめに（了解）と、全部消す API を作る（foundation-2 始める前に保存するものを示す、foundation-3 いつでも全部消せる）`

---

### Task 5: 送信回数の上限と、人と結びつかない数

**Files:**
- Create: `Foundation/Limits/DailyLimitFilter.cs`、`Foundation/Counting/Counter.cs`
- Modify: `Program.cs`、`appsettings.json`（`Limits` の既定）
- Test: `DailyLimitTests.cs`、`CounterTests.cs`

**Interfaces:**
- Consumes: `IDataStore.IncrementAsync`、`Jst`、`Problems`
- Produces: `sealed class LimitOptions { int MessagesPerDay = 100; int MessagesPerDayTotal = 1000; }`（`Limits` から読む）
- Produces: `RouteHandlerBuilder RequireDailyLimit(this RouteHandlerBuilder)` — 呼ぶ前に、その人の今日の数（id `usage-yyyy-MM-dd`、type `usage`、その人のパーティション、TTL は既定）とアプリ全体の今日の数（id `usage-total-yyyy-MM-dd`、type `usage-total`、`global`、ttl `172800`）を見る。どちらかが上限以上なら 429 + `Problems.DailyLimit` + `resetAt`。下回っていれば両方を 1 増やしてから次へ
- Produces: `enum CountMetric { ReachedReport, ChoseOption }`、`interface ICounter { Task CountOnceAsync(string userKey, CountMetric metric, CancellationToken ct); Task<StatsDto> GetAsync(CancellationToken ct); }`、`record StatsDto(long ReachedReport, long ChoseOption)`。しるしは id `counted-<metric>`（type `counted`、その人のパーティション）、数は id `count-<metric>`（type `count`、`global`、ttl なし）
- Produces: `GET /api/stats`（`RequireConsent`）→ `{ reachedReport, choseOption }`

- [ ] **Step 1: 失敗するテストを書く**
  上限はテスト用のエンドポイントで確かめる。`RevalueFactory` に、`Testing` 環境のときだけ `POST /api/_test/send`（`RequireConsent().RequireDailyLimit()`、204 を返す）を足す仕組みを作るか、`DefaultEndpointFilterInvocationContext` でフィルターを直接呼ぶ単体テストにする（どちらでもよい。本番の経路には足さない）。設定で `Limits:MessagesPerDay = 3`、`Limits:MessagesPerDayTotal = 5` にする。
  - `foundation-6（使いすぎを穏やかに止める）: 1 人の上限を超えると 429 と次に送れる時刻` — 3 回は通り、4 回目が 429、`type` が `/problems/daily-limit`、`resetAt` が `2026-11-03T00:00:00+09:00`（時計を UTC `2026-11-02T05:00Z` に置く）
  - `foundation-6（使いすぎを穏やかに止める）: アプリ全体の上限でも止まる` — 3 人で合計 5 回通り、6 回目が 429
  - `foundation-6（使いすぎを穏やかに止める）: 日本時間の 0 時を過ぎるとまた送れる` — 上限に達したあと、時計を UTC `14:59:59Z` にしても 429、`15:00:00Z` にすると通る
  - `foundation-8（数だけを数える）: 同じ人を何度数えても 1 回だけ` — A を `ReachedReport` で 3 回数える → 1。B を 1 回 → 2
  - `foundation-8（数だけを数える）: 数のアイテムは利用者キーを持たない` — `global` の `count-*` の生の JSON に、A と B の利用者キーが含まれない
  - `foundation-8（数だけを数える）: 全部消しても数は減らない` — A が `DELETE /api/me` しても `GET /api/stats`（B で）が変わらない

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装する** → **Step 4: 通ることを確かめ、コミットする**
  `送信回数の上限と、人と結びつかない数を作る（foundation-6 使いすぎを穏やかに止める、foundation-8 数だけを数える）`

---

### Task 6: ログに中身を書かない

**Files:**
- Create: `Foundation/RequestLogMiddleware.cs`
- Modify: `Program.cs`、`appsettings.json`（既定のログで中身が出ない設定）
- Test: `LoggingTests.cs`

**Interfaces:**
- Consumes: `RevalueFactory.CapturedLogs`、`InMemoryDataStore.DumpRawJsonAsync`
- Produces: アクセスログ 1 行の形: メソッド、エンドポイントのルートの型（`/api/me` のような。実際のパスやクエリは書かない）、状態コード、かかったミリ秒、利用者キー

- [ ] **Step 1: 失敗するテストを書く**
  目印: 名前 `架空 花子`、メール `hanako@example.com`、話した内容 `目印-話した内容-7f3a`。
  - `common-2（ログに中身を書かない）: 目印がログに出ない` — `X-MS-CLIENT-PRINCIPAL-NAME: hanako@example.com` と `X-MS-CLIENT-PRINCIPAL`（`架空 花子` を含む JSON を Base64）を付け、`POST /api/consent` の本文に `目印-話した内容-7f3a` を足したり、クエリに入れたりして数回呼ぶ → `CapturedLogs` のどの行にも 3 つの目印が出ない。アクセスログの行は 1 件以上ある（ログ自体は出ている）
  - `foundation-5（名前とメールアドレスを残さない）: 保存したアイテムに名前とメールアドレスが入らない` — 上と同じ要求のあと、`DumpRawJsonAsync` のどれにも `hanako@example.com` と `架空 花子` が出ない

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装する**（`UseHttpLogging` で本文やヘッダーを書く設定にしない。例外のログにも要求の中身を入れない）→ **Step 4: 通ることを確かめ、コミットする**
  `ログに中身を書かないようにする（common-2 ログに中身を書かない、foundation-5 名前とメールアドレスを残さない）`

---

### Task 7: 画面の雛形、文言、API の呼び出し

**Files:**
- Create: `src/web/*`（`npm create vite@latest web -- --template react-ts` を `src/` で）、`vite.config.ts`、`src/copy.ts`、`src/api.ts`、`src/copy.test.ts`、`src/api.test.ts`、`vitest` の設定
- Modify: `.gitignore`（`src/Revalue.Server/wwwroot/` を足す）

**Interfaces:**
- Produces: `vite.config.ts` — `build.outDir: '../Revalue.Server/wwwroot'`、`emptyOutDir: true`、開発サーバーで `/api` と `/.auth` を `http://localhost:5080` へ転送、`@` を `src` に。Tailwind は `@tailwindcss/vite`。shadcn/ui は `npx shadcn@latest init` のあと、要る部品（`button`、`card`）だけ足す
- Produces: `package.json` の scripts: `dev`、`build`（`tsc -b && vite build`）、`test`（`vitest run`）
- Produces: `src/copy.ts` — `export const copy = { landing, start, home, settings, limit, errors, nav } as const`。下書き（Claude の判断。言い方は voice-reviewer が点検する）:
  - `landing`: 見出し「RE:VALUE（リバリュー）」、ひとこと「キャリアには空白があっても、人生に空白はない。」、説明「育児などで仕事を離れていたあいだの経験を、AI が聞き手になって、一緒に言葉にします。」、3 つの約束「あなたの言葉が根拠です」（AI が力を見立てるときは、あなたが話した言葉をそのまま添えます。話していないことを、力として書きません）、「決めるのはあなたです」（見立てはいつでも直したり外したりできます。仕事の選択肢も、選ぶ・保留する・自分で書く、のどれでもかまいません）、「安心して話せます」（名前やメールアドレスは保存しません。最後に使った日から 30 日で自動で消え、いつでも全部消せます）、流れ「最近の一日を話す → 見えた力を確かめる → 生活に合う仕事の選択肢から選ぶ」、ボタン「Google でログインして始める」「続きから」
  - `start`: 見出し「はじめる前に」、5 項目（保存するもの／保存しないもの／使い道／保存期間／全部消せる。中身は Spec の「はじめに」に書くこと）、ボタン「了解して始める」
  - `home`: 「ようこそ。ここから、最近の一日の話を始めます。」、「話す（準備中）」
  - `settings`: 見出し「設定」、「全部消す」の説明「話した内容、見立て、記録、レポートをすべて消します。消したものは戻せません。」、ボタン「全部消す」、確かめ「本当に全部消しますか？」「消す」「やめる」、「ログアウト」
  - `limit`: 「今日はここで一区切りにしましょう」「{time} から、また続きを話せます。」
  - `errors`: 「うまくつながりませんでした。少し待ってから、もう一度お試しください。」
- Produces: `src/api.ts`
  - `type Me = { consented: boolean; consentVersion: string | null; currentVersion: string }`
  - `getMe(): Promise<Me | null>`（401 なら null）、`postConsent(version: string): Promise<void>`、`deleteMe(): Promise<void>`
  - `class ApiError extends Error { status: number; type?: string; resetAt?: string }`、`isDailyLimit(e: unknown): e is ApiError`
  - ログインの URL の定数: `LOGIN_URL = '/.auth/login/google?post_login_redirect_uri=/start'`、`LOGOUT_URL = '/.auth/logout?post_logout_redirect_uri=/'`

- [ ] **Step 1: 雛形を作り、`npm --prefix src/web run build` で `src/Revalue.Server/wwwroot/index.html` ができることを確かめる**

- [ ] **Step 2: 失敗するテストを書く**
  - `common-1（使わない言葉を出さない）: copy.ts に使わない言葉がない` — `copy` の文字列をすべて平らにして、`src/shared/forbidden-words.json` のどの語も含まない
  - `api.ts`: `getMe` は 401 で null、200 で `Me`。429 の ProblemDetails で `ApiError` を投げ、`isDailyLimit` が true、`resetAt` が入る（`fetch` を差し替える）

- [ ] **Step 3: 失敗を確かめる** → **Step 4: 実装する** → **Step 5: `npm --prefix src/web test` が通ることを確かめ、コミットする**
  `画面の雛形と文言、API の呼び出しを作る（common-1 使わない言葉を出さない）`

---

### Task 8: 4 つの画面と、上限の表示の部品

**Files:**
- Create: `src/components/DailyLimitNotice.tsx`、`src/components/RequireUser.tsx`、`src/pages/Landing.tsx`、`Start.tsx`、`Home.tsx`、`Settings.tsx`、それぞれの `*.test.tsx`
- Modify: `src/App.tsx`、`src/main.tsx`

**Interfaces:**
- Consumes: `copy`、`getMe`、`postConsent`、`deleteMe`、`LOGIN_URL`、`LOGOUT_URL`
- Produces: ルート `/` Landing、`/start` Start（ログインが要る）、`/home` Home（ログインと了解が要る）、`/settings` Settings（ログインが要る）
- Produces: `<RequireUser consent?: boolean>` — `getMe()` が null なら `/` へ、`consent` が true で未了解なら `/start` へ
- Produces: `<DailyLimitNotice resetAt: string />` — `copy.limit` を出し、`{time}` に「明日の 0 時（日本時間）」のように日本時間で表す

- [ ] **Step 1: 失敗するテストを書く（`MemoryRouter` と `fetch` の差し替えで）**
  - `foundation-1（案内はログインなしで見られる）: 未ログインで案内が出て、ログインは素のリンク` — `/` に 3 つの約束の見出しが出る。「Google でログインして始める」は `<a>` で `href` が `LOGIN_URL`
  - `foundation-1（案内はログインなしで見られる）: 未ログインでログインの要る画面を開くと案内へ戻る` — `/home` を開くと Landing が出る
  - `foundation-2（始める前に保存するものを示す）: はじめにの画面に 5 つの項目が出る` — 見出しと 5 項目の見出しの文言がある。「了解して始める」で `POST /api/consent` が `{version: currentVersion}` で呼ばれ、`/home` へ進む
  - `foundation-2（始める前に保存するものを示す）: 了解していない人がホームを開くと、はじめにへ進む`
  - `foundation-3（いつでも全部消せる）: もう一度確かめてから消し、はじめにへ進む` — 「全部消す」を押しただけでは `DELETE` が呼ばれない。「本当に全部消しますか？」が出て、「やめる」で戻る。「消す」で `DELETE /api/me` が 1 回呼ばれ、`/start` へ進む。`window.confirm` を呼ばない
  - `foundation-6（使いすぎを穏やかに止める）: 上限の表示は穏やかな言葉と次の時刻を出す` — `resetAt="2026-11-03T00:00:00+09:00"` で「今日はここで一区切りにしましょう」と「0 時」が出る

- [ ] **Step 2: 失敗を確かめる** → **Step 3: 実装する**（幅 375px で崩れないよう、1 列で読みやすい幅に収める）→ **Step 4: `npm --prefix src/web test` と `npm --prefix src/web run build` が通ることを確かめ、コミットする**
  `案内・はじめに・ホーム・設定の画面と、上限の表示を作る（foundation-1、foundation-2、foundation-3、foundation-6）`

- [ ] **Step 5: 実際のブラウザで見る**
  `dotnet run --project src/Revalue.Server --environment Development` と画面のビルドのあと、Playwright MCP で `http://localhost:5080/` を幅 375px と 1280px で開き、案内 → ログイン（開発用）→ はじめに → 了解 → ホーム → 設定 → 全部消す → はじめに、の順に通す。崩れや文言の抜けがあれば直してコミットする。スクリーンショットはコミットしない

---

### Task 9: コンテナ、CI、デプロイ、Azure の定義

**Files:**
- Create: `Dockerfile`、`.dockerignore`、`.github/workflows/ci.yml`、`.github/workflows/deploy.yml`、`infra/main.bicep`、`infra/README.md`

**Interfaces:**
- Consumes: Task 1〜8 のコマンド（`00-tech-stack.md` の「コマンド」）
- Produces: リポジトリ変数（鍵ではない）の名前: `AZURE_CLIENT_ID`（GitHub Actions 用のマネージド ID）、`AZURE_TENANT_ID`、`AZURE_SUBSCRIPTION_ID`、`AZURE_RESOURCE_GROUP`、`CONTAINER_APP_NAME`、`APP_URL`
- Produces: `infra/main.bicep` のパラメーター: `location`（既定 `resourceGroup().location`）、`appName`（既定 `revalue`）、`googleClientId`、`githubRepo`（既定 `mistrevo/revalue-app`）、`containerImage`（既定は Microsoft の仮イメージ）、`deployApp`（bool。既定 true）、`enableCosmosFreeTier`（既定 true）
- Produces: Key Vault の secret の名前: `anthropic-api-key`、`user-key-secret`、`google-client-secret`

- [ ] **Step 1: `Dockerfile` を書き、`docker build -t revalue-app:local .` が通ることを確かめる**
  3 段: Node 24 で `npm ci` と画面のビルド → .NET 10 SDK で `dotnet publish src/Revalue.Server -c Release` → `mcr.microsoft.com/dotnet/aspnet:10.0` で実行。ポート 8080、root でない利用者で動かす。`docker run` で `/api/health` が 200 になることも確かめる（`Auth__UserKeySecret` はその場の仮の値を環境変数で渡す）

- [ ] **Step 2: `ci.yml` を書く**
  `pull_request` と `push` で、3 つのジョブ: 裏側（`actions/setup-dotnet` で 10.x、`dotnet build`、`dotnet test`）、画面（`actions/setup-node` で 24、`npm --prefix src/web ci`、`npm --prefix src/web test`、`npm --prefix src/web run build`）、フック（`node --test .claude/hooks/guard.test.mjs`）。`permissions: contents: read`

- [ ] **Step 3: `infra/main.bicep` を書き、`az bicep build --file infra/main.bicep` が通ることを確かめる**
  中身は `00-tech-stack.md` の「Azure の構成」と、Spec の「公開 URL に出す仕組み」。要点:
  - Log Analytics、Container Apps の環境（従量課金）、ユーザー割り当てマネージド ID 2 つ（アプリ用、GitHub Actions 用）
  - Key Vault（RBAC。アプリ用 ID と GitHub Actions 用 ID に「Key Vault Secrets User」）
  - Cosmos DB for NoSQL（`enableFreeTier` はパラメーター、`disableLocalAuth: true`）、DB `revalue`、コンテナ `items`（パーティションキー `/userKey`、`defaultTtl: -1`）。アプリ用 ID に組み込みの「Cosmos DB Built-in Data Contributor」（データの読み書き）
  - GitHub Actions 用 ID に、Container App を更新できる役割と、フェデレーション資格情報（issuer `https://token.actions.githubusercontent.com`、subject `repo:<githubRepo>:ref:refs/heads/main`、audience `api://AzureADTokenExchange`）
  - `deployApp` が true のときだけ Container App を作る。Key Vault を参照する secret（`anthropic-api-key`、`user-key-secret`、`google-client-secret`）、環境変数 `ANTHROPIC_API_KEY`・`Auth__UserKeySecret`・`Cosmos__Endpoint`・`AZURE_CLIENT_ID`（アプリ用 ID）、外部公開のポート 8080、最小 0 台・最大 1 台
  - 組み込み認証（`Microsoft.App/containerApps/authConfigs` の `current`）: 有効、`unauthenticatedClientAction: AllowAnonymous`、Google（`clientId` は `googleClientId`、シークレットは app の secret `google-client-secret`）
  - 出力: アプリの URL、GitHub Actions 用 ID のクライアント ID、テナント ID

- [ ] **Step 4: `deploy.yml` を書く**
  `push`（main）と `workflow_dispatch`。`permissions: id-token: write, contents: read, packages: write`。リポジトリ変数 `AZURE_CLIENT_ID` が空なら、デプロイを飛ばして「Azure の準備がまだ」と出し、失敗にしない。ある場合は、イメージを `ghcr.io/${{ github.repository }}:${{ github.sha }}` で push → `azure/login`（OIDC）→ `az containerapp update --image` → `APP_URL` の `/api/health` と `/` が 200 になるまで最大 3 分待って確かめる

- [ ] **Step 5: `infra/README.md` に最初の 1 回の手順を書く**
  順に: (1) `az deployment group create -g <リソースグループ> -f infra/main.bicep -p deployApp=false googleClientId=<…>` → (2) Key Vault に `anthropic-api-key`（開発者）、`user-key-secret`（乱数で作ってよい）、`google-client-secret`（開発者）を入れる → (3) `deployApp=true` でもう一度流す → (4) 出力からリポジトリ変数を `gh variable set` で入れる → (5) Google 側の「承認済みのリダイレクト URI」に `https://<アプリの URL>/.auth/login/google/callback` を足し、OAuth の同意画面を「本番」にする → (6) `ghcr.io` のパッケージを公開にする（Container App が鍵なしで取れるように）→ (7) `deploy.yml` を手動で流し、`/api/health` を確かめる

- [ ] **Step 6: コミットする**
  `コンテナ、CI、デプロイ、Azure の定義を作る（foundation-7 公開 URL で動く）`

---

## 確認コマンド

順に流し、すべて通ることを確かめる。

```
dotnet build
dotnet test
npm --prefix src/web ci
npm --prefix src/web test
npm --prefix src/web run build
node --test .claude/hooks/guard.test.mjs
az bicep build --file infra/main.bicep
docker build -t revalue-app:local .
```

main に入れたあとに確かめること（Workflow の外で、メインのセッションが行う）: `deploy.yml` の結果、公開 URL の `/api/health` と `/`、Playwright での幅 375px と PC の表示（foundation-7 公開 URL で動く）。Azure のリソースグループと Google の OAuth クライアントがまだなければ、`deploy.yml` は飛ばされるので、開発者からの情報を待って `infra/README.md` の手順を流す。
