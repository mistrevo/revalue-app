---
name: run-plan
description: 計画（docs/superpowers/plans/ の .md）ができて実行に移るときに使う。まとまりの計画、Spec の変更計画、一括の変更の計画のどれでも使う。writing-plans が実行方法を尋ねてきたときも、答えを待たずにこれを使う。
---

# 計画を Workflow で回す

計画の実行は、Superpowers の subagent-driven-development や executing-plans ではなく、Workflow（`.claude/workflows/run-plan.js`）で回す。開発者がこのスキルを呼んだこと、または開発者が呼んだ build-unit から使われたことが、Workflow を動かす同意になる。

## 1. 準備（メインのセッションで）

1. 計画を読み、関係する Spec（`docs/specs/`）と、受け入れ基準の呼び名をタイトルつきで集める。`00-common.md` と `00-tech-stack.md` は、いつも specs に含める
2. 作業ツリーがきれいなことを確かめ、ブランチを `main` から切ってチェックアウトする。まとまりの作業は `unit/<番号>-<名前>`、それ以外は `change/<日付>-<テーマ>`
3. 計画のタスクを、チェックボックスが `[ ]` のものだけ、まとまり（taskGroups）に分ける
   - 1 つのまとまりは、1 体のエージェントが続けて実装できる量（タスク 2〜4 個が目安）
   - 1 回の Workflow で 3 まとまりまで。超えるなら Workflow を複数回に分ける（エージェントを 10 体未満に収めるため）
   - プロンプトや判定の作り込みなど重いまとまりには `heavy: true`
4. 確認コマンド（verify）を計画から取る。計画になければ、あるものだけを並べる（`dotnet test`、画面のビルドとテスト、評価）
5. AI が利用者に話す言葉（プロンプト、画面の文言、評価）に関わるなら `touchesVoice: true`

## 2. Workflow を呼ぶ

```
Workflow({ name: 'run-plan', args: { plan, specs, branch, baseBranch: 'main', criteria, taskGroups, verify, touchesVoice } })
```

args の形はスクリプトの先頭のコメントにある。Workflow が動いているあいだ、メインのセッションでは作業ツリーのファイルを触らない。

## 3. 結果を受けて

- **passed**: superpowers:verification-before-completion に従い、確認コマンドを自分でも実行して結果を見る。通ったら `git switch main && git merge --no-ff <ブランチ>` で入れて push する。デプロイの GitHub Actions があれば `gh run watch` で終わるまで見届ける
- **hold**: main に入れない。ブランチを push し、止まった理由を `docs/superpowers/progress.md` の「保留」に書き、開発者に知らせる（PushNotification が使えればそれで）
- どちらでも、`docs/superpowers/progress.md` を更新する。状態、評価の数字、`forHuman` の項目（「開発者に確認してほしいこと」へ）。コミットして push する

## 4. 報告

日本語で、呼び名は必ずタイトルとセットで書く。順に、通ったこと、直したこと（何回目で）、残したこと、開発者に見てほしいこと。

## よくある間違い

| 間違い | 正しくは |
|---|---|
| writing-plans の「どの方法で実行しますか」に答えを待つ | 待たずにこのスキルで回す |
| 確認の結果を見ずに「完了」と書く | 自分で確認コマンドを実行し、出力を見てから書く |
| 評価が通らないのに main に入れる | hold にして、ほかの作業へ進む |
| 1 回の Workflow にタスクを詰め込む | 3 まとまりまでにして、回数を分ける |
