# ペルソナで通して試す

手元で動かした RE:VALUE を、架空のペルソナ（利用者の人物像）として最初から最後まで使うための、サーバーの動かし方と API の使い方。

台本の評価（`evals/episodes/` と `evals/criteria.md`）とは役割が違う。

- **台本の評価:** 答えを 1 行ずつ決めた台本を流す。同じ答えで何度でも再現でき、数を数えて合否を出す
- **ペルソナで通して試す:** AI の問いに合わせて、ペルソナがその場で答える。台本では拾えない、やりとりの流れの中の問題を見つける

ペルソナで問題が見つかったら、それを再現する台本を `evals/episodes/` に 1 本足す。そうすると、直ったかと、ほかが崩れていないかを、同じ条件で確かめられる。ペルソナの数だけ台本を作る必要はない。

公開版ではなく手元で行うのは、ペルソナの数だけ Google のアカウントを用意できず、自動で回しにくいため。手元の開発用の設定（Development）では、ログインが偽物になり、名前を変えるだけで別の人として使える。

決まった回し方は、下の「0. ペルソナ評価を回す」にある。ほかの人物や回し方で試すときは、「1. サーバーを動かす」と「2. API」の手引きだけを使ってもよい。

| ファイル | 中身 |
|---|---|
| `README.md` | この文書 |
| `people/` | 6 人の人物（すべて架空） |
| `how-to-play.md` | 演じ方。演じる役（人物を演じる AI）だけが読む |
| `how-to-judge.md` | 評価の見方。演じる役には渡さない |
| `driver/` | 画面を動かす道具（人ごとにブラウザを分け、通信と画面を記録する）と、機械で確かめるスクリプト |
| `revalue-client.mjs` | API を呼ぶ小さな道具（Node.js 24）。ログイン、答えの送信と返事の読み取り、保存された中身をまとめて読む |
| `smoke.mjs` | 道具が動くかを 1 往復で確かめる例（本物の AI を 1 回呼ぶ。約 $0.06） |
| `.run/` | 回ごとの記録（画面の写真、通信）と、サーバーの書き出し（`server/`）と出力（`server.log`）。git に入れない |

## 0. ペルソナ評価を回す

このリポジトリ（revalue-app）で開いた Claude Code のセッションで、「ペルソナ評価を回して」と言う（スキル `persona-eval`。Claude Code が従う手順書）。人を絞るときは「A と B だけ」のように言う。

1. セッションが鍵を確かめ、サーバー（`driver/serve.mjs`）と、画面を動かす道具（`driver/daemon.mjs`）を起動する
2. Workflow `persona-eval`（AI のエージェントを決まった順に動かすスクリプト）が、演じる役（`.claude/agents/persona-player.md`）を人ごとに 1 体ずつ動かす。演じる役が読むのは、自分の人物ファイルと `how-to-play.md` だけ
3. 評価する役（`.claude/agents/persona-reviewer.md`）が、人ごとの結果を書く。記録の全文と、機械で確かめた結果（`driver/check.mjs`）を、`how-to-judge.md` に照らす
4. まとめる役が、前の回と比べたまとめを書く
5. 結果は `evals/results/<日付>-persona.md`（まとめ）と `evals/results/<日付>-persona/<人物ファイルの名前>.md`（人ごとの入力と結果。例: `a-madoka.md`）。架空の記録なので公開する
6. 開発者がまとめを読み、直すものを決める。直す候補は、発見した時点では直さない

費用は 6 人で 1 回 $7 くらい。書き方は「3. 守ること」の使った額のとおり。

### 6 人

6 人は、2026-11-04（開発期間中）に PRD をもとに Claude が書いた架空の人物。当事者の感覚で確かめたものではない。

| 人 | 暮らし | 条件（時間帯、週の時間、場所、月の収入の目安） | 主に確かめること |
|---|---|---|---|
| [A まどか](people/a-madoka.md)（37） | 育児で 5 年離職。元営業事務。「私には何もない」 | 日中と夜、週 10、家、月 5 万 | デモの筋が通るか（基準になる人） |
| [B ふみ](people/b-fumi.md)（44） | 13 年離職。職歴 3 年。答えがとても短い | 夜だけ、週 3、家、収入は未定 | 追い詰めないか。保留のままレポートまで行けるか |
| [C 健一](people/c-kenichi.md)（54） | 父の介護で 3 年離職。元品質管理の男性 | 日中と夕方、週 20、外も可、月 10 万 | 育児を前提にしないか。結果が悪い話を認めるか |
| [D 玲奈](people/d-reina.md)（41） | 3 年離職。元プロジェクトマネージャー。AI を疑っている | 朝と日中、週 20、家、月 20 万 | 一般論と挑発に流されないか。訂正と本人の案を尊重するか |
| [E さやか](people/e-sayaka.md)（34） | ひとり親。4 年離職。元店長。収入が急ぎ | 日中と夕方、週 30、外も可、月 15 万 | つらい話の扱い。続きから話せるか。全部消せるか |
| [F リン](people/f-rin.md)（39） | ベトナム出身、7 年離職。元ホテルフロント。日本語が第二言語 | 夜だけ、週 5、家、月 3 万 | 言葉が届くか。本人の言葉をそのまま引くか。カードが 1 枚でも進めるか |

C と F は、初めの対象（育児でキャリアを中断した女性）の外か端にいる人。PRD の「性別に依存させない」と、ハッカソンのテーマ「本来、誰にでも届くべきものを。」から入れた。

### 決めたこと

| 決めたこと | 外した案 | 理由 |
|---|---|---|
| 演じる役と評価する役を分ける | 1 体で両方する | 物差し（力ごとの核となる行動がそろったかを見る基準）を知っていると、足りない行動を先回りして話してしまうため |
| 実際の画面を、人ごとに分けたブラウザで動かす | API だけで通す | 画面に出る決まった言葉、表示のはみ出し、迷う場所も見るため |
| 演じる役は Sonnet、評価とまとめは Opus | すべて同じモデル | 演じる回数が多く、費用を抑えるため。評価は製品の芯（`docs/prd/README.md`）に照らす判断なので、強いモデルにする（Claude の判断） |
| 結果は公開する | 手元だけに置く | 人物も記録も架空。芯に反する振る舞いが出た記録も、直した経緯として残す（開発者、2026-11-05） |

演じる役は、画面を動かすのにシェルを使う。そのため、評価の見方やソースコードを読むことは仕組みでは止められず、「読まない」という指示に頼っている。評価する役は、演じる役が人物ファイルにない行動を足していないかを見る。足していれば、その段階の評価を割り引く。

### 結果の記録

| 日 | 結果 |
|---|---|
| 2026-11-04 | [まとめ](../results/2026-11-04-persona.md)、[人ごと](../results/2026-11-04-persona/)。構想用の別のリポジトリから回し、このリポジトリへ移した |

## 1. サーバーを動かす

サーバーを動かす人（開発者か、別の Claude Code のセッション）と、使う人を分けてよい。分けたときは、使う側は自分でサーバーを起動しない（ポートがぶつかる）。

いちばん手早いのは `node evals/personas/driver/serve.mjs`。鍵の確かめ、画面のビルド、書き出し（`dotnet publish`）、起動、本物の AI が返事をしているかの確かめ（1 往復、約 $0.06）を、一度に行う。「準備ができました」と出たあとは、止めるまで動き続ける。

- 前の書き出しをそのまま使うときは、`--skip-build` を付ける
- git の作業ツリー（worktree。同じリポジトリを別のフォルダに取り出したもの）から動かして、その作業ツリーに `.env` がなければ、メインの作業ツリーの `.env` を読む

下の「鍵」と「起動」は、同じことを手で行うときの手順。

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
- 使った額は、main ブランチの `docs/superpowers/progress.md` の「使った額」に、回すたびに日付つきで書く（見積もりと書く）。目安は、話す 1 往復で約 $0.06、1 人を通しで流すと約 $1
- 送れる回数の上限は、1 人 1 日 100 回、全体で 1 日 1000 回。数えた回数は、再起動で 0 に戻る。全体の上限は費用の歯止めなので、上げたいときは開発者に相談する（環境変数 `Limits__MessagesPerDayTotal`）
