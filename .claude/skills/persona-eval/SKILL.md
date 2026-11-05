---
name: persona-eval
description: 「ペルソナ評価を回して」と頼まれたとき、またはプロンプトや聞き方を直したあとに、架空の 6 人で手元の RE:VALUE を最初から最後まで通して確かめるときに使う。「A と B だけ」のように人を絞ってもよい。
---

# ペルソナ評価を回す

架空の人物（`evals/personas/people/`）を AI に演じさせ、手元の RE:VALUE を画面から最後まで使い、評価の見方（`evals/personas/how-to-judge.md`）に照らして結果を書く。開発者がこのスキルを呼んだことが、Workflow `persona-eval` を動かす同意になる。

台本の評価（`evals/episodes/`）とは役割が違う。ペルソナで問題が見つかったら、再現する台本を `evals/episodes/` に 1 本足すと、直ったかを同じ条件で確かめられる。

## 1. 準備（メインのセッションで）

1. **回すコードを決める。** いまチェックアウトしているコードが動く。開発者が別のブランチを指したら、そのブランチにする。main なら `change/<日付>-persona-eval` を main から切る（結果をコミットするため）
2. **人を決める。** 指定がなければ a〜f の 6 人。費用は 1 人 $1 くらい（6 人で $7 くらい）
3. **回の名前を決める。** `<日付>-r<番号>`。`evals/personas/.run/` にない、いちばん小さい番号
4. **前の道具が残っていないか。** `http://localhost:5080/api/health` と `http://127.0.0.1:5199/` に届いたら、前の回のサーバーか道具が動いている。止めてよいかを確かめてから止める
5. **道具を入れる。** `evals/personas/driver/node_modules` がなければ `npm --prefix evals/personas/driver ci`。ブラウザがなければ `npx --prefix evals/personas/driver playwright install chromium`
6. **サーバーを起動する。** `node evals/personas/driver/serve.mjs` をバックグラウンドで動かし、「準備ができました」が出るまで待つ。「【止めました】」が出たら、その理由を開発者に伝えて止める（鍵がない、偽の AI、ポートが使用中）
7. **画面を動かす道具を起動する。** `node evals/personas/driver/daemon.mjs <回>` をバックグラウンドで動かし、「ready」が出るまで待つ

## 2. Workflow を呼ぶ

```
Workflow({ name: 'persona-eval', args: { run, date, people, previous, commit } })
```

- `previous` は、`evals/results/` にある、いちばん新しい `*-persona.md`（なければ null）
- `commit` は `git rev-parse --short HEAD`
- Workflow が動いているあいだ、サーバーと道具を止めない。作業ツリーのファイルも触らない

## 3. 片付け

1. 道具を止める: `node evals/personas/driver/pw.mjs a shutdown`
2. サーバーを止める（バックグラウンドのタスクを止める）
3. 結果を確かめる
   - `evals/results/<日付>-persona.md` と、人ごとの `evals/results/<日付>-persona/<名前>.md` ができている
   - `node evals/personas/driver/check.mjs <回>` の引用の不一致と使わない言葉が 0 か。0 でなければ、まとめに書かれているかを見る
   - `git status` で、`evals/personas/.run/` が入っていない
4. 使った額を、main の `docs/superpowers/progress.md` の「使った額」に書く（見積もりと書く）
5. 結果をコミットして push し、PR を出す。CI が通ったらマージする

## 4. 報告

日本語で、呼び名は必ずタイトルとセットで書く。順に、いちばん大事なこと、前の回との違い、直す候補（重い順）、開発者に確かめてほしい言い方、結果のファイルへのリンク。直す候補は直さずに報告し、直すかは開発者に決めてもらう。

## よくある間違い

| 間違い | 正しくは |
|---|---|
| 演じる役に、評価の見方や PRD を読ませる | 人物ファイルと演じ方だけ。物差しを知ると、足りない行動を先回りして話す |
| 偽の AI のまま回す | serve.mjs が止める。止まったら、鍵を確かめてもらう |
| 6 人を同じログイン名で回す | 道具が人ごとに `persona-<人>-<回>` でログインする。回の名前を毎回変える |
| 見つけた問題をその場で直す | 直さずに報告する。直すのは開発者が決めてから |
| 物差しどおりの読み取りを「違反」と書く | 本人が納得しなかっただけなら「線引き」と書く |
