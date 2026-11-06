# ns-illustrations

スライドや資料に使う**挿絵素材集**（SVG 数百点）と、その使い方・描き足し方のスキルをまとめたプラグイン。素材は丸みのあるフラットな画風にそろえてあり、並べても見分けが付かないことを品質の基準にしている。

## 何が変わるか

AI に HTML 資料を作らせるとき、このプラグインを使った場合と使わない場合を、同じ依頼で並べた比較がある。

- [ns-illustrations あり・なしの比較](docs/comparison.html)（2026-10-19 実施。6 つの依頼で比べている）
  - **絵がない → 絵がある:** 依頼に絵のことを書かなくても、素材集の挿絵が入る
  - **絵が粗い → 絵が整う:** 絵を求める依頼でも、AI がその場で描く SVG ではなく、画風のそろった素材が入る
  - かかる時間とトークンは増える（ツール呼び出しで素材の一覧を読み、素材を埋めるため）。数字は比較のページの冒頭にある

HTML のファイルは GitHub 上ではソースとして表示される。見た目を確かめるときは、クローンしてブラウザで開く。

## 同梱スキル

| スキル | できること | 起動 |
|---|---|---|
| [use-illustration](skills/use-illustration/SKILL.md) | 共有と個人の素材集から素材を探し、印を書いて道具で中身を埋めて資料に挿絵を入れる | 依頼に「挿絵は ns-illustrations を使って」と添える |
| [draw-illustration](skills/draw-illustration/SKILL.md) | 新しい素材を描き足す、既存の素材を描き直す。描いた素材は個人の素材集（`~/.claude/ns-illustrations/illustrations/`）に入り、望めば共有の素材集へプルリクを出す | `/ns-illustrations:draw-illustration <素材名と用途>` |

## インストール

```bash
/plugin marketplace add nextscape/ns-skills
/plugin install ns-illustrations@nextscape
```

## 使い方

### 素材を使う（use-illustration）

1. **探す。** [catalog.md](assets/illustrations/catalog.md) で素材の名前を決める。見た目で探すときは [gallery.html](assets/illustrations/gallery.html) をブラウザで開く
2. **置く。** HTML に、`data-illust` に素材の名前を書いた空の `<svg>` を置く
3. **埋める。** `node <プラグインの場所>/scripts/fill.mjs <デッキのフォルダかファイル>` で中身・`viewBox`・大きさが書き込まれる

ふつうはスキルがこの手順を代わりに行うので、資料を作る依頼に添えるだけでよい。印の属性・縮尺のそろえ方・文字の扱いは [placing.md](skills/use-illustration/references/placing.md) にある。

### 素材を描き足す（draw-illustration）

[style-guide.md](assets/illustrations/style-guide.md) と手本の素材に沿って描き、描き手の意図を知らないサブエージェントのレビューで合格したものだけを素材集に入れる。レビューの観点は [reviewer.md](skills/draw-illustration/reviewer.md)。

## 収録内容

| | |
|---|---|
| 素材 | 人物・物・概念アイコン・画面 UI・演出パーツ・背景・建物・動物・宇宙・装着小物（[assets/illustrations/](assets/illustrations/)。点数は catalog.md の冒頭） |
| 一覧 | [catalog.md](assets/illustrations/catalog.md)（自動生成。動かせる部品の名前も載る） |
| 見本帳 | [gallery.html](assets/illustrations/gallery.html) |
| 描き方の決まり | [style-guide.md](assets/illustrations/style-guide.md)（色・光源・キャンバス・部品・命名） |
| 道具 | [scripts/](scripts/)（埋める `fill.mjs`、登録の `register.mjs`、検品の `render.mjs`・`weight.mjs`、検品の道具を入れる `setup-tools.mjs`） |

素材集は 2 つある。プラグインに入っている**共有の素材集**と、`draw-illustration` で描いた素材が入る**個人の素材集**（`~/.claude/ns-illustrations/illustrations/`）。同じ名前の素材が両方にあれば、個人のほうが使われる。

## 必要なもの

- **Node.js 20 以上。** `fill.mjs`・`register.mjs`・`render.mjs`・`weight.mjs` は Node で動く。`node --version` で確かめ、入っていなければ https://nodejs.org/ から LTS 版を入れる（Windows なら `winget install OpenJS.NodeJS.LTS` でもよい）。スキルは `node` が無ければ入れ方を案内して止まる
- **素材を描くときだけ: npm とネットワーク。** `draw-illustration` の検品は puppeteer で画像を書き出す。初回に `node <プラグインの場所>/scripts/setup-tools.mjs` が `npm install` で puppeteer を `~/.claude/ns-illustrations/tools/` へ入れる。puppeteer が使うブラウザ本体（Chrome for Testing）は、puppeteer が自分のキャッシュ（既定は `~/.cache/puppeteer`。Windows では `C:\Users\<ユーザー名>\.cache\puppeteer`）へダウンロードする。tools/ の外なので、消すときはそこも消す
- 素材を使うだけ（`use-illustration`）なら npm もネットワークも要らない
