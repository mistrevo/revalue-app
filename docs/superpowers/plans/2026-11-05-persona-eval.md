# ペルソナ評価をこのリポジトリで回す Implementation Plan

> **For agentic workers:** メインのセッションが、別の作業ツリー（`change/2026-11-05-persona-eval`）で直接作る。順番 2 の Workflow がメインの作業ツリーを使っているため。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** revalue-app のセッションに「ペルソナ評価を回して」と言うだけで、サーバーの起動、6 人の演技、機械での確かめ、評価、まとめまでが回り、前の回と比べられるようにする。

**Architecture:** 画面の操作は、人ごとにブラウザの文脈を分けた常駐の道具（`evals/personas/driver/`）が受け持つ。演じる役は、その道具に操作を送るだけ。スキル `persona-eval` が、サーバーと道具の起動・停止をメインのセッションで行い、あいだの「演じる → 評価する → まとめる」を Workflow `persona-eval` で回す。

**Tech Stack:** Node.js（ES モジュール）、Playwright（chromium）、Claude Code のスキル・エージェント・Workflow

**Spec:** 設計 `docs/superpowers/specs/2026-11-05-persona-eval-and-listening-design.md` の「2. ペルソナ評価をこのリポジトリで完結させる」

## Global Constraints

- 公開リポジトリ。実在の人の名前、開発者の名前、開発者の家族を指す「提案者」「奥さま」を書かない。架空の人物の会話に出る「奥さま」はそのまま
- ファイル名は英語の小文字とハイフン（人物は `a-madoka.md` など）
- 画面の写真、通信の記録、サーバーの書き出しは `evals/personas/.run/` に置き、git に入れない
- 演じる役が読むのは、自分の人物ファイルと `how-to-play.md` だけ。評価の見方、PRD、Spec、ソースコードは読ませない
- エージェントは 1 回の Workflow で 10 体未満（演じる役 6、評価する役 2、まとめる役 1）
- 鍵は値を表示せずに確かめる。偽の AI（返事が「（開発用の決まった返事）」で始まる）なら止める
- 費用は 6 人で 1 回 $7 くらい。回すたびに progress.md の「使った額」に書く

## Review Focus

- 前の回の道具が残っている（ポート 5199 や 5080 が使用中）: 起動の前に気づいて止める。黙って古いサーバーに当てない
- 演じる役が人物ファイルにない行動を足した: 評価する役が見つけ、その段階の評価を割り引く
- 人を絞って回した（例: A と B だけ）: 評価する役とまとめる役が、回していない人を「止まった」と書かない
- 画面に「Google でログイン」がある: 道具がその人の名前で偽のログインをする。ほかの人のログインと混ざらない
- 返事が 2 分を超えて返らない: 道具が打ち切り、その旨を記録に残す

---

### Task 1: 人物、演じ方、評価の見方、11/4 の結果を移す

**Files:**
- Create: `evals/personas/people/{a-madoka,b-fumi,c-kenichi,d-reina,e-sayaka,f-rin}.md`、`evals/personas/how-to-play.md`、`evals/personas/how-to-judge.md`
- Create: `evals/results/2026-11-04-persona.md`、`evals/results/2026-11-04-persona/{a-madoka,…}.md`
- Modify: `evals/personas/README.md`（ペルソナ評価の回し方と 6 人の表を足す）

- [ ] 構想リポジトリの評価の文書から写す。書き換えるのは、開発者の名前（→ 開発者）、開発者の家族を指す言葉（→ 当事者の協力者）、非公開のページへのリンク（消す）、PRD の絶対パス（→ `docs/prd/`）、ファイル名とリンク
- [ ] 写したあと、フックのテストを通し、`git diff --cached` を開発者の名前と非公開のリンクで探して 0 件を確かめる
- [ ] コミット

### Task 2: 画面を動かす道具

**Files:**
- Create: `evals/personas/driver/package.json`（`playwright` を固定の版で）、`daemon.mjs`（11/4 の常駐の道具を移す）、`pw.mjs`（操作を送る）、`transcript.mjs`（人ごとの記録の全文を作る）、`check.mjs`（機械で確かめる）、`serve.mjs`（画面のビルド、裏側の書き出し、`.env` を読んで起動、本物の AI の確かめ）
- Modify: `.gitignore`（`evals/personas/.run/`）

- [ ] 11/4 の道具から、決め打ちのパス（npx のキャッシュ、chromium の置き場、構想リポジトリ）を外し、リポジトリの中のパスと引数にする
- [ ] `pw.mjs <人> answers <ファイル>` を足す（使い終えたあとの答えを、演じる役が道具を通して残す）
- [ ] `check.mjs <回> [人...]` を、6 人決め打ちでなく、記録のある人だけに当てる形にする
- [ ] `node evals/personas/driver/serve.mjs` でサーバーが起動し、`node evals/personas/driver/daemon.mjs <回>` のあと `node evals/personas/driver/pw.mjs a start` で最初の画面の文字が返ることを確かめる
- [ ] コミット

### Task 3: 演じる役、評価する役、Workflow、スキル

**Files:**
- Create: `.claude/agents/persona-player.md`（道具は Bash だけ。`pw.mjs` で操作する）、`.claude/agents/persona-reviewer.md`
- Create: `.claude/workflows/persona-eval.js`（args: `run`、`date`、`people`、`previous`）
- Create: `.claude/skills/persona-eval/SKILL.md`（準備 → Workflow → 片付け → コミット）
- Modify: `docs/specs/00-tech-stack.md`（置き場所とコマンド）、`evals/criteria.md`（案内）

- [ ] Workflow は、2 つの組（A〜C、D〜F。人を絞ったときはその人だけ）ごとに「演じる 3 体 → 評価する 1 体」を流し、最後にまとめる 1 体
- [ ] まとめる役は、前の回のまとめ（`previous`）と比べた節を書く
- [ ] コミット

### Task 4: A 1 人で通して確かめる

- [ ] スキルの手順で A だけを回す（本物の AI。$1 くらい）。`evals/results/<日付>-persona.md` と `evals/results/<日付>-persona/a-madoka.md` ができ、機械の確かめが通ることを確かめる
- [ ] 確かめの回の結果はコミットしない（道具の確かめで、評価の回ではないため）。使った額を progress.md に書く
- [ ] PR を出し、CI を通して main に入れる

## 確認コマンド

1. `node --test .claude/hooks/guard.test.mjs` — PASS
2. `node evals/personas/driver/check.mjs <回> a` — 引用の不一致 0、使わない言葉 0
3. `git ls-files evals/personas/.run` — 空
