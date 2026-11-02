# 技術スタック

コードを書くエージェントとスキルが迷わないための決まり。コードを書く前に読む。ここにない技術を足すときは、理由と一緒にこの文書に書き足す。

> 素案（2026-11-02）。Claude が仮に決めたところには「（Claude の判断）」と書いた。
>
> 製品の決まり（何を保存するか、画面で使わない言葉など）の元は、`docs/prd/` と `docs/specs/00-common.md`。この文書には、それを実装する仕方を書く。

## 目的

- アプリを 1 つのコンテナにまとめ、開発者がいちばん速く作れる Azure と .NET で動かす
- 費用を無料に近づける。Claude API は、配布された $500 のクレジットで賄う
- 開発者が出張中でも、クラウドの VM（仮想マシン。Windows か Linux）でエージェントが同じコマンドで作り、試し、デプロイできる

## 構成

```
ブラウザ（React の画面）
   │  HTTPS。ログインは Container Apps の組み込み認証（Google）が受け持つ
   ▼
ASP.NET Core（コンテナ 1 つ。API と画面のファイルを配る）
   ├─ Claude API（Anthropic に直接。公式の C# SDK）
   ├─ Cosmos DB（データ。マネージド ID で接続）
   └─ Key Vault（鍵。Container Apps が読み、環境変数で渡す）
```

Container Apps はコンテナを動かす Azure のサービスで、組み込み認証はアプリの手前でログインを受け持つ機能。Cosmos DB は Azure のデータベース、Key Vault は鍵の保管庫。マネージド ID は、鍵なしで Azure に認証する仕組み。

画面と API は同じドメインから配るので、別の中継サーバー（BFF）は作らない。

## 版

版は、入れたときの最新の安定版で固定する（`package-lock.json` と各 `.csproj`）。上げるときは、理由をコミットメッセージに書く。

| 部分 | 使うもの | 版（2026-11-02 時点） |
|---|---|---|
| 実行環境 | .NET（LTS） | 10 |
| 裏側 | ASP.NET Core の Minimal API | 10 |
| Claude | Anthropic の公式 C# SDK（NuGet `Anthropic`） | 13 系 |
| データ | Cosmos DB の SDK（NuGet `Microsoft.Azure.Cosmos`） | 3 系 |
| Azure の認証 | `Azure.Identity`（`DefaultAzureCredential`） | 最新 |
| 裏側のテスト | xUnit v3（`xunit.v3`）と `Microsoft.AspNetCore.Mvc.Testing` | 最新 |
| 画面 | React、TypeScript、Vite | React 19、TypeScript 7、Vite 8 |
| 画面の部品 | Tailwind CSS、shadcn/ui | Tailwind CSS 4 |
| 画面の切り替え | React Router | 最新 |
| 画面のテスト | Vitest、Testing Library | 最新 |
| 通しのテスト | Playwright（`@playwright/test`） | 最新 |
| Node.js | LTS | 24 |
| Azure の定義 | Bicep | 最新 |
| テストとデプロイ | GitHub Actions | — |

## 置き場所

```
Revalue.slnx                      ソリューション（.NET 10 の dotnet new sln が作る形式）
Dockerfile                        画面を作る → 裏側を publish → 実行用の小さいイメージ、の 3 段
src/Revalue.Server/               ASP.NET Core
  Program.cs
  Features/<まとまり>/            機能のまとまりごとのフォルダ。PRD のまとまりの名前にそろえる（Foundation、Discover、Validate、Profile、Options、Deepen、Report）
  Ai/                             Claude の呼び出し
  Ai/Prompts/*.md                 プロンプト（日本語）。評価からも同じファイルを読む
  Data/                           Cosmos DB と、テスト用のインメモリの保存先
  wwwroot/                        画面を作った結果（コミットしない）
src/web/                          React と TypeScript の画面（Vite）
  src/components/ui/              shadcn/ui の部品（CLI で足す）
  src/copy.ts                     画面の文言をまとめる場所（言い方の点検をしやすくするため。Claude の判断）
tests/Revalue.Server.Tests/       裏側のテスト
evals/
  episodes/                       架空エピソード（e01-*.md から）
  criteria.md                     合格基準
  results/                        評価の結果（日付つき）
  Revalue.Evals/                  評価を回すコンソールアプリ（Revalue.Server を参照する）
infra/main.bicep                  Azure のリソースの定義
.github/workflows/                ci.yml、deploy.yml、evals.yml
```

## コマンド

Windows と Linux のどちらでも同じように動く形で書く。`cd` で移動せず、`--project` や `--prefix` で場所を指す。

| やること | コマンド |
|---|---|
| 裏側を作る | `dotnet build` |
| 裏側のテスト | `dotnet test` |
| 画面の準備 | `npm --prefix src/web ci` |
| 画面を作る | `npm --prefix src/web run build`（結果は `src/Revalue.Server/wwwroot/` に出す） |
| 画面のテスト | `npm --prefix src/web test` |
| 手元で動かす（裏側） | `dotnet run --project src/Revalue.Server` |
| 手元で動かす（画面） | `npm --prefix src/web run dev`（`/api` を裏側へ転送する） |
| 評価を回す | `dotnet run --project evals/Revalue.Evals` |
| フックのテスト | `node --test .claude/hooks/guard.test.mjs` |

雛形を作るときは、公式の作り方に従う。

- 裏側: `dotnet new web`。テストは `dotnet new install xunit.v3.templates` のあと `dotnet new xunit3`
- 画面: `npm create vite@latest` の `react-ts`。そのあと Tailwind CSS（`@tailwindcss/vite`）と `npx shadcn@latest init`

## 裏側の決まり

- Minimal API で書く。コントローラーは使わない
- 画面のファイルは `wwwroot` から配る。`/api` 以外の知らないパスには `index.html` を返す
- AI の返答を画面に流すときは Server-Sent Events（サーバーから画面へ少しずつ送る仕組み）を使う（.NET 10 の `TypedResults.ServerSentEvents`。書き方は microsoft-learn で確かめる）
- エラーは ProblemDetails（エラーを決まった形の JSON で返す標準）で返す。利用者に見せる文言は画面側で穏やかな言葉にする
- 設定は環境変数で渡す。`appsettings.json` に鍵を書かない

| 設定 | 中身 |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API の鍵。SDK がこの名前を読む |
| `Claude__Model` | 使うモデル。既定は `claude-opus-5-5` |
| `Cosmos__Endpoint` | Cosmos DB の URL |
| `Auth__UserKeySecret` | ログインした人の ID を変換するための鍵 |
| `Limits__MessagesPerDay` | 1 人 1 日に送れる回数（既定 100。Claude の判断） |
| `Limits__MessagesPerDayTotal` | アプリ全体で 1 日に送れる回数（既定 1000。Claude の判断） |

- 1 日の区切りは日本時間の 0 時（Claude の判断）
- **ログに書いてよいのは、変換したあとの ID、件数、かかった時間、トークン数、エラーの種類だけ**。話した内容、AI の返答、メールアドレス、名前は書かない

## Claude の呼び方

SDK の書き方は推測しない。claude-api スキルを読んでから書く。

- `AnthropicClient` は DI にシングルトンで登録する。鍵は環境変数 `ANTHROPIC_API_KEY` から SDK が読む
- モデルは設定 `Claude__Model` の 1 か所で決める。既定は `claude-opus-5-5`。日付のついた ID は使わない
- 役割ごとの呼び方（effort はどれだけ考えさせるかの設定。値は Claude の判断で、評価の結果を見て直す）

| 役割 | 呼び方 | effort |
|---|---|---|
| 聞き手の返答 | ストリーミング（`client.Messages.CreateStreaming`） | low（会話の速さを優先） |
| 判定（核となる行動の確認） | 構造化出力（決まった形の JSON で受け取る。`OutputConfig.Format` に `JsonOutputFormat`）。ストリーミングしない | medium（返答が出始めるまでの待ち時間を短くするため。評価で褒めすぎや取りこぼしが出たら high に上げる） |
| 5 つの記録の推し量り | 構造化出力 | medium |
| 仕事の選択肢（3 枚のカード） | 構造化出力 | high |
| 選んだ案を深める | 構造化出力 | high |
| 評価の判定役 | 構造化出力 | high |
| 汎用の AI との比較（評価だけ） | 特別な指示のない呼び出し。同じモデル | medium（既定） |

- 送ってから返答が出始めるまでの目安は 5 秒以内（Claude の判断）。評価のときに測り、結果に残す

- **コードが決めて、AI が言葉にする**（Claude の判断）。1 往復ごとに、まず判定（核となる行動の確認）を構造化出力で受け取る。次にすること（根拠ありにする、足りない行動を聞く、別の場面を聞く）はコードが決める。聞き手の AI には、決まった次の一手だけを渡して言葉にさせる。こうすると、製品の芯 1（根拠のない力は出さない）と芯 2（突き放さない）をコードで守れ、単体テストで確かめられる
- **引用はコードで照らし合わせる**。候補の根拠の引用が本人の発言に一字一句含まれるかを確かめ、含まれなければ候補にしない
- **生活の条件と登録した職種はコードで守る**。仕事のカードの構造化出力に週あたりの時間と場所を持たせ、入力の範囲を超える案はコードで落とす。「選ぶ」「組み合わせる」は、登録した職種と業務の ID で受け取り、登録にないものはコードで落とす。時間帯も構造化出力に持たせるが、こちらは評価で確かめる
- 拒否（AI が応答を断ること）への備え: Opus 5.5 では server-side fallback を既定で有効にする（`fallbacks: "default"`、beta `server-side-fallback-2026-07-01`）。断られたときだけ、Anthropic が断りの種類に応じて選ぶ別のモデルが代わりに答える。`stop_reason` が `refusal` のままなら、画面に穏やかな言葉を出す
- プロンプトキャッシュ（同じ前置きを使い回して費用と待ち時間を減らす仕組み）: システムプロンプトは固定し、`cache_control` を付ける。日時など毎回変わるものはシステムプロンプトに入れない
- テストでは Claude を呼ばない。呼び出しはインターフェースの裏に置き、テストでは偽物に差し替える。本物を呼ぶのは評価だけ
- 送ると 400 エラーになるもの（Opus 5.5）: thinking を無効にする設定、`budget_tokens`、`temperature`・`top_p`・`top_k`、assistant の先読み入力（prefill）、`tool_choice` の `any`・`tool`。JSON がほしいときは構造化出力を使う

費用の見込み（Claude の判断。実際の使用量で直す）:

| 使い方 | 見込み |
|---|---|
| 会話 1 往復（確認と返答の 2 回の呼び出し） | 約 $0.06 |
| 利用 1 回（15 往復） | 約 $1 |
| 評価 1 回（20 件。汎用の AI との比較を含む） | 約 $12 |
| 期間中の合計（試用 60 回、審査員 30 回、開発中の試し 50 回、評価 20 回） | 約 $380（$500 のうち） |

余裕が大きくないので、使った額を毎日 `docs/superpowers/progress.md` に書く。製品の中では、すべて Claude Opus 5.5 を使う。使った額が見込みを超えそうになったら、評価の判定役だけを Claude Sonnet 5.5（`claude-sonnet-5-5`）に下げる。

## 画面の決まり

- スマホを先に考える。幅 375px で崩れず、PC でも読みやすい幅に収める
- 文言は日本語で、`src/web/src/copy.ts` にまとめる。「診断」「判定」「スコア」は使わない
- AI の返答は、`fetch` で受けたストリームを少しずつ表示する（POST なので `EventSource` は使わない）
- 状態は React の state と context で持つ。Redux などの状態管理ライブラリは入れない
- 見た目の確かめは、Playwright MCP（Claude Code から実際のブラウザを動かす道具）で画面を開いて行う

## ログインとデータ

- 本番は Container Apps の組み込み認証（Google）。ログイン前の案内の画面を見せるため、組み込み認証は未ログインの人も通す設定にし、案内の画面以外（`/api` と、ログインが要る画面）はアプリがログインを求める（Claude の判断）
- 裏側は、組み込み認証が付けるヘッダー（`X-MS-CLIENT-PRINCIPAL` など）から、ログインした人の ID を知る。外から同じ名前のヘッダーを送って偽れないことを、microsoft-learn で確かめてから使う
- 開発とテストでは、偽のログインに差し替える。差し替えは Development 環境でだけ有効にする
- ログインした人の ID は、`Auth__UserKeySecret` を鍵にした HMAC-SHA256（鍵を使って元に戻せない値に変える方法）で変換してから使う（Claude の判断）。メールアドレスと名前は読まず、保存しない
- Cosmos DB for NoSQL の無料枠を使う。データベース 1 つ、コンテナ（Cosmos DB のデータの入れ物）1 つで、パーティションキー（データを分けて置く基準）は `/userKey`。アイテムの種類は `type` で分ける（Claude の判断）
- 自動で消す: コンテナの TTL（決まった時間で自動に消す設定）を有効にし、各アイテムの `ttl` を 30 日にする（Claude の判断）。その人がその日に初めて使ったときに 1 回だけ、その人のアイテムの `ttl` を延ばす（Claude の判断）
- 全部消す: その人のパーティションキーのアイテムをすべて消す
- 接続はマネージド ID で行う。Cosmos DB のキーでの接続は無効にする
- テストはインメモリの保存先を使う。手元で動かすときも、Cosmos DB を用意しなければインメモリで動く

## Azure の構成

開発者が作ったリソースグループ（Azure のリソースをまとめる入れ物）の中に、`infra/main.bicep` で次を作る。

- Container Apps の環境と Container App（従量課金。使われないときは 0 台まで減らす）
- Cosmos DB（無料枠）
- Key Vault（`anthropic-api-key`、`user-key-secret`、`google-client-secret` を置く）
- ユーザー割り当てマネージド ID を 2 つ。アプリ用（Key Vault の鍵を読み、Cosmos DB を読み書きする）と、GitHub Actions 用（デプロイし、評価のために Key Vault の鍵を読む）
- Log Analytics（Container Apps のログ）

- コンテナのイメージは GitHub Container Registry（`ghcr.io`、公開）に置く。Azure Container Registry は月額がかかるので使わない（Claude の判断）
- Container App の secret から Key Vault を参照し、環境変数としてアプリに渡す
- GitHub Actions は OIDC（鍵を保存せずに、その場かぎりの証明でログインする仕組み）で Azure にログインする。GitHub Actions 用のマネージド ID にフェデレーション資格情報を付ける。GitHub の secrets に Azure の鍵も Claude の鍵も置かない

## テストとデプロイ（GitHub Actions）

| ファイル | いつ | 何をする |
|---|---|---|
| `ci.yml` | PR と push | 裏側のビルドとテスト、画面のビルドとテスト、フックのテスト |
| `deploy.yml` | main への push | イメージを作って `ghcr.io` に push し、Container App を更新する。公開 URL で応答を確かめる |
| `evals.yml` | 手動 | OIDC で Key Vault から Claude の鍵を読み、評価を回す |

評価は、ふだんは VM で回して結果をコミットする。`evals.yml` は、開発者が手動で回すためのもの（Claude の判断）。

## 迷ったとき

| 調べたいこと | 使うもの |
|---|---|
| .NET、ASP.NET Core、Azure、Bicep | microsoft-learn MCP |
| React、Vite、Tailwind CSS、shadcn/ui、Vitest、Playwright | context7 MCP |
| Claude API と C# SDK | claude-api スキル |
| 画面の見た目と動き | playwright MCP |

## やらないこと

- 画面と API を別のサーバーに分けない
- Next.js、Blazor、Redux、Entity Framework Core、Semantic Kernel、LangChain は使わない
- Azure OpenAI や Microsoft Foundry 経由で Claude を呼ばない（配布のクレジットが使えない）
- Azure Container Registry は使わない
- 鍵を、リポジトリにも GitHub の secrets にも置かない

## 受け入れ基準

- tech-1（同じコマンドで作れる）: 「コマンド」の表のコマンドが、Windows と Linux の両方で通る
- tech-2（鍵を置かずに動く）: リポジトリにも GitHub の secrets にも鍵がない状態で、デプロイと評価が動く
- tech-3（作り直せる）: `infra/main.bicep` から、Azure の環境を作り直せる。手作業は次だけにする
  - 最初の 1 回の `az deployment group create` は、開発者かエージェントが流す（GitHub Actions 用の ID も `main.bicep` が作るため）
  - Google 側のログイン用のアプリ（OAuth クライアント）は開発者が作り、同意画面を「本番」として公開する
  - Key Vault の `anthropic-api-key` と `google-client-secret` の値は、開発者が入れる。`user-key-secret` は、エージェントが乱数から作って入れてよい
  - `ghcr.io` のイメージが非公開で作られたら、一度だけ公開にする

## 評価との対応

- 評価のアプリ（`evals/Revalue.Evals`）は、製品と同じプロンプト（`Ai/Prompts/`）と同じ判断のコードを使う
- 結果は `evals/results/<日付>-<まとまり>.md` に、合格基準の項目ごとの数字で残す。呼び名はタイトルとセットで書く
