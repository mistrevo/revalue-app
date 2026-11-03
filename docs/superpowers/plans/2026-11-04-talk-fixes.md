# 話す画面の小さな直し（11/6 の試用の前） Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（Workflow）で実行する。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 全体の流れの確認で残した 6 件のうち、試用者が最初の数回で出会う 3 件を直す。続きの最初の問いが、答えずに区切った問いと同じことを聞かないようにする。訂正をふつうの答えと分けて出す。2 つ目からの場面を、前とは別の一日を尋ねる問いで始める。

**Architecture:** 続きの問いの選び方（`EpisodeInsights.Reopen` と `ResumeTarget`）と、新しい場面の最初の問いの選び方（`POST /api/episodes`）を裏側で直す。訂正の見せ方は話す画面だけで直す。AI の呼び方は変えない。

**Tech Stack:** ASP.NET Core（.NET 10）Minimal API、React 19 + TypeScript + Tailwind CSS 4、xUnit v3、Vitest。

**Spec:** `docs/specs/02-discover.md`（場面の始まりと終わり、discover-1）、`docs/specs/03-validate.md`（訂正、続きを話す、validate-8、validate-11）。00-common.md と 00-tech-stack.md も読む。

## 直すこと（progress.md の「直さずに残したこと」から。番号はこの計画の中だけで使う）

- G1: 区切る前の最後の問いに答えずに「ここで区切る」を押し、あとで「続きを話す」を押すと、答えていない問いのすぐ下に、同じ行動を聞く続きの問いが並ぶ。続きの問いは「まだ 2 回聞いていない足りない行動」から選び、答えていない問いも 1 回に数えるので、同じ行動がもう一度選ばれる。続きを開いてすぐまた区切り、また続きを開いたときも、続きの問いが 2 つ並ぶ
- G2: 話し終えたあとに「読み取りを直す」で送った訂正が、やりとりのいちばん下に、本人の答えと同じ吹き出しで出る。AI の返事は続かないので、読み返すと AI が黙っているように見える
- G3: 新しい場面はいつも同じ問い（「…たとえば昨日、朝起きてから夜までに…」）で始まる。前に昨日のことを話した人も、また同じ言葉で聞かれ、前の話を覚えていないように見える

残すもの（この計画では直さない）: 確かめ中の力がレポートの 2 つの欄に出ること。話したことの一覧の見出しが最初の答えの書き出しになること。未ログインの案内で `/api/me` の 401 がコンソールに出ること。

## Global Constraints

- 裏側が決める言葉は各 Feature の `*Text.cs`、画面の文言は `src/web/src/copy.ts` に置く。「診断」「判定」「スコア」、点数、順位、状態の呼び名（根拠あり、要確認、未確認）を出さない（`00-common.md` の「言葉」）。使わない言葉のテスト（`DiscoverTextTests`、`copy.test.ts` など、いまあるもの）に新しい言葉も入ることを確かめる
- 新しい言葉は、この計画の案をそのまま使い、Spec に「（Claude の判断）」を添えて書く。開発者が確かめる項目として報告に残す
- 受け入れ基準の呼び名はタイトルとセットでテスト名（`DisplayName` / `it` の名前）に入れる
- Spec とコードは同じコミットで変える。Spec には「いまの正しい姿」だけを書き、経緯は書かない
- AI の呼び方（プロンプト、effort、構造化出力の形）と、評価（`evals/`）は変えない
- 幅 320px〜1280px のどれでも横にはみ出さない

## Review Focus

1. G1 の「答えていない最後の問い」の見分け方。訂正のターン（`AnswerKind.Correction`）は数えない。最後の聞き手のターンが締めの返事（問いのない 8 往復目）やつらい状態のサインへの応えのときは、行動を持たないので、いまの選び方のまま
2. G1 で、続きの問いを足さずに開き直したとき（最後のターンが答えていない続きの問い）、続きの途中で飛ばすと、前に話し終えていた姿（その続きの問いを含む）に戻ること。2 つの画面から同時に続きを開いたときの巻き戻し（`EpisodeStarter.ResumeAsync`）が、足したターンがなくても壊れないこと
3. G1 で避けた行動は、聞いた回数の数え方（`ValidationContext.AskedCounts`）を変えないこと。続きの中で、いつもの決まり（同じ行動は 2 回まで）で、もう一度聞かれうること
4. G3 の「話し終えた場面がある」は、本人の答え（訂正を除く）が 1 つ以上ある話し終えた場面で見る。答えずに区切っただけの場面や、飛ばして消えた場面しかない人には、いまの最初の問いを出す。飛ばしたあとの問い（`AfterSkip`）は変えない
5. G2 の訂正の表示が、話している途中に戻したあと（続きを話す）にも、やりとりの途中で正しく分かれて出ること。つらい状態のサインを含む訂正のあとの、決まった言葉の返事はいつもの吹き出しのまま

---

### Task 1: 続きの最初の問いが、答えずに区切った問いと同じことを聞かない（G1）

**Files:**
- Modify: `src/Revalue.Server/Features/Validate/ValidateEndpoints.cs`（`EpisodeInsights.ResumeTarget`、`EpisodeInsights.Reopen`、新しい `EpisodeInsights.UnansweredQuestion`）
- Modify (Spec): `docs/specs/03-validate.md`（「続きを話す」と validate-11（要確認の場面に戻れる））
- Test: `tests/Revalue.Server.Tests/ResumeTests.cs`

**Interfaces:**
- Produces: `public static Turn? UnansweredQuestion(EpisodeItem episode)` — 訂正のターン（`AnswerKind == AnswerKind.Correction`）を除いた最後のターンが聞き手（`TurnRoles.Assistant`）のターンなら、それを返す。そうでなければ null
- Changes: `ResumeTarget(EpisodeItem episode)` — いまの選び方に加えて、`UnansweredQuestion(episode)?.Target` を `ActionRef.Parse` した行動を選ばない。聞いた回数の数え方は変えない
- Changes: `Reopen(EpisodeItem episode, DateTimeOffset now)` — `episode.Turns[^1]` が聞き手のターンで、`Move == ResumeMove`（続きの問い）なら、問いを足さずに話している途中に戻す（`Turns` はそのまま。`Status`、`FinishedAt`、`TurnLimit`、`BeforeResume` はいまと同じに変える）。それ以外は、いまと同じく続きの問いを足す

- [ ] **Step 1: 失敗するテストを書く**（`ResumeTests.cs`。既存の `FinishedEpisode` などの道具を使う）
  - `[Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 答えずに区切った問いと同じ行動は、続きの最初の問いで聞かない")]`: 話し終えた場面の最後のターンが、足りない行動 X（例 `coordinating.3`）を聞いた答えていない問い。続きを開くと、最後の問いの `target` は X ではない。ほかに聞ける行動がなければ `target` は null で、文は `AbilityText.ResumeOpening(null, …)` の形（手がかりを添えない問い）
  - `[Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 答えずに区切った問いのあとに訂正があっても、その問いの行動は続きの最初の問いで聞かない")]`: 最後の問い（X）のあとに、X を打ち消さない訂正のターンを保存先に直接足す。続きの問いの `target` は X ではない
  - `[Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 続きの問いに答えずにまた区切ってから続きを開くと、問いを足さず、その問いから続ける")]`: 続きを開く → 答えずに区切る → 続きを開く。2 回目のあとの `turns` の数は 1 回目のあとと同じで、最後のターンは 1 回目の続きの問い（文、`target`、`choices` が同じ）。状態は話している途中、往復の上限は答えの数 + 4
  - `[Fact(DisplayName = "validate-11（要確認の場面に戻れる）: 問いを足さずに続きを開いた場面を飛ばすと、前に話し終えていた姿に戻る")]`: 上の 2 回目のあとに飛ばす（`/skip`）。場面は話し終えた状態で、`turns` は 2 回目に開く前と同じ
- [ ] **Step 2: 実行して失敗を確かめる**: `dotnet test --filter "FullyQualifiedName~ResumeTests"`。新しいテストが失敗する
- [ ] **Step 3: 実装する**（上の Interfaces のとおり）
- [ ] **Step 4: いまのテストを直す**: いまの `ResumeTests` には、最後のターンが答えていない問い（`coordinating.3`）のまま続きを開き、続きの問いが同じ行動を聞くことを確かめているものがある（例 `ResumeReopensWithHintQuestion`）。ほかのテストと同じく、保存先で最後の問いの `Target` を外してから続きを開く形に直し、確かめている中身（文、選択肢、一手の名前、`target`）は弱めない。新しい振る舞いのせいで期待が変わるテストは、何を確かめるテストかを読んでから直す
- [ ] **Step 5: 実行して通ることを確かめる**: `dotnet test`
- [ ] **Step 6: Spec を直す**（`03-validate.md`）
  - 「続きを話す」に足す（Claude の判断）: 区切る前の最後の問いに答えていないときは、同じことを聞く問いを続けて出さない。最後の問いが足りない行動を聞いていたら、続きの問いではその行動を選ばず、次の行動を選ぶ（なければ手がかりを添えない問い）。答えずに区切ったのは答えにくかったからかもしれないので、すぐには聞き直さない。その行動も、続きの中でいつもの決まり（同じ行動は 2 回まで）で聞くことがある。最後の問いが続きの問い（続きを開いて、答えずにまた区切った）なら、問いを足さず、その問いから続ける。最後の問いを見るとき、訂正のターンは数えない
  - validate-11（要確認の場面に戻れる）に足す: 区切る前の最後の問いに答えていなければ、同じことを聞く問いを続けて出さない
  - API の表の `POST /api/episodes/{id}/resume` の「続きの問いを足して返す」に、問いを足さないときがあることを書く
- [ ] **Step 7: コミット**: `git commit -m "答えずに区切った問いと同じことを、続きの最初の問いで聞かない（validate-11（要確認の場面に戻れる））"`

### Task 2: 2 つ目からの場面は、前とは別の一日を尋ねる（G3）

**Files:**
- Modify: `src/Revalue.Server/Features/Discover/DiscoverText.cs`（`OpeningAnotherDay` を足す）、`src/Revalue.Server/Features/Discover/DiscoverEndpoints.cs`（`POST /api/episodes`）
- Modify (Spec): `docs/specs/02-discover.md`（「場面の始まりと終わり」、API の表の `POST /api/episodes`、discover-1（具体的な一日を一つ聞く））
- Test: `tests/Revalue.Server.Tests/EpisodeTests.cs`、`tests/Revalue.Server.Tests/DiscoverTextTests.cs`（使わない言葉のテストが新しい文を見ていなければ足す）

**Interfaces:**
- Produces: `DiscoverText.OpeningAnotherDay = "前に話してくれた日とは別の、最近のある一日のことを、聞かせてください。その日の朝起きてから夜までに、どんなことがありましたか？"`（Claude の判断）。選択肢は `OpeningChoices` のまま。一手の名前は "opening" のまま
- Changes: `POST /api/episodes` — その人の場面に、本人の答え（`Role == User` で `AnswerKind != Correction`）が 1 つ以上ある話し終えた場面があれば `OpeningAnotherDay`、なければ `Opening` で始める。場面の一覧は `EpisodeStarter.StartAsync` を呼ぶ前に読む（`create` の中で読まない）

- [ ] **Step 1: 失敗するテストを書く**（`EpisodeTests.cs`）
  - `[Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 話し終えた場面があれば、新しい場面は、前とは別の一日を尋ねる問いで始まる")]`: 1 つ目の場面で答えを 1 つ保存して区切る → 2 つ目を始めると、最初のターンの文は `DiscoverText.OpeningAnotherDay`、選択肢は `OpeningChoices`
  - `[Fact(DisplayName = "discover-1（具体的な一日を一つ聞く）: 答えずに区切った場面しかなければ、新しい場面は、いつもの最初の問いで始まる")]`: 答えずに区切る → 2 つ目は `DiscoverText.Opening`
  - いまの `NewEpisodeStartsWithConcreteDayQuestion` はそのまま通ること（場面がない人は `Opening`）
- [ ] **Step 2: 実行して失敗を確かめる**: `dotnet test --filter "FullyQualifiedName~EpisodeTests"`
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 実行して通ることを確かめる**: `dotnet test`
- [ ] **Step 5: Spec を直す**（`02-discover.md`）
  - 「場面の始まりと終わり」の最初の問いの行に足す（Claude の判断）: 本人が答えた話し終えた場面がすでにあれば、「前に話してくれた日とは別の、最近のある一日のことを、聞かせてください。その日の朝起きてから夜までに、どんなことがありましたか？」で始める。前に話した日を同じ言葉で聞いて、前の話を覚えていないように見せないため。選択肢は同じ 3 つ
  - discover-1（具体的な一日を一つ聞く）に足す: 本人が答えた話し終えた場面があれば、前とは別の一日を尋ねる
  - API の表の `POST /api/episodes` に、最初の問いが 2 通りあることを書く
- [ ] **Step 6: コミット**: `git commit -m "2 つ目からの場面は、前に話した日とは別の一日を尋ねる問いで始める（discover-1（具体的な一日を一つ聞く））"`

### Task 3: 訂正を、ふつうの答えと分けて出す（G2）

**Files:**
- Modify: `src/web/src/pages/Talk.tsx`（やりとりの表示）、`src/web/src/copy.ts`（`talk.correctionLabel`）
- Modify (Spec): `docs/specs/03-validate.md`（「訂正」と、画面の表の「話す」の行）
- Test: `src/web/src/pages/Talk.test.tsx`

**Interfaces:**
- Consumes: `Turn.answerKind`（`api.ts`。訂正は `'correction'`）
- Produces: `copy.talk.correctionLabel = '読み取りを直した言葉'`（Claude の判断）
- Changes: やりとり（`role="log"`）の中で、`answerKind === 'correction'` のターンは、本人の答えの吹き出し（`TurnBubble`）ではなく、右に寄せた枠だけの囲み（塗りつぶさない。`rounded-2xl border px-4 py-2 text-sm`、幅は吹き出しと同じ `max-w-[85%]`）で出す。囲みの先頭に見出し `copy.talk.correctionLabel`（小さめの文字、`text-muted-foreground`）を出し、その下に訂正の文（`whitespace-pre-wrap`）。読み上げでは見出しが読まれるので、`sr-only` の「あなた」は付けない

- [ ] **Step 1: 失敗するテストを書く**（`Talk.test.tsx`。いまの訂正のテストと同じ偽物の API を使う）
  - `it('validate-8（訂正したら確かめ直す）: やりとりの中の訂正は、ふつうの答えと分けて「読み取りを直した言葉」として出る')`: 訂正を送ったあと、やりとりの中に `copy.talk.correctionLabel` が出て、その囲みの中に訂正の文がある。訂正の文が本人の答えの吹き出し（`copy.talk.you` の読み上げを持つもの）として出ていない
  - `it('validate-8（訂正したら確かめ直す）: 訂正のある場面を開き直しても、訂正は分けて出る')`: 訂正のターン（`answerKind: 'correction'`）を含む場面を読み込むと、同じ見せ方で出る
- [ ] **Step 2: 実行して失敗を確かめる**: `npm --prefix src/web test -- Talk`
- [ ] **Step 3: 実装する**
- [ ] **Step 4: 実行して通ることを確かめる**: `npm --prefix src/web test`、`npm --prefix src/web run build`、`npm --prefix src/web run lint`
- [ ] **Step 5: Spec を直す**（`03-validate.md`）
  - 「訂正」に足す（Claude の判断）: やりとりの中では、訂正を本人の答えの吹き出しと分け、「読み取りを直した言葉」という見出しを付けた囲みで出す。訂正には返事を作らないので、答えに AI が返事をしなかったように見せないため
  - 画面の表の「話す」の行に、やりとりの中の訂正の見せ方を一言足す
- [ ] **Step 6: コミット**: `git commit -m "やりとりの中の訂正を、ふつうの答えと分けて出す（validate-8（訂正したら確かめ直す））"`

---

## 確認コマンド

- `dotnet build`
- `dotnet test`
- `npm --prefix src/web ci`
- `npm --prefix src/web test`
- `npm --prefix src/web run build`
- `npm --prefix src/web run lint`
- `node --test .claude/hooks/guard.test.mjs`
- `dotnet run --project evals/Revalue.Evals -- --unit discover --dry-run`
- `dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`
