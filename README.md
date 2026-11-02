# RE:VALUE（リバリュー）

> キャリアには空白があっても、人生に空白はない。

育児などでキャリアを中断した人のための Web アプリです。AI が聞き手になって人生経験を引き出し、根拠のある言葉にして確かめ、生活の条件に合った仕事の一歩につなげます。

Built with Claude: Japan 2026 の提出作品として、2026-11-02 から開発しています。

> **開発中です。** 触り方、評価の結果、Claude の使い方は、作りながらこの README に書き足します。

## できること（予定）

| 段階 | 内容 |
|---|---|
| DISCOVER（発見） | AI が聞き手になり、具体的な一日の出来事を聞き取って保存する |
| VALIDATE（確認） | 「状況・制約・行動・結果」の 4 観点がそろったときだけ、本人の言葉を根拠にした強みの候補を示す。足りないときは、足りない観点だけを聞き返す。候補は本人が編集・却下できる |
| CREATE（仕事の一歩） | 使える時間・場所・収入の目安から、小さなサービスや副業の案と、最初に試す手順を出す |
| CONNECT（つながる） | 近い経験をもつ先輩につなぐ（先輩は架空のサンプルデータ） |

## 触り方

準備中です。公開 URL と、Google アカウントでのログインの手順をここに書きます。

## Claude の使い方

### 製品の中

準備中です。聞き手としての対話、4 観点の確認、仕事案づくりでの使い方を書きます。

### 開発

Claude Code を中心に、ほぼ自動で開発しています。何を作るかは、人が PRD（製品の要件をまとめた文書）で決めます。そこから先は、機能のまとまりごとに AI が Spec（仕様書）を書き、実装・評価して main ブランチに入れます。

| 使ったもの | 何のために |
|---|---|
| Superpowers（プラグイン） | PRD を対話で作る（brainstorming）、計画を書く（writing-plans）、テストから書く（test-driven-development） |
| Workflow（[.claude/workflows/run-plan.js](.claude/workflows/run-plan.js)） | エージェントを決まった順に動かすスクリプト。計画を、実装 → 確認（ビルド・テスト・評価）→ レビュー → 直し（2 回まで、直すたびに強いモデルへ）→ 文書の点検、の順に回す |
| スキル（[.claude/skills/](.claude/skills/)） | build-unit: まとまりを Spec から main まで作り、次へ進む。run-plan: 計画を Workflow に渡す |
| サブエージェント（[.claude/agents/](.claude/agents/)） | doc-reviewer: 人が読む文書を点検して削る。voice-reviewer: 製品の AI の言い方を、褒めすぎ・突き放しの点で点検する |
| フック（[.claude/hooks/](.claude/hooks/)） | 公開リポジトリに鍵（API キーなど）や実在の人の連絡先が入るのを止める。セッションが替わっても続きから始められるよう、進み具合を最初に読ませる |
| MCP（[.mcp.json](.mcp.json)） | Microsoft Learn と Context7 で公式ドキュメントを引く。Playwright で画面を実際に動かして確かめる |

## 持ち込んだデータ

評価に使うエピソード（利用者が AI に話す出来事の例）は、すべて架空です。開発スタート前に作った文章を使う場合は、その旨をここと置き場所（`evals/episodes/`）に明記します。

## リポジトリの構成

| 場所 | 中身 |
|---|---|
| `docs/prd.md` | PRD（何を作るか） |
| `docs/specs/` | 機能のまとまりごとの Spec（いまの正しい姿） |
| `docs/superpowers/` | Superpowers で作った設計と計画（変更の経緯） |
| `docs/decisions/` | 小さな検証で決めたこと |
| `src/` | アプリ（ASP.NET Core と React） |
| `tests/` | 裏側のテスト |
| `evals/` | 架空エピソード集と、AI の振る舞いの評価 |
| `infra/` | Azure のリソースの定義 |
| `.github/workflows/` | テストとデプロイ（GitHub Actions） |
| `.claude/` | Claude Code のスキル・エージェント・フック・Workflow |
