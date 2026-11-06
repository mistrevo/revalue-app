# 画面の作り直し PR 2（入口の 2 画面、ほかの画面、設定の色） Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（`.claude/workflows/run-plan.js`）で回す。Steps use checkbox (`- [ ]`) syntax for tracking. Workflow は 1 回（3 まとまり）。PR 1（`2026-11-06-screen-redesign-talk.md`）が main に入ってから始める。

**Goal:** 案内と「はじめる前に」をモックの短さにし、ほかの画面の見た目（上の帯、カード、ボタン）を話す画面とそろえ、設定の画面で 6 色から選べるようにする。

**Architecture:** PR 1 で入った色の役割（`palette.ts`、Tailwind の色名 `ground`・`surface`・`tint` など）と文字をそのまま使う。ほかの画面は、共通の枠 `Page` の上の帯と、shadcn/ui の `Card`・`Button` の見た目を変えて一度にそろえ、各画面の中身の並びと言葉には手を入れない。色を選ぶ処理は `palette.ts` に `choosePalette()` を一つ足すだけにする。

**Tech Stack:** React 19、TypeScript、React Router 8、Tailwind CSS 4、shadcn/ui、Vitest と Testing Library

**Spec:** 設計 `docs/superpowers/specs/2026-11-06-screen-redesign-design.md` の 1 章の「色を選ぶ」、3 章（入口の 2 画面）、4 章（ほかの画面）、5 章。モックは `docs/superpowers/specs/2026-11-06-screen-redesign-mocks/`（`landing.html`、`startshort.html`）。正しい姿は `docs/specs/00-common.md`、`01-foundation.md`

---

## 進め方（Workflow 1 回）

| まとまり（taskGroups） | タスク | heavy |
|---|---|---|
| A: ほかの画面の見た目、設定の色 | Task 1〜2 | false |
| B: 入口の 2 画面 | Task 3〜4 | false |
| C: 文書と、実際のブラウザでの確認 | Task 5 | false |

**args:** `touchesVoice: true`（案内とはじめる前にの言葉を短くし、設定の言葉を足すため。AI への指示は変えない）。specs は `docs/specs/00-common.md`、`00-tech-stack.md`、`01-foundation.md`。verify は `npm --prefix src/web test`、`npm --prefix src/web run build`、`node --test .claude/hooks/guard.test.mjs`、`dotnet test --project tests/Revalue.Server.Tests`（裏側は変えないが、CI と同じものを流す）。本物の AI の評価は回さない。

**受け入れ基準:** common-1（使わない言葉を出さない）、common-4（どの画面からもトークへ戻れ、幅に収まる）、common-5（どの色でも読める。設定で選べることを足す）、foundation-1（案内はログインなしで見られる）、foundation-2（始める前に保存するものを示す）、foundation-3（いつでも全部消せる）

## Global Constraints

- 製品の芯を守る。案内では「本人の言葉を根拠にする」「本人が選び、直せる」を先に伝える（01-foundation の案内）。画面に「診断」「判定」「スコア」を出さない
- ほかの画面（話したこと、見えた力、5 つの記録、仕事の選択肢、選んだ案を深める、可能性レポート、設定）の中身の並びと言葉は変えない。変えるのは、上の帯、カード、ボタン、余白、色、文字の見た目だけ
- 色は Tailwind の色名（`bg-surface`、`bg-tint`、`text-on-tint`、`bg-tile`、`bg-chip`、`border-field-border` など）か shadcn の変数で書く。値を書き込まない
- 本文 16px、12px より小さい文字を作らない。押すものは高さ 44px 以上。幅 320px〜1280px で横にはみ出さない
- はじめる前にの 5 項目の全文の言葉は変えない（foundation-2）
- 色の選択は `localStorage` だけに残し、サーバーへ送らない。読み書きの失敗で画面を止めない
- テスト名は `<呼び名>（タイトル）: 〜`。Spec とコードは同じ PR で変える。`docs/superpowers/progress.md` はこのブランチで触らない

### PR 1（#25）のあとで分かっていること

- 各画面の戻る道は、PR 1 で `copy.nav.backToTalk`（トークに戻る、`/talk` 行き）にまとめてある。Task 1 では上の帯の形と見た目だけをそろえ、同じリンクを一つの画面に二重に出さない
- 文字と地の組は `docs/specs/00-common.md` の「見た目」で確かめた組から選ぶ。マウスを載せたときも同じ。accent の文字のボタン（`Button` の `outline` など）は、マウスを載せたら `bg-tint` の地に `text-on-tint` の文字にする（accent と tint は 4 色で 4.5 に届かない）
- 「はじめに」の「保存しないもの」には、PR 1 で書きかけのことと、共用の端末で見えうることを足し、了解の版を 2026-11-06 に上げた。Task 4 は 5 項目の全文を変えずに「くわしく読む」の中へ移すだけなので、了解の版は上げない（Claude の判断）。4 行の要約は開発者が決めた言葉のままにし、書きかけのことを要約に足すかは開発者に確かめる項目として報告に書く
- 色の値と読み書きは `src/web/src/lib/palette.ts`（`PALETTES`、`readPalette`、`writePalette`、`applyPalette`、`startPalette`）。`choosePalette` はここに足す

### 新しい・変える文言（`copy.ts` に、この言葉のまま入れる）

| 置き場所（キー） | 言葉 |
|---|---|
| `landing.promises[0]` | 題: あなたの言葉が根拠です / 本文: 見えた力には、話した言葉をそのまま添えます |
| `landing.promises[1]` | 題: 決めるのはあなたです / 本文: 見立ては直せます。仕事も自分で選べます |
| `landing.promises[2]` | 題: 安心して話せます / 本文: 名前もメールアドレスも残しません |
| `landing.flow`（`flowTitle` は消す） | 話す / 見えた力を確かめる / 仕事の選択肢を見て、自分で選ぶ（「→」でつないで 1 行に出す） |
| `start.lead` | 話してもらった内容の扱いを、先にお伝えします。 |
| `start.summary`（4 行） | 残すのは、話した内容と、そこから作るものだけです / 名前とメールアドレスは残しません / 返事や見立てを作るときだけ、AI（Anthropic の Claude）に送ります。開発者も読みません / 30 日使わないと自動で消えます。いつでも全部消せます |
| `start.more` | くわしく読む |
| `start.afterAgree` | 始めると、すぐに聞き手との話になります |
| `settings.colorTitle` | 色 |
| `settings.colorLead` | 画面の色を選べます。選んだ色は、この端末にだけ残ります。 |

色の名前は `PALETTES[key].name`（あおみどり、さくら、わかば、そら、みかん、ふじ）を使う。

## Review Focus

1. 色を選んだあと、端末を暗い画面に切り替える: 選んだ色の暗い画面の値に変わる（明るい値のまま残らない） → Task 2 のテスト
2. ブラウザが保存を止めている: 色を押すと、その場では変わり、エラーも出ない。開き直すと、いつもの色に戻るだけ → Task 2 のテスト
3. 了解していない人が「くわしく読む」を開かずに了解する: 全文は閉じていてもページの中にあり、読み上げ（スクリーンリーダー）でもたどれる → Task 4 のテスト（`details` の中の 5 項目が DOM にある）
4. 全部消したあとに来たはじめる前に: 「全部消しました…」が一度だけ出て、短い 4 行と了解のボタンが出る → Task 4 のテスト
5. 長い画面（仕事の選択肢、可能性レポート）を幅 320px で: カードと上の帯が横にはみ出さない → Task 5 の実際のブラウザの確認

---

### Task 1: 上の帯とカードの見た目をそろえる

**Files:**
- Modify: `src/web/src/components/Page.tsx`、`src/web/src/components/ui/card.tsx`、`src/web/src/components/ui/button.tsx`、`src/web/src/pages/*.tsx` のうち、`rounded-lg border p-4` などで手書きの囲みを作っている所（見た目のクラスだけ）
- Test: `src/web/src/components/Page.test.tsx`

**Interfaces:**
- Produces:
  - `Page({ children })` の上の帯: ログインして了解した人には、左に「←」のアイコンと `copy.nav.backToTalk`（`/talk` への Link）。それ以外（案内、はじめに、読み込み中）は、いままでどおり「RE:VALUE」（`/` への Link）。帯の地は `bg-surface`、下に `border` の線。画面の地は `bg-ground`
  - `Card`: `bg-surface`、角丸 `rounded-2xl`（18px 前後）、枠は `border`
  - `Button`: 高さ 44px 以上、文字 700。`default` は `bg-primary`、`outline` は accent の枠と文字。角丸 14px 前後
  - 各画面の手書きの囲み（次にできることの欄、確かめの欄など）は、`Card` と同じ地・角丸にそろえる

- [x] **Step 1: 失敗するテストを書く**

```ts
it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 了解した人の画面では、上の帯から「トークに戻る」で /talk へ行ける', async () => {
  installFakeApi({ loggedIn: true, consented: true })
  renderApp('/abilities')
  const back = await screen.findByRole('link', { name: copy.nav.backToTalk })
  expect(back).toHaveAttribute('href', '/talk')
  expect(screen.queryByRole('link', { name: copy.nav.appName })).not.toBeInTheDocument()
})
it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 案内では、上の帯は「RE:VALUE」で案内へ行く', async () => {
  installFakeApi({ loggedIn: false, consented: false })
  renderApp('/')
  expect(await screen.findByRole('link', { name: copy.nav.appName })).toHaveAttribute('href', '/')
})
```

- [x] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test -- Page` / Expected: 1 つ目が FAIL
- [x] **Step 3: 書く。各画面の中身の並びと言葉は変えない（既存のテストが通ることで確かめる）**
- [x] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test` と `npm --prefix src/web run build` / Expected: PASS
- [x] **Step 5: コミット**

```bash
git add -A src/web
git commit -m "ほかの画面の上の帯を「トークに戻る」にし、カードとボタンの見た目を話す画面とそろえる"
```

### Task 2: 設定の画面で色を選ぶ

**Files:**
- Modify: `src/web/src/lib/palette.ts`、`src/web/src/pages/Settings.tsx`、`src/web/src/copy.ts`
- Test: `src/web/src/lib/palette.test.ts`、`src/web/src/pages/Settings.test.tsx`

**Interfaces:**
- Consumes: `PALETTES`、`PALETTE_KEYS`、`readPalette()`、`writePalette()`、`applyPalette()`、`startPalette()`（PR 1）
- Produces:
  - `choosePalette(key: PaletteKey): void` — `writePalette(key)` のあと、いまの端末の設定（暗いか）で `applyPalette` する。`startPalette()` が購読している端末の設定の変化でも、選んだ色で当て直す（`startPalette` の当て直しが `readPalette()` を読み直すか、選んだ色を覚えておく形にする。保存できないブラウザでも、その場の選択で当て直せるように、モジュールの中にいまの色を持つ）
  - 設定の画面の「色」の欄（`全部消す` の欄より上）: 見出し `copy.settings.colorTitle`、説明 `copy.settings.colorLead`、`role="radiogroup"` に 6 つの `role="radio"`（丸い色見本と `PALETTES[key].name`。`aria-checked`、矢印キーで動ける）。押すとすぐに `choosePalette`

- [x] **Step 1: 失敗するテストを書く**

```ts
// palette.test.ts
it('common-5（どの色でも読める）: 選んだ色は、端末を暗い画面に切り替えても選んだ色の暗い値になる', () => {
  let listener: ((e: { matches: boolean }) => void) | null = null
  const mql = { matches: false, addEventListener: (_: string, l: typeof listener) => { listener = l }, removeEventListener: () => {} }
  vi.stubGlobal('matchMedia', () => mql)
  const stop = startPalette()
  choosePalette('blue')
  listener!({ matches: true })
  expect(document.documentElement.style.getPropertyValue('--rv-accent')).toBe(PALETTES.blue.dark.accent)
  stop()
})
it('common-5（どの色でも読める）: 保存できないブラウザでも、選んだ色にその場で変わる', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  expect(() => choosePalette('purple')).not.toThrow()
  expect(document.documentElement.dataset.palette).toBe('purple')
})

// Settings.test.tsx
it('common-5（どの色でも読める）: 設定の画面で 6 色から選べ、選ぶとすぐに変わり、開き直しても選んだ色が選ばれている', async () => {
  installFakeApi({ loggedIn: true, consented: true })
  const { unmount } = renderApp('/settings')
  const group = await screen.findByRole('radiogroup', { name: copy.settings.colorTitle })
  expect(within(group).getAllByRole('radio')).toHaveLength(6)
  await userEvent.click(within(group).getByRole('radio', { name: 'さくら' }))
  expect(document.documentElement.dataset.palette).toBe('rose')
  unmount()
  renderApp('/settings')
  expect(await screen.findByRole('radio', { name: 'さくら' })).toHaveAttribute('aria-checked', 'true')
})
```

- [x] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test -- palette Settings` / Expected: FAIL
- [x] **Step 3: 書く**
- [x] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test` / Expected: PASS
- [x] **Step 5: コミット**

```bash
git add -A src/web
git commit -m "設定の画面で、6 色から画面の色を選べるようにする。選んだ色はこの端末にだけ残す"
```

### Task 3: 案内を短くする

**Files:**
- Modify: `src/web/src/pages/Landing.tsx`、`src/web/src/copy.ts`
- Test: `src/web/src/pages/Landing.test.tsx`

**Interfaces:**
- Produces: 案内の画面（モック `landing.html`）。上から、「RE:VALUE」と「リバリュー」、ひとこと（`copy.landing.tagline` を大見出し `h1` に）、説明 1 文（`copy.landing.lead`）、約束 3 つ（アイコンの丸、題、1 行。カードの見た目）、空き、ログインのボタン（幅いっぱい、親指の届く下。`LOGIN_URL` へページごと移動）、進め方 1 行（`copy.landing.flow` を「→」でつなぐ）。ログイン済みの人の行き先は PR 1 のまま（`/talk` か `/start` へ送る）。送るまでのあいだは、ボタンを出さないか、いままでの「続きから」を出す

- [x] **Step 1: 失敗するテストを書く**（いまの Landing のテストのうち、約束の本文や `flowTitle` を確かめている所は、新しい言葉に直す）

```ts
it('foundation-1（案内はログインなしで見られる）: 約束 3 つが題と 1 行で出て、先頭は「あなたの言葉が根拠です」「決めるのはあなたです」', async () => {
  installFakeApi({ loggedIn: false, consented: false })
  renderApp('/')
  const titles = await screen.findAllByRole('heading', { level: 2 })
  expect(titles.map((t) => t.textContent)).toEqual(['あなたの言葉が根拠です', '決めるのはあなたです', '安心して話せます'])
  expect(screen.getByText('見えた力には、話した言葉をそのまま添えます')).toBeInTheDocument()
})
it('foundation-1（案内はログインなしで見られる）: ログインのボタンは組み込み認証へページごと移動するリンクで、進め方が 1 行で出る', async () => {
  installFakeApi({ loggedIn: false, consented: false })
  renderApp('/')
  expect(await screen.findByRole('link', { name: copy.landing.login })).toHaveAttribute('href', LOGIN_URL)
  expect(screen.getByText(copy.landing.flow.join(' → '))).toBeInTheDocument()
})
```

- [x] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test -- Landing` / Expected: FAIL
- [x] **Step 3: 書く**
- [x] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test -- Landing` / Expected: PASS
- [x] **Step 5: コミット**

```bash
git add -A src/web
git commit -m "案内を短くする。約束 3 つを題と 1 行にし、ログインのボタンを下に置く"
```

### Task 4: はじめる前にを短くする

**Files:**
- Modify: `src/web/src/pages/Start.tsx`、`src/web/src/copy.ts`
- Test: `src/web/src/pages/Start.test.tsx`

**Interfaces:**
- Produces: はじめる前にの画面（モック `startshort.html`）。見出し `copy.start.title`、`copy.start.lead`、4 行の要約（`copy.start.summary`。アイコン付きの 1 枚のカード）、`<details>`（`<summary>` は `copy.start.more`）の中に、いまの 5 項目の題と全文（`copy.start.items`。言葉は変えない）、空き、「了解して始める」（幅いっぱい、下）、その下に `copy.start.afterAgree`、さらにその下に目立たせない「了解せずにやめる（ログアウト）」（いまのまま。ページごと移動）。全部消したあとの「全部消しました…」は、いまのまま一度だけ出す

- [x] **Step 1: 失敗するテストを書く**（いまの Start のテストは、5 項目の題と本文がページの中にあることを確かめ続ける。`details` が閉じていても DOM にあるので、そのまま通るはず）

```ts
it('foundation-2（始める前に保存するものを示す）: 4 行の要約が先に出て、5 項目の全文は「くわしく読む」の中にある', async () => {
  installFakeApi({ loggedIn: true, consented: false })
  renderApp('/start')
  for (const line of copy.start.summary) expect(await screen.findByText(line)).toBeInTheDocument()
  const more = screen.getByText(copy.start.more).closest('details')!
  expect(more).not.toHaveAttribute('open')
  for (const item of copy.start.items) expect(within(more).getByText(item.body)).toBeInTheDocument()
})
it('foundation-2（始める前に保存するものを示す）: 了解しない人の出口が残る', async () => {
  installFakeApi({ loggedIn: true, consented: false })
  renderApp('/start')
  expect(await screen.findByRole('link', { name: copy.start.decline })).toHaveAttribute('href', LOGOUT_URL)
})
```


- [x] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test -- Start` / Expected: 1 つ目が FAIL
- [x] **Step 3: 書く**
- [x] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test` と `npm --prefix src/web run build` / Expected: PASS
- [x] **Step 5: コミット**

```bash
git add -A src/web
git commit -m "はじめる前にを短くする。4 行の要約を先に出し、全文は「くわしく読む」の中に置く"
```

### Task 5: Spec を直し、実際のブラウザで確かめる

**Files:**
- Modify: `docs/specs/00-common.md`、`docs/specs/01-foundation.md`

- [x] **Step 1: Spec を直す**（いまの正しい姿だけを書く）
  - `00-common.md` の「画面」: 了解した人のほかの画面は、上の帯に「← トークに戻る」。カードとボタンの見た目は話す画面とそろえる。設定の画面で 6 色から選べる。common-5（どの色でも読める）に「設定の画面で 6 色から選べ、選ぶとすぐに変わる。開き直しても選んだ色のまま（保存できるブラウザで）」を足す
  - `01-foundation.md` の画面の表: 案内は「約束 3 つを題と 1 行で。ログインのボタンは下」。はじめには「4 行の要約と、『くわしく読む』の中の 5 項目の全文」。設定に「色」の欄
- [x] **Step 2: 実際のブラウザで確かめる**（Playwright の MCP。画面をビルドしてから `node evals/personas/driver/serve.mjs` で手元のサーバーを立て、ログインしていない状態で `/` を見たあと、`http://localhost:5080/.auth/login/google?dev_user=redesign-check-2` でログインする。サーバーは終わったら止める）
  - 幅 320px、375px×667px、1280px で、案内、はじめる前に、設定、見えた力、仕事の選択肢、可能性レポート
  - 横にはみ出さない（`document.documentElement.scrollWidth <= innerWidth`）。ボタンが親指の届く下にある
  - 設定で 6 色を順に選び、話す画面に戻って色が変わっていること。`emulate_media` で暗い画面にしても読めること
  - 写真はスクラッチに置き、リポジトリに入れない。気づいた崩れは直してから次へ
- [x] **Step 3: 全部のテストを流す**

Run: `dotnet test --project tests/Revalue.Server.Tests`、`npm --prefix src/web test`、`npm --prefix src/web run build`、`node --test .claude/hooks/guard.test.mjs`
Expected: すべて PASS

- [x] **Step 4: コミット**

```bash
git add docs src
git commit -m "Spec を、短くした入口の 2 画面、そろえたほかの画面、設定の色に合わせる"
```
