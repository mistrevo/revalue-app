# ペルソナで通して試す

手元で動かした RE:VALUE を、架空のペルソナ（利用者の人物像）として最初から最後まで使うための、サーバーの動かし方と API の使い方。

台本の評価（`evals/episodes/` と `evals/criteria.md`）とは役割が違う。

- **台本の評価:** 答えを 1 行ずつ決めた台本を流す。同じ答えで何度でも再現でき、数を数えて合否を出す
- **ペルソナで通して試す:** AI の問いに合わせて、ペルソナがその場で答える。台本では拾えない、やりとりの流れの中の問題を見つける

ペルソナで問題が見つかったら、それを再現する台本を `evals/episodes/` に 1 本足す。そうすると、直ったかと、ほかが崩れていないかを、同じ条件で確かめられる。ペルソナの数だけ台本を作る必要はない。

公開版ではなく手元で行うのは、ペルソナの数だけ Google のアカウントを用意できず、自動で回しにくいため。手元の開発用の設定（Development）では、ログインが偽物になり、名前を変えるだけで別の人として使える。

**ペルソナの書き方、ペルソナを AI に演じさせる方法、試した結果の残し方は、使う側で決める。** ここにある道具も、使っても使わなくてもよい。

| ファイル | 中身 |
|---|---|
| `README.md` | この文書 |
| `revalue-client.mjs` | API を呼ぶ小さな道具（Node.js 24）。ログイン、答えの送信と返事の読み取り、保存された中身をまとめて読む |
| `smoke.mjs` | 道具が動くかを 1 往復で確かめる例（本物の AI を 1 回呼ぶ。約 $0.06） |

## 1. サーバーを動かす

サーバーを動かす人（開発者か、別の Claude Code のセッション）と、使う人を分けてよい。分けたときは、使う側は自分でサーバーを起動しない（ポートがぶつかる）。

### 鍵

リポジトリ直下の `.env` に置く。`.gitignore` と `.dockerignore` で除外している。アプリは `.env` を自分では読まないので、起動するときに環境変数として読み込ませる。

```
ANTHROPIC_API_KEY=<Claude API の鍵>
```

### 起動

ビルドしたものを、リポジトリの外のフォルダに書き出して動かす（Claude の判断）。Windows では、`dotnet run` で動かしている間はビルドの結果がロックされる。そのあいだ、別のセッションの `dotnet build` や `dotnet test` が失敗する。

```sh
npm --prefix src/web ci
npm --prefix src/web run build
dotnet publish src/Revalue.Server -c Release -o <書き出し先>

# <書き出し先> で動かす。.env はメモ帳で作ると BOM と CRLF が付くことがあるので取り除いて読む
cd <書き出し先>
set -a; . <(sed '1s/^\xEF\xBB\xBF//' <リポジトリ>/.env | tr -d '\r'); set +a
ASPNETCORE_ENVIRONMENT=Development ASPNETCORE_URLS=http://localhost:5080 dotnet Revalue.Server.dll
```

- `localhost` だけで待ち受ける。開発用の設定はログインが偽物なので、外から届く場所に出さない
- データはメモリだけに置く。**再起動するとすべて消える**
- 動いているかは `GET http://localhost:5080/api/health` で確かめる。鍵が読めていないと AI も偽物になり、返事が「（開発用の決まった返事）」で始まる
- コードを直したら、画面のビルド、書き出し、起動をやり直す。動くのは、そのとき `<リポジトリ>` でチェックアウトしているコード

## 2. API

ログインの名前（`dev_user`）ごとに、別の人として扱われる。名前は英数字とハイフンで 64 文字まで。同じサーバーで何回も流すときは、回ごとに名前を変えると混ざらない。

| 段階 | 呼び方 |
|---|---|
| ログイン | `GET /.auth/login/google?dev_user=<名前>` でクッキー `revalue_dev_user` を受け取る |
| 了解（保存するものと使い道への同意） | `POST /api/consent` に `{"version":"2026-11-03-2"}` |
| 話を始める | `POST /api/episodes` に `{}`。id と最初の問いが返る |
| 答える | `POST /api/episodes/{id}/messages` に `{"text":"…","kind":"free"}`。選択肢から選ぶときは `"kind":"choice"` で選択肢の文をそのまま送る |
| 話を区切る | `POST /api/episodes/{id}/finish` |
| 5 つの記録 | `PUT /api/profile/conditions`（条件）、`/preferences`（好み）、`/wants`（やりたいこと）、`/agency`（主体性）。残りのできることは、見えた力から作られる |
| 見えた力 | `GET /api/abilities` |
| 仕事の選択肢 | `POST /api/options` で 3 枚のカード（選ぶ、組み合わせる、創るの 3 つの道）を作る（AI を呼ぶ）。選ぶときは `PUT /api/options/choice` |
| 選んだ案を深める | `POST /api/deepen` で作る（AI を呼ぶ）。答えは `PUT /api/deepen/answers/{questionId}`、一歩は `PUT /api/deepen/steps`。「創る」と自分の案のときは、業務の見立てを `PUT /api/deepen/tasks` で直せる |
| レポート | `GET /api/report` |

- 答えの返事は Server-Sent Events（サーバーから少しずつ届く形）で届く。`delta`（返事の一部）、`choices`（選択肢）、`notice`（つらい状態のサインへの言葉と相談先）、`error`（失敗）、`done`（終わり）。返事は 5〜10 秒ほどかかる
- 1 つの場面（`POST /api/episodes` で始めた一つの話）は 8 往復まで
- 本文の形は `src/Revalue.Server/Features/<まとまり>/*Endpoints.cs` の `record ...Request` が正
- 「話を区切る」「カードを選ぶ」と、「選んだ案を深める」の業務の見立て、答え、一歩は、この文書を書いたときにはまだ通していない（2026-11-04）
- Git Bash の `curl -d` に日本語を直接書くと文字化けして 400 になる。curl を使うなら、本文を UTF-8 のファイルにして `--data-binary @ファイル` で送る
- 画面で使うときは、ブラウザで `http://localhost:5080/.auth/login/google?dev_user=<名前>` を開く。その名前でログインした画面になる

### 本文の形

```jsonc
// PUT /api/profile/conditions（値は GET /api/profile の conditionOptions から選ぶ。外れると 400）
{ "timeSlots": ["morning", "daytime", "evening", "night" から選ぶ],
  "hoursPerWeek": 1|3|5|10|15|20|30|40,
  "place": "homeOnly" | "canGoOut",
  "monthlyIncome": 1|3|5|8|10|15|20 }          // 万円。null は「まだ決めていない」

// PUT /api/profile/preferences と /wants（選択肢は GET /api/profile の questions）
{ "entries": [ { "text": "自分のペースで進められる", "source": "chosen" },
               { "text": "自分で書いた言葉", "source": "written" } ] }

// PUT /api/profile/agency
{ "text": "自分で書いた言葉" }

// PUT /api/options/choice（generatedAt は GET /api/options の cards.generatedAt をそのまま）
{ "kind": "card", "card": "choose" | "combine" | "create", "generatedAt": "..." }
{ "kind": "hold" }
{ "kind": "own", "ownJobId": "..." }            // 先に POST /api/options/own に { "title", "note" }

// PUT /api/deepen/answers/{questionId}（generatedAt は GET /api/deepen の content.generatedAt）
{ "text": "...", "fromChoice": true | false, "generatedAt": "..." }

// PUT /api/deepen/steps
{ "chosen": ["一歩の id", ...], "own": ["自分で書いた一歩", ...], "generatedAt": "..." }

// PUT /api/deepen/tasks（「創る」と自分の案のときだけ。ほかは 409。名前と力は必須）
{ "tasks": [ { "name": "...", "detail": "...", "ability": "noticing" | "coordinating" | "prioritizing", "knowledge": "..." } ],
  "generatedAt": "..." }
```

仕事の選択肢へ進めるかは、`GET /api/options` の `readiness` で分かる。`needsConditions`（条件がまだ）→ `needsFinishedEpisode`（区切った場面がまだ）→ `needsAbility`（使える力がまだ）→ `ready`（進める）の順に進む。「選んだ案を深める」へ進めるのは、`GET /api/deepen` の `readiness` が `ready` になってから。

力は 3 つ。見立てる力（`noticing`）、調整する力（`coordinating`）、優先順位をつける力（`prioritizing`）。状態は `notYet`（まだ聞けていない）、`needsCheck`（要確認）、`confirmed`（根拠あり）。

### 道具

```js
import { login } from './revalue-client.mjs';

const c = await login('p01-r1');
await c.consent();
const ep = await c.startEpisode();
const r = await c.send(ep.id, '昨日は…', 'free');   // r.reply、r.choices、r.notices、r.error、r.ms
await c.put('/api/profile/conditions', { timeSlots: ['daytime'], hoursPerWeek: 10, place: 'homeOnly', monthlyIncome: 5 });
const snap = await c.snapshot();   // 話した場面、力、5 つの記録、カード、深める、レポートをまとめて返す
```

## 3. 守ること

使い方は使う側で決めてよいが、次はリポジトリの決まり（`CLAUDE.md`）なので守る。

- **ペルソナも、試した結果も架空にする。** 実在の人の名前、実在しうる連絡先、開発者の名前は入れない。フック `guard.mjs` に止められたら、回避せず中身を架空に直す
- **AI の言い方は、AI 同士の判定だけで確定しない。** 言い方の指摘は、開発者が確かめる項目として `docs/superpowers/progress.md` に残す
- 不合格にする振る舞いの例は `CLAUDE.md` の「評価」にある。合格の数字は `docs/prd/6-quality.md`、言葉の決まりは `docs/specs/00-common.md`
- 見つけた問題を直すときは、ブランチを切り、Spec とコードを同じコミットで変える。直したら、サーバーを動かす人に、画面のビルドからやり直して起動してもらう。動くのはそのときチェックアウトしているコードなので、直したブランチをチェックアウトしたままにしておく
- 使った額は `progress.md` の「使った額」に日ごとに書く。目安は、話す 1 往復で約 $0.06、1 人を通しで流すと約 $1
- 送れる回数の上限は、1 人 1 日 100 回、全体で 1 日 1000 回。数えた回数は、再起動で 0 に戻る。全体の上限は費用の歯止めなので、上げたいときは開発者に相談する（環境変数 `Limits__MessagesPerDayTotal`）
