---
name: draw-illustration
description: 挿絵の素材集（SVG）に、新しい素材を描いて足すとき、または既存の素材を描き直すときに使う。アイコン・物・家具・人物のポーズや表情・動物・背景・演出パーツの追加、「素材を増やしたい」「この素材を作り直したい」と依頼されたとき。描いた素材は個人の素材集に入り、望めば共有の素材集へプルリクを出す。資料の中で一度だけ使う絵をその場で描くとき（use-illustration の references/placing.md「描き起こす」）は対象外。
user-invocable: true
argument-hint: [素材名と用途（例: icon-api-gateway API ゲートウェイの概念）]
---

# 挿絵素材を描く

素材集は、並べたときに見分けが付かないことに価値がある。描いた本人の「良くできた」は合格の根拠にならない。**合格を決めるのは、描き手の意図を知らないレビュアーが絵だけを見て出す判定**。

## 場所の求め方

起動した時点で表示される Base directory（`…/skills/draw-illustration`）の **2 つ上がプラグインの場所**。以下の `<プラグインの場所>` はこの絶対パスに置き換える。

- 共有の素材集（読むだけ）: `<プラグインの場所>/assets/illustrations`。規格 `style-guide.md` もここにある
- 個人の素材集（**書き込み先**）: `<ホームの絶対パス>/.claude/ns-illustrations/illustrations`（以下では `~/.claude/ns-illustrations/illustrations` と略す）
- 検品記録: `~/.claude/ns-illustrations/illustrations/reviews/<素材名>/`（`review.md` と PNG）
- 道具: `<プラグインの場所>/scripts/`（`render.mjs`・`weight.mjs`・`register.mjs`・`setup-tools.mjs`）

コマンドに書くときと、利用者やほかのスキルへ場所を伝えるときは、`~` もホームの絶対パスに置き換える（`~` を展開しないシェルや引数の書き方があるため。use-illustration の「呼び出し元へ返す文言」と同じ決まり）。

プラグインの場所を `find` や `installed_plugins.json` で探さない。プラグインのインストール先へ書き込まない（共有の素材を描き直すときも、個人の素材集に同じ名前で置く。同じ名前は個人が優先される）。

## 始める前に

1. **Node を確かめる。** 道具は Node.js 20 以上で動く。`node --version` を実行し、`node` が無いか 20 未満なら、入れ方（https://nodejs.org/ の LTS 版。Windows なら `winget install OpenJS.NodeJS.LTS` でもよい）を利用者に伝えて、ここで止まる。
2. **道具を入れる（初回だけ）。** `node <プラグインの場所>/scripts/setup-tools.mjs`。検品の道具（puppeteer）を `npm install` で `~/.claude/ns-illustrations/tools/` に入れる。入っていれば何もしない。npm とネットワークが要る（失敗したら、その 2 つを確かめるよう利用者に伝えて止まる）。puppeteer が使うブラウザ本体（Chrome for Testing、数百 MB）は、puppeteer が tools/ の外の自分のキャッシュ（既定は `~/.cache/puppeteer`。Windows では `C:\Users\<ユーザー名>\.cache\puppeteer`）へダウンロードすることも、初回に伝えておく。
3. **マージ済みの素材を片付ける。** 個人の素材集の SVG のうち、共有の素材集に同じ名前で、中身もバイト単位で同じものがあれば、プルリクがマージされた素材とみなす。見つかったら、消すかを利用者に聞く。消すと決まったら、その SVG と `reviews/<素材名>/` を消して `node <プラグインの場所>/scripts/register.mjs` を実行する。

## 手順

1. **規格と手本を読む。** `<プラグインの場所>/assets/illustrations/style-guide.md` を全部読む。同じカテゴリの既存素材（共有と個人の両方の `catalog.md` から探す）から 2〜4 点を手本に選び、ソースを読む（影・縁取り・id・`data-part` の書き方を写すため）。手本には、似た概念の素材（取り違えられそうなもの）と、主役の色が同じ素材を 1 点ずつ含める。レビューでも同じ手本と並べる。
2. **規格から外れる必要があれば、描く前に聞く。** 次のどれかに当たるなら、AskUserQuestion で規格どおりの案と外れる案を並べて選んでもらう。外れる案に決まったら、検品記録の `review.md` に逸脱として書く（共有の style-guide.md には書かない。プルリクを出すときに手順 7 で追記する）。
   - 規格を変えたい（例: キャンバスの寸法を変える）
   - 規格どおりに塗ると実物の見た目と食い違う（例: 実物はほぼ白い複合機を、機器の規格どおり device 色で塗る）
   - 似た概念の既存素材と、規格の範囲では描き分けにくい
3. **描く。** 素材は個人の素材集に `<素材名>.svg` で置く。描き直しなら、描き始める前に旧版を `reviews/<素材名>/before/<素材名>.svg` に複製しておく（同じファイル名にするのは、Before の画像のラベルを素材名にするため）（手順 5 の Before/After に使う）。人物の横向きは右向きだけ、表情違いは `-normal`（立ちポーズは顔）だけを描く。左向きと表情違いは手順 6 のスクリプトが作る（style-guide「左向きと表情違い」）。
   - 表情違いは、その名前のファイルが既にあるときだけ作られる。ポーズに新しい表情を足すときは、そのポーズの `-normal` を `-<表情>` の名前で個人の素材集に複製して置く（共有のポーズでも、個人の素材集へ複製する）。顔は同じロール・同じ向きの立ちポーズ（`char-<役>-stand-<表情>`、`char-<役>-stand-side-right-<表情>`）から入る。
   - 立ちポーズにその表情が無ければ、登録が止まる。先に立ちポーズの `-normal` を新しい表情の名前で複製し、顔の部品だけを描き換える。
4. **検品する（合格するまで繰り返す）。**
   1. 機械の検査:
      - `node <プラグインの場所>/scripts/render.mjs ~/.claude/ns-illustrations/illustrations/reviews/<素材名> <新しい素材.svg>... --ref <手本の素材名>...`（`~` は絶対パスに置き換える。物・家具・人物は `--with-person` も付ける）
      - アイコンは `node <プラグインの場所>/scripts/weight.mjs <新しいアイコン.svg>`。終了コード 2（軽い・重い）なら直してから先へ進む
   2. 書き出した画像を自分で見て、明らかな崩れを直す。
   3. **新しい文脈のサブエージェントにレビューさせる。** 依頼文は `reviewer.md` のひな形を埋めて作る。描き手の意図・工夫・自覚している弱点は渡さない。2 回目からは、前の回までの指摘とそれぞれへの対応（直した・反論した）を渡す。
   4. 判定が「要修正」なら直して、i からやり直す。指摘に反論してよいのは、指摘された現象が起きていないことを画像で示せるときだけ。反論も次のレビューに画像ごと渡す。
   5. 「規格との衝突」の印が付いた指摘（規格を守る限り直せない指摘）は、回数を待たずにその場で止めてユーザーに聞く。規格どおりで受け入れるか、規格から外れるかを選んでもらう。
   6. 3 回レビューしても合格しないときは止める。残った指摘と画像をユーザーに見せて判断を仰ぐ。

   レビューのたびに、回数・判定・指摘・対応（直した・反論した）を `reviews/<素材名>/review.md` に追記する。書き方は「検品記録」の節。
5. **ユーザーに見せる。** 合格した sheet と scene の画像（`reviews/<素材名>/` の PNG）をまとめて見せる（描き直しなら、`reviews/<素材名>/before/<素材名>.svg` を、同じ `--ref` を付けた `render.mjs` で `reviews/<素材名>/before/` へ書き出して Before/After にする。Before の画像でも旧版に「（新）」の印が付くので、見せるときに旧版だと添える）。レビューの回数と、直した指摘を一覧で添える。
6. **登録する。**
   - `node <プラグインの場所>/scripts/register.mjs`（左向き・表情違い・個人の素材集の catalog.md・gallery.html を個人の素材集へ書き出す）
   - エラーで止まったら（命名規則・反転できない書き方・顔の元が無い）、直してやり直す。`削除: 共有と同じ派生 <名前>` は、作り直すと共有と同じになった派生を個人の素材集から消したという報告で、異常ではない
   - 新しい部品・トークン・規格からの逸脱は `review.md` に書く（共有の style-guide.md へは手順 7 で足す）
7. **（任意）プルリクを出す。** 利用者が共有の素材集へ入れたいと言ったときだけ行う。fork はせず、ns-skills にブランチを push する。
   1. 作業用のフォルダに `gh repo clone nextscape/ns-skills <作業フォルダ>` で clone し、そこで `git config core.hooksPath .githooks` を実行する。2 回目以降で clone 済みの作業フォルダがあれば、clone せずに `git switch main` と `git pull --ff-only` をしてから次へ進む
   2. `git switch -c feat/illustration-<素材名>`
   3. 個人の素材集から、描いた素材と、表情の置き場として置いた `-<表情>` のファイルを `plugins/ns-illustrations/assets/illustrations/` へ**複製**する（移動しない。マージされてプラグインが更新されるまで、個人の素材集の素材を使い続けるため）。左向きは複製しなくてよい（次の登録で作られる）
   4. `node plugins/ns-illustrations/scripts/register.mjs --shared` を実行し、`node --test plugins/ns-illustrations/tests/catalog.test.mjs plugins/ns-illustrations/tests/variants.test.mjs` が通ることを確かめる
   5. `review.md` に規格からの逸脱・新しい部品・トークンがあれば、`plugins/ns-illustrations/assets/illustrations/style-guide.md` の該当する表に追記する
   6. 検品記録（`review.md` と PNG）を `plugins/ns-illustrations/reviews/<素材名>/` へ複製する。描き直しなら `before/`（旧版の SVG と Before の PNG）も含めて、`reviews/<素材名>/` を丸ごと複製する（プルリクの本文で Before/After を見せるため）
   7. パスを指定してコミットする（`plugins/ns-illustrations/assets/illustrations/` と `plugins/ns-illustrations/reviews/<素材名>/`）。`plugins/ns-illustrations/.claude-plugin/plugin.json` と `.claude-plugin/marketplace.json` には触らない（版はマージする人が上げる）
   8. `git push -u origin feat/illustration-<素材名>` のあと、`git rev-parse HEAD` でコミットの SHA を控える
   9. `gh pr create` で出す。本文には、素材の用途、検品の画像の参照（`https://github.com/nextscape/ns-skills/blob/<SHA>/plugins/ns-illustrations/reviews/<素材名>/<画像>?raw=true` の形。ブランチ名でなく SHA で書くのは、マージ前に reviews/ を消すコミットを積んだ後やブランチを消した後も、本文から画像が見えるようにするため）、レビューの回数と指摘・対応の一覧、規格からの逸脱を書く。検品の画像はマージする人がマージの直前に消すことも書き添える

## 検品記録

`~/.claude/ns-illustrations/illustrations/reviews/<素材名>/` に、`render.mjs` が書き出した PNG と `review.md` を置く。別の日・別のプロジェクトからでもプルリクを出せるように、ここだけを見れば検品の経過が分かるように書く。`review.md` は次の形にする。

```
# <素材名>

用途: <例: API ゲートウェイの概念アイコン。スライドに 64〜200px で置く>
手本: <手本の素材名>
規格からの逸脱: なし / <どこから外れるかと、利用者が選んだ日>
新しい部品・トークン: なし / <内容>

## 1 回目: 要修正
- [要修正] <指摘> → 直した / 反論した（<根拠の画像>）

## 2 回目: 合格
```

## 合格の条件

個人の素材集に入れる素材も、条件は同じ。

- レビュアーの判定が「合格」（重大・要修正が 0 件）
- weight.mjs が終了コード 0（アイコンのみ）
- 登録（`register.mjs`）がエラーなく終わる。プルリクでは、カタログのテストが通る

数値の検査が通っても、読めない絵は読めない。weight.mjs は塗りの量しか測らないので、レビューの代わりにならない。

## こう考えたら止まる

| 考え | 実際 |
|---|---|
| 弱点は報告に書いたので完成でよい | 自覚した弱点は直す対象。報告に書いても素材集の品質は上がらない |
| 規格より良い案なので、規格から外れて描いた | 規格は素材集全体をそろえるためにある。外れるなら描く前に聞く（手順 2） |
| 自分で何度も見比べたのでレビューは要らない | 描いた本人は意図を知っているので、絵に描かれていない意味まで読めてしまう |
| 重さの数値が中央値に近いので合格 | 塗りの量が足りていても、形が読めない絵はある |
| 軽微な指摘しか残っていないので、要修正の 1 件は見送る | 要修正が残っていれば不合格。見送るならユーザーに聞く |
| 規格どおりに描いたのだから、規格との衝突の指摘は無視してよい | 規格どおりでも読めない絵は素材集に入れられない。どちらを取るかはユーザーが決める（手順 4-v） |
