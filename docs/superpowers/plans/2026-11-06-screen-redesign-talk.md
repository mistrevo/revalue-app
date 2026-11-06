# 画面の作り直し PR 1（見た目の土台と話す画面） Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（`.claude/workflows/run-plan.js`）で回す。Steps use checkbox (`- [ ]`) syntax for tracking. Workflow は 1 回（3 まとまり）。

**Goal:** 文字を太めの丸ゴシックに、色を 6 色の役割（トークン）と暗い画面に置き換え、アプリを開くと LINE のトークのように話す画面がそのまま出る形にする（ホームはなくす。書きかけを残す。区切ったら見えた力がトークの中にカードで出る）。

**Architecture:** 色は `src/web/src/lib/palette.ts` を唯一の置き場所にし、起動時に `document.documentElement` へ CSS 変数 `--rv-*` として書き込む。`index.css` は shadcn/ui の変数を `--rv-*` から引くだけにする。`/talk`（ID なし）を入口にし、`chooseTalkTarget()`（純粋な関数）が場面の一覧と次にできることから行き先を決める。話す画面は、上の帯・やりとり・下の帯（入力とメニュー板）の 3 段の固定レイアウトにし、部品を `src/web/src/components/talk/` に分ける。処理（送る、区切る、飛ばす、直す、続きを話す）はいまの `Talk.tsx` のものをそのまま使う。

**Tech Stack:** React 19、TypeScript、React Router 8、Tailwind CSS 4、shadcn/ui、Vitest と Testing Library、ASP.NET Core（.NET 10）と xUnit v3（一覧の API に 1 項目足すだけ）

**Spec:** 設計 `docs/superpowers/specs/2026-11-06-screen-redesign-design.md` の 1 章（見た目の土台）、2 章（話す画面）、5 章（直す文書）。モックは `docs/superpowers/specs/2026-11-06-screen-redesign-mocks/`（`talkopen.html`、`talkmid.html`、`talkend.html`、`menutalk.html`、`a-night.html`）。正しい姿は `docs/specs/00-common.md`、`01-foundation.md`、`02-discover.md`、`03-validate.md`

---

## 進め方（Workflow 1 回）

| まとまり（taskGroups） | タスク | heavy |
|---|---|---|
| A: 見た目の土台と、書きかけ・一覧の下準備 | Task 1〜3 | false |
| B: 開いたときの行き先、ホームをなくす、話す画面の形 | Task 4〜5 | true |
| C: 区切ったとき、文書 | Task 6〜7 | true |

**args:** `touchesVoice: true`（画面の文言を足し、変えるため。AI への指示は変えない）。specs は `docs/specs/00-common.md`、`00-tech-stack.md`、`01-foundation.md`、`02-discover.md`、`03-validate.md`。verify は `dotnet test --project tests/Revalue.Server.Tests`、`npm --prefix src/web test`、`npm --prefix src/web run build`、`node --test .claude/hooks/guard.test.mjs`。本物の AI の評価は回さない（AI の言い方を変えないため）。

**受け入れ基準:** common-1（使わない言葉を出さない）、common-3（次にできることを一つ示す。書き直す）、common-4（どの画面からもトークへ戻れ、幅に収まる。題を変える）、common-5（どの色でも読める。新規）、foundation-2（始める前に保存するものを示す。行き先だけ変える）、discover-1（具体的な一日を一つ聞く）、discover-3（選んでも書いてもよい）、discover-5（つらい話は飛ばせる）、discover-6（一場面ずつ区切り、続きから話せる）、discover-8（話した出来事が残る）、discover-10（つらい状態のサインに応える）、discover-11（書きかけを残す。新規）、discover-12（開くとトークが出る。新規）、validate の「話し終えたとき」の基準（いまの呼び名のまま）

## Global Constraints

- 製品の芯と、03-validate の「状態の呼び名やチェック表、点数は出さない」を守る。見えた力のカードに、チェックの印、点数、割合、「済」の数を出さない
- 画面に「診断」「判定」「スコア」を出さない。新しい文言は `copy.ts` に置き、common-1 のテストに通す
- アプリが残すのは ID と話した内容だけ。色と書きかけは `localStorage` に置き、サーバーへ送らない。`localStorage` の読み書きはすべて try/catch で包み、失敗しても画面を止めない
- 文字: `@fontsource/m-plus-rounded-1c`（5.3.0）の 500、700、800。本文 16px、行の高さ 1.7。12px より小さい文字を作らない。押すものは高さ 44px 以上
- 幅 320px〜1280px で横にはみ出さない。PC に切り替える目安は `lg`（1024px）
- テストで Claude を呼ばない。テスト名は `<呼び名>（タイトル）: 〜` の形
- Spec とコードは同じコミットで変える。`docs/superpowers/progress.md` はこのブランチで触らない
- 開発者の名前、実在の人の情報を書かない。例の出来事はモックの架空のものを使う

### 新しい文言（`copy.ts` に、この言葉のまま入れる）

| 置き場所（キー） | 言葉 |
|---|---|
| `talk.other`（いまの「それ以外」を変える） | それ以外（自分で書く） |
| `talk.draftKept` | 書きかけは残っています。閉じても、続きから書けます |
| `talk.finishedChip` | ここで区切りました |
| `talk.afterQuestion`（いまの `talk.finished` の代わり） | この場面の話は、ここで一区切りです。次は、どれにしますか？ |
| `talk.anotherDay` | 別の日のことを話す |
| `talk.doneForToday` | 今日はここまで |
| `talk.doneForTodayReply` | おつかれさまでした。また話したくなったら、ここから続けられます。 |
| `talk.rest` | また話したくなったときに、いつでも始められます。 |
| `nav.backToTalk`（各画面の `backHome` をこれにまとめる） | トークに戻る |
| `menu.label` / `menu.open` / `menu.close` | メニュー / メニューを開く / メニューをたたむ |
| `menu.episodes` / `menu.abilities` / `menu.profile` / `menu.options` / `menu.report` / `menu.settings` | 話したこと / 見えた力 / 5 つの記録 / 仕事の選択肢 / まとめ / 設定 |

### 色の値（`palette.ts` の明るい画面。モックのとおり。fieldBorder だけ、コントラスト 3 に届くよう濃くした値）

| キー | 名前 | ground | surface | text | muted | border | accent | onAccent | tint | onTint | tile | chip | field | fieldBorder |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| teal | あおみどり | #F2F4F1 | #FFFFFF | #262A2B | #5B6265 | #E1E5E2 | #1F7A6E | #FFFFFF | #DCEFEA | #1B3B36 | #EEF5F2 | #E4E9E6 | #F7F9F8 | #8B9092 |
| rose | さくら | #F8F3F3 | #FFFFFF | #2E2627 | #6A5A5D | #EBDDDF | #B4475A | #FFFFFF | #FBE4E8 | #5A1F2B | #FBEEF0 | #EFE4E5 | #FBF7F7 | #978C8E |
| green | わかば | #F3F6F0 | #FFFFFF | #262B24 | #56604F | #DEE6D9 | #3A7D2C | #FFFFFF | #E3F1DC | #1F3D18 | #EDF4E8 | #E3EADF | #F7FAF5 | #8A9186 |
| blue | そら | #F2F5F9 | #FFFFFF | #242A33 | #545F6E | #DCE3EC | #2F5D9E | #FFFFFF | #E1EAF7 | #1A2F52 | #EAF0F9 | #E1E7EF | #F6F8FB | #878F9A |
| orange | みかん | #FAF6F0 | #FFFFFF | #2E2924 | #665B4E | #EADFD1 | #B05A00 | #FFFFFF | #FCEBD5 | #5A3200 | #FBF0E2 | #EFE7DC | #FBF8F4 | #958E85 |
| purple | ふじ | #F6F4F9 | #FFFFFF | #29262F | #5E5A68 | #E2DCEC | #6A4FA3 | #FFFFFF | #ECE6F6 | #33245A | #F0ECF7 | #E7E2EF | #F9F8FB | #908D97 |

暗い画面の値は実装する人が 6 色それぞれに作る。あおみどりの暗い画面はモック `a-night.html` の値を元にする: ground #121517、surface #22272A、text #E4E7E5、muted #A3ABA8、border #2A2F31、accent #6CCBBB、onAccent #0F2420、tint #1D3B36、onTint #DDEFEA、fieldBorder は field と surface に対して 3 以上になる値。ほかの 5 色も、accent を明るくして色みを保つ。どの値も Task 1 のコントラストのテストに通す。

## Review Focus

1. ブラウザが保存を止めている（Safari のプライベート、サイトのデータの拒否）: `localStorage` が例外を投げても、話す画面が出て、送れる。色はあおみどり、書きかけは残らないだけ → Task 1 と Task 3 のテスト、Task 5 のテスト
2. 送れなかったときの書きかけ: 送るのに失敗（500、429、閉じた場面）しても、入力欄と保存した書きかけは消えない。送れたときだけ消える → Task 5 のテスト
3. 開いたときに、ほかのタブで途中の場面がもうできている: `POST /api/episodes` の 409 で、新しく作らずにその場面へ進む。作るのに失敗したら、白い画面にせず、言葉と「もう一度」を出す → Task 4 のテスト
4. スマホでキーボードを開いたとき: メニュー板が入力欄を押し上げない（文字を打っているあいだは隠す）。入力欄から離れたら戻る → Task 5 のテスト
5. 長い選択肢と狭い幅: 最初の問いの「腹が立った・納得できなかったこと」や、AI が出す長めの答えの例が、幅 320px で横にはみ出さず折り返す → Task 5 の `min-w-0` と折り返し、Task 7 の実ブラウザの確認

---

### Task 1: 色の役割、6 色、暗い画面、文字

**Files:**
- Create: `src/web/src/lib/palette.ts`、`src/web/src/lib/contrast.ts`
- Test: `src/web/src/lib/palette.test.ts`、`src/web/src/lib/contrast.test.ts`
- Modify: `src/web/src/index.css`、`src/web/src/main.tsx`、`src/web/package.json`（`@fontsource-variable/geist` を外し、`@fontsource/m-plus-rounded-1c` を足す）

**Interfaces:**
- Produces:
  - `contrastRatio(a: string, b: string): number`（`#RRGGBB` 2 つ。WCAG 2 の相対輝度の式）
  - `PALETTE_KEYS: readonly ['teal', 'rose', 'green', 'blue', 'orange', 'purple']`、`type PaletteKey`、`type PaletteTokens`（上の表の 13 項目、値は `#RRGGBB`）
  - `PALETTES: Record<PaletteKey, { name: string; light: PaletteTokens; dark: PaletteTokens }>`
  - `PALETTE_STORAGE_KEY = 'revalue.palette'`
  - `readPalette(): PaletteKey`（読めない、知らない値なら `'teal'`）、`writePalette(key: PaletteKey): void`（書けなくても投げない）
  - `applyPalette(key: PaletteKey, dark: boolean): void`（`document.documentElement` に `--rv-<役割>` を書き、`data-palette` と `data-scheme`（`light` / `dark`）を付ける）
  - `startPalette(): () => void`（読む → 端末の設定（`matchMedia('(prefers-color-scheme: dark)')`）で当てる → 設定が変わったら当て直す。`matchMedia` がなければ明るい画面。戻り値は購読の解除）
  - CSS の色名（Tailwind）: `ground`、`surface`、`tint`、`on-tint`、`tile`、`chip`、`field`、`field-border`（`bg-tint`、`text-on-tint` などで使える）

- [x] **Step 1: 失敗するテストを書く**

```ts
// contrast.test.ts
it('common-5（どの色でも読める）: 白と黒は 21、同じ色は 1', () => {
  expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 1)
  expect(contrastRatio('#1F7A6E', '#1F7A6E')).toBeCloseTo(1, 5)
})

// palette.test.ts
const TEXT_PAIRS = [['text','ground'],['text','surface'],['text','field'],['muted','ground'],['muted','surface'],['onTint','tint'],['onAccent','accent'],['accent','surface']] as const
const UI_PAIRS = [['fieldBorder','field'],['fieldBorder','surface'],['accent','tint'],['accent','tile']] as const
describe.each(PALETTE_KEYS)('%s', (key) => {
  it.each(['light', 'dark'] as const)('common-5（どの色でも読める）: %s の文字は 4.5 以上、入力欄の枠とアイコンは 3 以上', (scheme) => {
    const t = PALETTES[key][scheme]
    for (const [a, b] of TEXT_PAIRS) expect(contrastRatio(t[a], t[b]), `${a}/${b}`).toBeGreaterThanOrEqual(4.5)
    for (const [a, b] of UI_PAIRS) expect(contrastRatio(t[a], t[b]), `${a}/${b}`).toBeGreaterThanOrEqual(3)
  })
})
it('common-5（どの色でも読める）: 明るい画面のあおみどりはモックの値', () => {
  expect(PALETTES.teal.light).toMatchObject({ ground: '#F2F4F1', accent: '#1F7A6E', tint: '#DCEFEA', tile: '#EEF5F2' })
  expect(PALETTES.teal.name).toBe('あおみどり')
})
it('common-5（どの色でも読める）: 保存できないブラウザでも、いつもの色で出る', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  expect(readPalette()).toBe('teal')
  expect(() => writePalette('rose')).not.toThrow()
})
it('common-5（どの色でも読める）: 知らない値が残っていたら、いつもの色', () => {
  localStorage.setItem(PALETTE_STORAGE_KEY, 'gold')
  expect(readPalette()).toBe('teal')
})
it('common-5（どの色でも読める）: 当てた色と暗さが、画面の変数と印に出る', () => {
  applyPalette('rose', true)
  const root = document.documentElement
  expect(root.dataset.palette).toBe('rose')
  expect(root.dataset.scheme).toBe('dark')
  expect(root.style.getPropertyValue('--rv-accent')).toBe(PALETTES.rose.dark.accent)
})
it('common-5（どの色でも読める）: 端末の設定を読めない（matchMedia がない）ときは明るい画面', () => {
  vi.stubGlobal('matchMedia', undefined)
  const stop = startPalette()
  expect(document.documentElement.dataset.scheme).toBe('light')
  stop()
})
```

- [x] **Step 2: テストが失敗するのを見る**

Run: `npm --prefix src/web test -- palette contrast`
Expected: FAIL（`palette.ts` と `contrast.ts` がない）

- [x] **Step 3: `contrast.ts` と `palette.ts` を書き、`index.css` と `main.tsx` をつなぐ**

- `palette.ts` の明るい画面は、上の「色の値」の表のとおり。暗い画面は Global Constraints のとおりに作る
- `index.css`
  - `@import "@fontsource/m-plus-rounded-1c/500.css"`、`700.css`、`800.css`。`--font-sans` の先頭を `'M PLUS Rounded 1c'` にし、いまの日本語の予備（Hiragino Sans など）は残す。`body` に `font-weight: 500`、`font-size: 16px`、`line-height: 1.7`
  - `:root` に `--rv-*` のあおみどりの明るい値を置く（JS が動く前と、テストのため）。shadcn の変数は `--rv-*` から引く: `--background: var(--rv-ground)`、`--foreground: var(--rv-text)`、`--card` と `--popover`: `var(--rv-surface)`、`--primary: var(--rv-accent)`、`--primary-foreground: var(--rv-on-accent)`、`--secondary: var(--rv-tile)`、`--muted: var(--rv-chip)`、`--muted-foreground: var(--rv-muted)`、`--accent: var(--rv-tint)`、`--accent-foreground: var(--rv-on-tint)`、`--border: var(--rv-border)`、`--input: var(--rv-field-border)`、`--ring: var(--rv-accent)`。`-foreground` の残りは `var(--rv-text)`
  - `.dark { ... }` の灰色の値の組は消す。`@custom-variant dark` は `(&:where([data-scheme=dark], [data-scheme=dark] *))` にする
  - `@theme inline` に `--color-ground`、`--color-surface`、`--color-tint`、`--color-on-tint`、`--color-tile`、`--color-chip`、`--color-field`、`--color-field-border` を足す
- `main.tsx` は、描く前に `startPalette()` を呼ぶ

- [x] **Step 4: テストが通るのを見る**

Run: `npm --prefix src/web test -- palette contrast` と `npm --prefix src/web run build`
Expected: PASS。ビルドが通る

- [x] **Step 5: コミット**

```bash
git add src/web/src/lib/palette.ts src/web/src/lib/contrast.ts src/web/src/lib/palette.test.ts src/web/src/lib/contrast.test.ts src/web/src/index.css src/web/src/main.tsx src/web/package.json src/web/package-lock.json
git commit -m "見た目の土台を作る。太めの丸ゴシック、6 色の役割、端末の設定に合わせた暗い画面"
```

### Task 2: 場面の一覧に、話し終えた時刻を足す

**Files:**
- Modify: `src/Revalue.Server/Features/Discover/DiscoverEndpoints.cs:53`（`EpisodeSummaryDto`）と `:107`（作るところ）
- Modify: `src/web/src/api.ts`（`EpisodeSummary` に `finishedAt?: string | null`）、`src/web/src/test/fake-api.ts`（`summary()` に `finishedAt: e.finishedAt ?? null`）
- Test: `tests/Revalue.Server.Tests/EpisodeTests.cs`

**Interfaces:**
- Produces: `GET /api/episodes` の各要素に `finishedAt`（話し終えていなければ `null`）。`EpisodeSummary.finishedAt?: string | null`

- [ ] **Step 1: 失敗するテストを書く**

`EpisodeTests.cs` の一覧のテスト（`discover-8（話した出来事が残る）`、`older` を区切って `newer` を始めるもの）に足す:

```csharp
Assert.Equal(JsonValueKind.Null, list[0].GetProperty("finishedAt").ValueKind);
Assert.Equal(JsonValueKind.String, list[1].GetProperty("finishedAt").ValueKind);
```

- [ ] **Step 2: 失敗するのを見る**

Run: `dotnet test --project tests/Revalue.Server.Tests --filter-class "*EpisodeTests"`
Expected: FAIL（`finishedAt` がない）

- [ ] **Step 3: `EpisodeSummaryDto` の最後に `DateTimeOffset? FinishedAt` を足し、`e.FinishedAt` を渡す。画面の型と偽物も合わせる**

- [ ] **Step 4: 通るのを見る**

Run: `dotnet test --project tests/Revalue.Server.Tests --filter-class "*EpisodeTests"` と `npm --prefix src/web test`
Expected: PASS

- [ ] **Step 5: コミット**

```bash
git add src/Revalue.Server/Features/Discover/DiscoverEndpoints.cs tests/Revalue.Server.Tests/EpisodeTests.cs src/web/src/api.ts src/web/src/test/fake-api.ts
git commit -m "場面の一覧に、話し終えた時刻を足す。開いたときに、いちばん新しく話し終えた場面を選ぶため"
```

### Task 3: 書きかけを残す仕組み

**Files:**
- Create: `src/web/src/lib/drafts.ts`
- Test: `src/web/src/lib/drafts.test.ts`

**Interfaces:**
- Produces: `DRAFT_PREFIX = 'revalue.draft.'`、`readDraft(episodeId: string): string`（なければ `''`）、`writeDraft(episodeId: string, text: string): void`（空白だけなら消す）、`clearDraft(episodeId: string): void`、`clearAllDrafts(): void`（`DRAFT_PREFIX` で始まるものだけ消す）。どれも例外を投げない

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('discover-11（書きかけを残す）: 場面ごとに残り、読み直せる', () => {
  writeDraft('episode-1', 'パート先に電話して、')
  writeDraft('episode-2', '別の話')
  expect(readDraft('episode-1')).toBe('パート先に電話して、')
  expect(readDraft('episode-3')).toBe('')
})
it('discover-11（書きかけを残す）: 空白だけにしたら消える', () => {
  writeDraft('episode-1', 'あ'); writeDraft('episode-1', '  ')
  expect(localStorage.getItem('revalue.draft.episode-1')).toBeNull()
})
it('discover-11（書きかけを残す）: 全部消すと書きかけだけが消え、色は残る', () => {
  writeDraft('episode-1', 'あ'); localStorage.setItem('revalue.palette', 'rose')
  clearAllDrafts()
  expect(readDraft('episode-1')).toBe('')
  expect(localStorage.getItem('revalue.palette')).toBe('rose')
})
it('discover-11（書きかけを残す）: 保存できないブラウザでも投げない', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked') })
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked') })
  expect(() => writeDraft('episode-1', 'あ')).not.toThrow()
  expect(readDraft('episode-1')).toBe('')
  expect(() => clearAllDrafts()).not.toThrow()
})
```

- [ ] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test -- drafts` / Expected: FAIL
- [ ] **Step 3: `drafts.ts` を書く**
- [ ] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test -- drafts` / Expected: PASS
- [ ] **Step 5: コミット**

```bash
git add src/web/src/lib/drafts.ts src/web/src/lib/drafts.test.ts
git commit -m "書きかけを、場面ごとにその端末のブラウザへ残す仕組みを足す"
```

### Task 4: 開いたときの行き先と、ホームをなくすこと

**Files:**
- Create: `src/web/src/lib/talk-target.ts`、`src/web/src/pages/TalkEntry.tsx`
- Test: `src/web/src/lib/talk-target.test.ts`、`src/web/src/pages/TalkEntry.test.tsx`
- Delete: `src/web/src/pages/Home.tsx`、`src/web/src/pages/Home.test.tsx`（守っていた基準のテストは `TalkEntry.test.tsx` と Task 6 に移す）
- Modify: `src/web/src/App.tsx`、`src/web/src/pages/Landing.tsx`、`src/web/src/pages/Start.tsx`、`src/web/src/components/Page.tsx`、`src/web/src/lib/next-step.ts`、`src/web/src/pages/Settings.tsx`、`src/web/src/copy.ts`、`<Link to="/home">` のあるすべての画面（Abilities、Deepen、Episodes、Options、Profile、Report、Settings、Talk）と、そのテスト

**Interfaces:**
- Consumes: `EpisodeSummary.finishedAt`（Task 2）、`clearAllDrafts()`（Task 3）、`getNextStep()`、`listEpisodes()`、`useStartEpisode()`
- Produces:
  - `type TalkTarget = { kind: 'episode'; id: string } | { kind: 'rest' } | { kind: 'new' }`
  - `chooseTalkTarget(list: EpisodeSummary[], next: NextStep | null): TalkTarget`
    1. `status === 'talking'` の場面があれば、その場面（複数なら `startedAt` が新しいもの）
    2. 話し終えた場面がなければ `new`
    3. `next === null`（読めなかった）か `next.step === 'none'` なら `rest`（読めないときは、つらい話を出さない側に倒す。Claude の判断）
    4. それ以外は、話し終えた場面のうち `finishedAt ?? startedAt` がいちばん新しいもの
  - `/talk` のルート（`RequireUser consent`、タイトルは `copy.titles.talk`）。`episode` なら `/talk/:id` へ `replace` で進む。`new` なら場面を一度だけ作り（二重に作らないよう ref で守る）、409 ならその場面へ進む。`rest` なら Task 5 の `TalkLayout` に、聞き手の側の `talk.rest` と、目立たせない（`variant="ghost"` 相当）「別の日のことを話す」だけを出す
  - `/home` は `<Navigate to="/talk" replace />`
  - 案内（`/`）: ログインして了解した人は `/talk` へ、ログインして了解していない人は `/start` へ `replace` で送る。ログインしていない人には、いまの案内を出す
  - はじめに: 了解済みと、了解したあとの行き先を `/talk` にする
  - `Page` の左上の「RE:VALUE」: 了解した人は `/talk` へ
  - `nextStepPath` の `continue` で場面の ID がないときの行き先を `/talk` にする
  - 各画面の「ホームへ戻る」は `copy.nav.backToTalk`（トークに戻る）にまとめ、`/talk` へ。仕事の選択肢と可能性レポートの「話す」系のリンク（`/home` 行き）も `/talk` へ
  - 設定: 「全部消す」が済んだときと、ログアウトのリンクを押したとき（ページを離れる前の `onClick`）に `clearAllDrafts()` を呼ぶ
  - `copy.home` のうち、次にできることの言葉（`copy.home.next`）は `NextStepLink` と Task 6 が使うので残す。ホームの画面だけで使っていた言葉（あいさつ、ほかの画面の見出し、各画面へのリンクの言葉、`titles.home`）は消す

- [ ] **Step 1: 失敗するテストを書く**

```ts
// talk-target.test.ts（純粋な関数）
const s = (o: Partial<EpisodeSummary>): EpisodeSummary => ({ id: 'e', status: 'finished', startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T01:00:00Z', userTurnCount: 1, preview: '', canResume: false, ...o })
it('discover-12（開くとトークが出る）: 話している途中の場面があれば、その場面', () => {
  expect(chooseTalkTarget([s({ id: 'a' }), s({ id: 'b', status: 'talking', finishedAt: null })], { step: 'continue', episodeId: 'b' })).toEqual({ kind: 'episode', id: 'b' })
})
it('discover-12（開くとトークが出る）: 場面がなければ、新しく始める', () => {
  expect(chooseTalkTarget([], { step: 'talk', episodeId: null })).toEqual({ kind: 'new' })
})
it('discover-12（開くとトークが出る）: 続きを話して後から区切った古い場面も、話し終えた時刻で選ぶ', () => {
  const list = [s({ id: 'newer', startedAt: '2026-11-03T00:00:00Z', finishedAt: '2026-11-03T01:00:00Z' }), s({ id: 'resumed', startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-04T00:00:00Z' })]
  expect(chooseTalkTarget(list, { step: 'options', episodeId: null })).toEqual({ kind: 'episode', id: 'resumed' })
})
it('discover-10（つらい状態のサインに応える）: いちばん新しい場面がつらい状態のサインで終わっていたら、その会話を出さない', () => {
  expect(chooseTalkTarget([s({ id: 'a' })], { step: 'none', episodeId: null })).toEqual({ kind: 'rest' })
})
it('discover-10（つらい状態のサインに応える）: 次にできることを読めなかったら、つらい話を出さない側に倒す', () => {
  expect(chooseTalkTarget([s({ id: 'a' })], null)).toEqual({ kind: 'rest' })
})

// TalkEntry.test.tsx（renderApp と installFakeApi で）
it('discover-1（具体的な一日を一つ聞く）: 初めて開くと、場面を一つだけ作り、最初の問いが出る')
//   installFakeApi({ loggedIn: true, consented: true }); renderApp('/talk')
//   → FAKE_OPENING が出る。POST /api/episodes が 1 回
it('discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面があれば、開くとその場面の続きが出る')
//   episodes: [fakeEpisode({ id: 'episode-7' })] → URL が /talk/episode-7。POST は 0 回
it('discover-6（一場面ずつ区切り、続きから話せる）: ほかのタブで途中の場面ができていたら（409）、新しく作らずにその場面へ進む')
it('discover-12（開くとトークが出る）: 場面を作れなかったら、言葉と「もう一度」を出す（白い画面にしない）')
it('discover-10（つらい状態のサインに応える）: つらい状態のサインで終わったあとに開くと、会話を出さず、talk.rest と「別の日のことを話す」だけを出す')
//   nextStep: { step: 'none', episodeId: null } と話し終えた場面 1 つ → FAKE_DISTRESS_TEXT が出ない。copy.talk.rest が出る
//   「別の日のことを話す」を押すと POST /api/episodes が 1 回
it('discover-12（開くとトークが出る）: /home を開くと /talk へ進む')
it('foundation-2（始める前に保存するものを示す）: 了解したら、話す画面の最初の問いへ進む')
//   Start.test.tsx の了解のテストの行き先を、ホームのあいさつから FAKE_OPENING に変える
it('foundation-1（案内はログインなしで見られる）: ログインして了解した人が案内を開くと、トークへ進む')
//   Landing.test.tsx。了解していない人は /start へ。ログインしていない人には、いままでどおり案内が出る
it('foundation-3（いつでも全部消せる）: 全部消すと、その端末の書きかけも消える')
//   Settings.test.tsx。writeDraft('episode-1','あ') → 全部消す → readDraft('episode-1') === ''
```

ほかの画面のテストで、「ホームへ戻る」のリンクを `href="/home"` で確かめているものは、「トークに戻る」と `/talk` に直す（common-4 の題を変えるので、テスト名も「common-4（どの画面からもトークへ戻れ、幅に収まる）」にそろえる）。

- [ ] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test` / Expected: 新しいテストが FAIL（`/talk` のルートがない、行き先が `/home`）
- [ ] **Step 3: 上の Interfaces のとおりに書く。`Home.tsx` と `Home.test.tsx` を消す**
- [ ] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test` と `npm --prefix src/web run build` / Expected: PASS
- [ ] **Step 5: コミット**（Spec は Task 7 で直す。PR は Spec とそろえてから main に入れる）

```bash
git add -A src/web
git commit -m "開いたらトークが出るようにし、ホームをなくす。行き先は途中の場面、いちばん新しく話し終えた場面、新しい場面の順"
```

### Task 5: 話す画面の形（トーク、選択肢、入力の帯、書きかけ、メニュー板、PC）

**Files:**
- Create: `src/web/src/components/talk/TalkLayout.tsx`、`src/web/src/components/talk/MenuBoard.tsx`、`src/web/src/components/talk/ChoiceButtons.tsx`、`src/web/src/components/talk/AnswerBar.tsx`、`src/web/src/components/talk/Bubble.tsx`
- Modify: `src/web/src/pages/Talk.tsx`（処理は残し、見せ方を部品に移す）、`src/web/src/pages/TalkEntry.tsx`（`rest` を `TalkLayout` で出す）、`src/web/src/copy.ts`
- Test: `src/web/src/pages/Talk.test.tsx`、`src/web/src/components/talk/MenuBoard.test.tsx`

**Interfaces:**
- Consumes: `readDraft`、`writeDraft`、`clearDraft`（Task 3）、Tailwind の色名（Task 1）
- Produces:
  - `TalkLayout({ children, footer }: { children: ReactNode; footer?: ReactNode })`: 画面の高さ（`h-svh`）いっぱいの 3 段。上の帯（聞き手のアイコン、`copy.talk.listener`、その下に `copy.talk.title`）、`role="log"` のやりとり（ここだけが上下に動く。新しいやりとりで下まで動かす）、下の帯（`footer` とメニュー板）。`lg` 以上では、トークの列（`max-w-[640px]` 前後）を中央に、`MenuBoard` を右の列に縦に並べて、いつも開いて出す。話す画面の上の帯は、`Page` の「RE:VALUE」の代わり
  - `MenuBoard({ variant }: { variant: 'bottom' | 'side' })`: `nav` に `aria-label={copy.menu.label}`。6 つのタイル（Link）: `/episodes`、`/abilities`、`/profile`、`/options`、`/report`、`/settings`。`bottom` は初めたたんだ形（`copy.menu.open` のボタン、`aria-expanded`）、開くと 3 列 2 段と `copy.menu.close`。開いたかどうかは覚えない
  - `ChoiceButtons({ choices, onChoose, onOther })`: `role="group"`、`aria-label={copy.talk.choicesLabel}`。5 つ以上なら 2 列の格子、4 つ以下なら折り返して横に並べる。最後に点線の枠の `copy.talk.other`（押すと入力欄へ）。各ボタンは `min-w-0` で、長い言葉は折り返す
  - `AnswerBar({ value, onChange, onSend, sending, disabled, actions, inputRef, onFocusChange })`: 入力欄（1 行から広がる。`aria-label` は `copy.talk.inputLabel`、上限は `MAX_ANSWER_LENGTH`）と丸い「送る」ボタン（`aria-label={copy.talk.send}`）。`actions`（「ここで区切る」「この話は飛ばす」、または飛ばすときの確かめ）を入力欄のすぐ上に置く。`value` が空白でないときだけ、入力欄の下に `copy.talk.draftKept`
  - `Bubble({ role, children })`: 聞き手は左に `bg-surface`、本人は右に `bg-tint text-on-tint`。いまの `TurnBubble` を置き換える。場面の始まりに、`startedAt` の日付の札（`bg-chip`、日本時間で「11月6日（木）」の形。`lib/jst.ts` を使ってよい）
  - 話す画面の振る舞い
    - 書きかけ: 入力が変わるたびに `writeDraft(id, value)`。開いたとき、入力欄が空なら `readDraft(id)` を入れる。送れたとき（`onDone`）、区切ったとき、飛ばしたときに `clearDraft(id)`。送れなかったときは消さない
    - メニュー板（`bottom`）は、入力欄にフォーカスがあるあいだ隠す
    - 「ここで区切る」「この話は飛ばす」は、最初の問いのところでも出す。つらい状態のサインの 3 つの続け方を出しているあいだは出さない（いまのまま）
    - つらい状態のサインの案内、使いすぎのお知らせ、失敗の言葉は、やりとりの中にカード（`bg-surface`、角丸）で出す。言葉はいまのまま
    - 返事を待つあいだの `copy.talk.waiting` は、聞き手の側の吹き出しで出す
    - いまの話す画面の下の「ホームへ戻る」は消す（メニュー板と、Task 6 のボタンがその役をする）

- [ ] **Step 1: 失敗するテストを書く**（`Talk.test.tsx` に足す。いまのテストは、見つけ方（role と名前）が変わる所だけ直し、確かめる中身は変えない）

```ts
it('discover-11（書きかけを残す）: 書いている途中で閉じても、開き直すと入力欄に戻り、残っていることを伝える')
//   renderApp('/talk/episode-1') → 入力欄に「パート先に電話して、」と打つ → unmount → もう一度 renderApp
//   → 入力欄の値が「パート先に電話して、」。copy.talk.draftKept が出る
it('discover-11（書きかけを残す）: 送れたら書きかけは消える')
//   打つ → 送る → readDraft('episode-1') === ''
it('discover-11（書きかけを残す）: 送れなかったら（500）、入力欄にも保存にも残る')
//   api.state.reply = { status: 500, body: {} } → 打つ → 送る → 入力欄の値と readDraft が元の文
it('discover-11（書きかけを残す）: 保存できないブラウザでも、話す画面が出て送れる')
//   Storage.prototype.getItem / setItem が投げる → FAKE_OPENING が出る → 打って送ると返事が出る
it('discover-3（選んでも書いてもよい）: 選択肢が 5 つ以上なら 2 列の格子に並べ、最後に「それ以外（自分で書く）」を置く')
//   最初の問いの choices を 9 つにした場面 → group の中のボタンが 10。最後が copy.talk.other。押すと入力欄にフォーカス
it('discover-5（つらい話は飛ばせる）: 最初の問いのところでも「ここで区切る」と「この話は飛ばす」を押せる')
it('discover-12（開くとトークが出る）: メニュー板から、話したこと・見えた力・5 つの記録・仕事の選択肢・まとめ・設定へ行ける')
//   「メニューを開く」→ 6 つのリンクの href
it('discover-12（開くとトークが出る）: 入力欄に文字を打っているあいだは、メニュー板を隠す')
//   メニューを開く → 入力欄をクリック → メニュー（nav）が見えない → 入力欄から離れる（Tab）→ 見える
```

- [ ] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test -- Talk MenuBoard` / Expected: 新しいテストが FAIL
- [ ] **Step 3: 部品を書き、`Talk.tsx` を部品で組み直す。`TalkEntry` の `rest` も `TalkLayout` で出す。見た目はモック `talkopen.html`、`talkmid.html`、`menutalk.html` に合わせる（色は Tailwind の色名で。値を書き込まない）**
- [ ] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test` と `npm --prefix src/web run build` / Expected: PASS
- [ ] **Step 5: コミット**

```bash
git add -A src/web
git commit -m "話す画面を LINE のトークの形にする。選択肢の格子、入力の帯、書きかけ、メニュー板、PC では右にメニュー"
```

### Task 6: 区切ったとき（見えた力のカード、次の一手のボタン、今日はここまで）

**Files:**
- Create: `src/web/src/components/talk/AfterTalk.tsx`
- Modify: `src/web/src/components/Insights.tsx`（カードの見た目にする。`QuoteList` と `Hints` の書き出しは変えない。ほかの画面が使っている）、`src/web/src/pages/Talk.tsx`
- Test: `src/web/src/pages/Talk.test.tsx`

**Interfaces:**
- Consumes: `TalkLayout`、`Bubble`、`ChoiceButtons` の見た目（Task 5）、`getNextStep()`、`nextStepPath()`、`useStartEpisode()`
- Produces:
  - 話し終えた場面では、入力の帯を出さない。やりとりのあとに、札 `copy.talk.finishedChip`、その下に `Insights` をカード（`section`、`bg-surface`、角丸、枠）で出す。中身と言葉は変えない（先頭の `copy.insights.lead`、見えた力の名前と、核となる行動と本人の言葉の組、もう少し聞かせてほしいこと、手がかり）。カードの中に「読み取りを直す」（直す欄もカードの中で開く）、「この場面の続きを話す」（`canResume` のときだけ）、「見えた力をまとめて見る」（`/abilities`）
  - `AfterTalk({ distress }: { distress: boolean })`
    - `distress` が false: 聞き手の側に `copy.talk.afterQuestion`。その下に答えの例と同じ形のボタン: 次にできること（`step` が `conditions`、`options`、`deepen`、`report` のときだけ。言葉は `copy.home.next[step]`、行き先は `nextStepPath`）、`copy.talk.anotherDay`（新しい場面を始める。409 ならその場面へ）、`copy.talk.doneForToday`。次にできることを読めなかったときは、残りの 2 つだけ出す
    - 「今日はここまで」を押すと、ボタンを閉じ、聞き手の側に `copy.talk.doneForTodayReply` を出す。何も送らず、何も保存しない
    - `distress` が true（この場面がつらい状態のサインに応えたところで終わっている。いまの `notice?.kind === 'distress'` と同じ見分け方）: `copy.talk.afterQuestion` もボタンも出さず、相談先の案内のあとに、目立たせない `copy.talk.anotherDay` だけ
  - いまの話す画面の下の `NextStepLink` は、この部品に置き換える（話す画面では使わない）

- [ ] **Step 1: 失敗するテストを書く**

```ts
it('validate の「話し終えたとき」: 区切ると、見えた力がトークの中のカードに出て、核となる行動と本人の言葉が組になっている')
//   いまの Insights のテストの確かめ（行動の文と引用が組で出る、点数や状態の呼び名が出ない）を、カード（section）の中で行う
it('validate の「話し終えたとき」: カードの中から、読み取りを直せる')
it('common-3（次にできることを一つ示す）: 区切ったあと、次にできることのボタンと「別の日のことを話す」「今日はここまで」が出る')
//   nextStep: { step: 'options', episodeId: null } → copy.home.next.options のリンクが /options。3 つのボタン
it('common-3（次にできることを一つ示す）: 次にできることが talk のときは、「別の日のことを話す」を重ねない')
//   step: 'talk' → copy.home.next.talk のボタンは出ず、copy.talk.anotherDay が 1 つ
it('common-3（次にできることを一つ示す）: 「別の日のことを話す」で新しい場面を始め、最初の問いが出る')
it('discover-12（開くとトークが出る）: 「今日はここまで」で、ボタンを閉じて一言を出し、何も送らない')
//   押したあと api.calls が増えない。copy.talk.doneForTodayReply が出る。ボタンが消える
it('discover-10（つらい状態のサインに応える）: つらい状態のサインで終わった場面では、次の一手を勧めず、「別の日のことを話す」だけを出す')
//   notice が distress の話し終えた場面 → copy.talk.afterQuestion が出ない。copy.home.next.* のボタンが出ない。copy.talk.anotherDay が 1 つ
```

- [ ] **Step 2: 失敗するのを見る** — Run: `npm --prefix src/web test -- Talk` / Expected: 新しいテストが FAIL
- [ ] **Step 3: 書く。見た目はモック `talkend.html` に合わせる**
- [ ] **Step 4: 通るのを見る** — Run: `npm --prefix src/web test` と `npm --prefix src/web run build` / Expected: PASS
- [ ] **Step 5: コミット**

```bash
git add -A src/web
git commit -m "区切ったら、見えた力をトークの中のカードで出し、次の一手を答えの例と同じボタンで出す"
```

### Task 7: Spec と PRD とペルソナの資料を直し、実際のブラウザで確かめる

**Files:**
- Modify: `docs/specs/00-common.md`、`docs/specs/01-foundation.md`、`docs/specs/02-discover.md`、`docs/specs/03-validate.md`、`docs/specs/04-profile.md`、`docs/specs/05-options.md`、`docs/specs/06-deepen.md`、`docs/specs/07-report.md`、`docs/specs/00-tech-stack.md`（フォントの包み）、`docs/prd/3-features.md`、`evals/personas/how-to-judge.md`、`evals/personas/people/e-sayaka.md`

- [ ] **Step 1: Spec を、いまの正しい姿に直す**（経緯は書かない。CLAUDE.md の書き方に従う）
  - `00-common.md` の「画面」
    - 見た目の決まりを足す: 太めの丸ゴシック、6 色の役割と名前、暗い画面は端末の設定に合わせる、選んだ色と書きかけは端末のブラウザにだけ残す、コントラストの組（設計の 1 章の箇条のとおり）
    - 左上の「RE:VALUE」の行き先を `/talk` に。話す画面では上の帯がその代わり
    - ページのタイトルの一覧から「ホーム」を外す
  - `00-common.md` の「次にできること」
    - 「ホームの先頭に出す」を、「区切ったときのトークで、答えの例と同じ形のボタンで出す」に変える。「別の日のことを話す」と「今日はここまで」を書く
    - つらい状態のサインのあと（`none`）は、開いても会話を出さず、`talk.rest` と目立たせない「別の日のことを話す」だけにする
  - `00-common.md` の受け入れ基準
    - common-3 を、ホームでなくトークの区切ったときの形に書き直す
    - common-4 の題を「common-4（どの画面からもトークへ戻れ、幅に収まる）」に変える
    - common-5（どの色でも読める）を足す。中身は、6 色の明るい画面と暗い画面で、設計の 1 章の組がコントラストを満たすこと、端末の設定で暗い画面に変わること、保存できなくても、いつもの色で出ること。確かめ方は単体テスト
  - `01-foundation.md`
    - 画面の表からホームを外し、「話す（入口）」`/talk` を足す（行き先の順）
    - 案内: ログインして了解した人は `/talk` へ送る
    - はじめに: 了解したら `/talk` へ。foundation-2 の行き先
  - `02-discover.md`
    - 画面の表と振る舞いを、設計の 2 章のとおりに直す（開いたときの行き先、選択肢の並べ方、入力の帯と区切る・飛ばす、書きかけ、メニュー板、PC、区切ったとき）
    - 受け入れ基準に discover-11（書きかけを残す）と discover-12（開くとトークが出る）を足す。確かめ方は画面のテスト
    - 79 行目あたりの「ホームには『続きから』」を、開くとその場面が出る、に直す
  - `03-validate.md`〜`07-report.md`: 「ホームから入れる」「ホームへ戻る」を、「メニュー板から入れる」「トークに戻る」に直す。03-validate の画面の表の「ホーム」の行は、メニュー板の行にする。06-deepen は、メニュー板に置かず、仕事の選択肢と次にできることのボタンから入る、と書く
  - `00-tech-stack.md`: 画面の依存に `@fontsource/m-plus-rounded-1c` を書き、Geist を外す
  - `3-features.md` の revisit-5（また話せると一言添える）の「ホームを開いたとき」を「アプリを開いたとき」に
  - ペルソナの資料: 「ホームから続きを」を「開くと話していた場面が出る」「トークから」に直す
- [ ] **Step 2: 呼び名の数を確かめる**

Run: `grep -rn "common-4（どの画面からもホームへ戻れ" src tests docs` と `grep -rn "/home\b" src/web/src --include=*.tsx --include=*.ts`
Expected: 1 つ目は 0 件。2 つ目は `App.tsx` の `/home` を `/talk` へ送る 1 件と、そのテストだけ

- [ ] **Step 3: 実際のブラウザで確かめる**（Playwright の MCP。画面をビルドしてから `node evals/personas/driver/serve.mjs` で手元のサーバーを立て、`http://localhost:5080/.auth/login/google?dev_user=redesign-check` を開いてログインする（開発用の偽物のログイン。`evals/personas/README.md`）。サーバーは終わったら止める）
  - 幅 320px、375px×667px、375px×812px、1280px で、`/talk` の最初の問い、話している途中（メニュー板を開いた形）、区切ったとき
  - 横にはみ出さない（`document.documentElement.scrollWidth <= innerWidth`）。入力欄と「送る」が見えて押せる
  - `emulate_media` で `prefers-color-scheme: dark` にして、同じ 3 場面
  - 写真は `evals/results/` に置かない（スクラッチに置く）。気づいた崩れは直してから次へ
- [ ] **Step 4: 全部のテストを流す**

Run: `dotnet test --project tests/Revalue.Server.Tests`、`npm --prefix src/web test`、`npm --prefix src/web run build`、`node --test .claude/hooks/guard.test.mjs`
Expected: すべて PASS

- [ ] **Step 5: コミット**

```bash
git add docs src evals/personas/how-to-judge.md evals/personas/people/e-sayaka.md
git commit -m "Spec と PRD を、開くとトークが出る形と見た目の決まりに合わせる。書きかけを残す、開くとトークが出る、どの色でも読める、の基準を足す"
```
