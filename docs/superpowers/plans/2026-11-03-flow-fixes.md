# 全体の流れの直し（11/6 の試用の前） Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（Workflow）で実行する。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 01〜07 を一人の利用者として通した確認で見つかった問題を直し、11/6 の試用で、利用者が次にすることを迷わず、どの幅でも操作が画面に収まるようにする。

**Architecture:** 「次にできること」を、裏側の新しい API（`GET /api/next-step`）でコードが決め、ホームと各画面の下に一つだけ示す。ほかの直しは、各まとまりの画面と文言と、続きの決まった選択肢の扱いを小さく直す。AI の呼び方は変えない。

**Tech Stack:** ASP.NET Core（.NET 10）Minimal API、React 19 + TypeScript + Tailwind CSS 4 + shadcn/ui、xUnit v3、Vitest、Playwright MCP。

**Spec:** `docs/specs/00-common.md`、`docs/specs/01-foundation.md`、`docs/specs/02-discover.md`、`docs/specs/03-validate.md`、`docs/specs/04-profile.md`、`docs/specs/05-options.md`、`docs/specs/06-deepen.md`、`docs/specs/07-report.md`。確認の報告の要点は下の「見つかったこと」に写した。

## 見つかったこと（確認の報告から。番号はこの計画の中だけで使う）

- F1（must）: ホームのボタンが折り返さず、幅 640〜1024px で横にはみ出す。768px で文書の幅が 972px になり、「設定」に届かない（`src/web/src/pages/Home.tsx:56` の `flex flex-col gap-3 sm:flex-row`）
- F2（must）: 一つの場面を話し終えても、次にすること（条件を入れる → 仕事の選択肢 → 深める → レポート）への道がない。話し終えた画面、見えた力、5 つの記録の下は「ホームへ戻る」だけ。ホームはいつも同じあいさつと、同じ重さの 8 つのボタン
- F3: 仕事の選択肢で「この案を選ぶ」を押しても、見えている範囲もフォーカスも変わらず、選べたか分からない。選んだカードにも「この案を選ぶ」が残る（`Options.tsx` の ChoiceArea、OptionCard）
- F4: 話している途中の画面にホームへの道がない。見出しの「RE:VALUE」は、ログインしていても案内（`/`）へ行く（`Talk.tsx`、`components/Page.tsx`）
- F5: 仕事の選択肢の「5 つの記録で条件を入れる」から来ても、5 つの記録で最初に聞かれるのは好み（条件は 3 問目）
- F6: 続きを話すときの受け止めの一文「また話しに来てくれて、ありがとうございます。」が、区切った直後に押しても出る（`AbilityText.ResumeLead`）
- F7: 続きの決まった選択肢「その日のほかのことを話したい」を選んでも、読み取りが具体的な出来事と読むと、同じ力の足りない行動を聞き続ける。「とくに思い当たりません」も特別に扱っていない（`NextMovePolicy`）
- F8: 見立てをすべて外したとき、レポートの「できること」は「話した出来事から見えた力を、ここに並べます。…」と出し、外したことに触れない。5 つの記録の画面は「外した見立ては、ここには出していません。見えた力の画面で戻せます。」と出す
- F9: つらい状態のサインで相談窓口を出しているあいだ、窓口の下の 3 つの続け方に加えて、その下に「ここで区切る」「この話は飛ばす」も出て、似た選択が 5 つ並ぶ
- F10: はじめに（`/start`）に、了解しない人の出口（ログアウト）がない
- F11: はじめにの「使い道」に、選んだ案を深めるときも AI に送ることが書かれていない。5 つ目の記録の呼び名が「大事にしたいこと」で、5 つの記録とレポートの「自分で選び、動き出すときに大事にしたいこと」とずれる
- F12（nit）: レポートを読み込めなかったとき、ホームへの道が出ない（`Report.tsx` の失敗の表示）。1 日の上限の言葉「また続きを話せます」が仕事の選択肢の画面にもそのまま出る。深める画面の中で「仕事の選択肢へ戻る」と「仕事の選択肢に戻る」がゆれる。レポートの「深める画面で直す」が画面の名前「選んだ案を深める」とずれる。深める画面の「まだ確かめていないこと」に、道具の名前だけが出る（レポートは「要る知識や道具（…）」と添える）。どの画面もページのタイトルが同じ

残したもの（この計画では直さない。progress.md の確認事項に書く）: 区切る前の答えていない問いと、続きの最初の問いが同じ行動を聞いて 2 つ並ぶこと。訂正がふつうの答えと同じ吹き出しで出ること。確かめ中の力がレポートの 2 つの欄に出ること。話したことの一覧の見出しが最初の答えになること。2 つ目の場面も最初の問いが同じこと。未ログインの案内で `/api/me` の 401 がコンソールに出ること。

## Global Constraints

- 文言はすべて `src/web/src/copy.ts`（裏側が決める言葉は各 Feature の `*Text.cs`）に置く。「診断」「判定」「スコア」、点数、順位、状態の呼び名（根拠あり、要確認、未確認）を出さない（`00-common.md` の「言葉」）
- 「次にできること」は進み具合の点数や割合、済んだ数に見せない。一つだけ示し、どこから進めてもよいと添える（芯 5（本人が選ぶ））
- 新しい文言と、変えた文言は、計画の中の案を出発点にし、決めた言葉に「（Claude の判断）」を添えて Spec に書く。開発者が確かめる項目として報告に残す
- 受け入れ基準の呼び名はタイトルとセットで、テスト名に入れる。新しい基準は common-3（次にできることを一つ示す）
- Spec とコードは同じコミットで変える。Spec には「いまの正しい姿」だけを書く
- AI の呼び方（プロンプト、effort、構造化出力の形）は変えない
- 幅 320px〜1280px のどれでも横にはみ出さない

## Review Focus

1. 「次にできること」の決め方が、記録の組み合わせの境目で正しいか。話している途中の場面があるとき、条件がないとき、使える力がなく外した力だけのとき、保留のとき、選んだ案が変わって深めた中身が古いとき
2. 了解の文を変えたので、版を上げ、了解済みの人が了解し直すまでほかの API が使えないこと（既存の RequireConsent の振る舞い）。テストが `ConsentInfo.CurrentVersion` を使っていること
3. 続きの決まった選択肢の扱いが、選択肢を選んだときだけ（書いた答えでは働かない）で、続きの問いへの答えのときだけ働くこと。validate-5（選んだだけでは根拠にしない）を崩さないこと
4. 相談窓口を出しているあいだに隠した「ここで区切る」「この話は飛ばす」が、窓口の 3 つの続け方で同じことができ、操作の出口が減っていないこと（discover-5（つらい話は飛ばせる）、discover-10（つらい状態のサインに応える））
5. ホームのボタンが、640px、768px、1024px、1280px で折り返して収まること

---

### Task 1: 次にできることを決める API と、ホーム

**Files:**
- Create: `src/Revalue.Server/Features/Home/NextStep.cs`（決め方）、`src/Revalue.Server/Features/Home/NextStepEndpoints.cs`
- Modify: `src/Revalue.Server/Program.cs`（Map を足す）、`src/web/src/api.ts`、`src/web/src/pages/Home.tsx`、`src/web/src/copy.ts`（`home`）、`src/web/src/test/fake-api.ts`
- Modify (Spec): `docs/specs/00-common.md`（「画面」に次にできることの決まり、受け入れ基準に common-3）、`docs/specs/01-foundation.md`（ホームの行）
- Test: `tests/Revalue.Server.Tests/NextStepTests.cs`（単体）、`tests/Revalue.Server.Tests/NextStepApiTests.cs`（結合）、`src/web/src/pages/Home.test.tsx`

**Interfaces:**
- Produces: `GET /api/next-step` → `{ "step": "continue" | "talk" | "conditions" | "abilities" | "options" | "deepen" | "report", "episodeId": string | null }`。ログインと了解が要る（`RequireConsent`）。1 日の送信回数は使わない。AI は呼ばない。ログには時間だけを書く
- Produces: `api.ts` に `type NextStep = { step: NextStepKind; episodeId: string | null }` と `getNextStep(): Promise<NextStep>`
- Consumes: `OptionsInputsReader`（`Check` の Readiness）、選んだ案（`OptionsItem.Choice`）、深めた中身（`DeepenItem` と `DeepenTarget` で、いまの選んだ案の中身があり古くないか。レポートの `ReportBuilder` と同じ判定を使ってよい）、話している途中の場面（`EpisodeItem.Status == Talking`）

- [ ] **Step 1: 決め方の単体テストを書く**（`NextStepTests`、表で回す）。上から順に最初に当たるものを返す（Claude の判断）
  1. 話している途中の場面がある → `continue`（その場面の id）
  2. 話し終えた場面がない → `talk`
  3. 条件が入っていない（Readiness が NeedsConditions）→ `conditions`
  4. 使える力がない（NeedsAbility）→ `talk`。外した力だけ（OnlyExcluded）→ `abilities`
  5. まだ選んでいない → `options`
  6. カードか自分の仕事を選んでいて、いまの案で深めた中身がない、または古い → `deepen`
  7. それ以外（保留、深めた中身がある）→ `report`
  テスト名は `common-3（次にできることを一つ示す）: …` にする
- [ ] **Step 2: 落ちることを確かめる**（`dotnet test --filter NextStep`）
- [ ] **Step 3: `NextStep.Decide(...)` と API を実装する**。入力は記録から読んだ値だけにし、読み取りは一度ずつにする
- [ ] **Step 4: 結合テスト**（`NextStepApiTests`）: 了解していない人は使えない。話し終える → `conditions`、条件を入れる → `options`、選ぶ → `deepen`、深める → `report`、保留 → `report`、新しい場面を始める → `continue`
- [ ] **Step 5: ホームを直す**
  - ボタンの並びを、どの幅でも収まる形にする（F1）。`sm:flex-row` をやめ、縦に並べるか、`sm:grid-cols-2` の格子にする。読みやすい幅（`max-w-xl`）を越えない
  - 先頭に「次にできること」の欄を置き、`getNextStep()` の結果のボタンを一つだけ目立たせて出す（F2）。下に「どこから進めてもかまいません。」を添える。いまの「話す」「続きから話す」のボタンは、この欄にまとめる（`continue` なら続きから話す、`talk` なら新しい場面を作る。いまの `start()` と 409 の扱いをそのまま使う）
  - 文言の案（Claude の判断。`copy.home.next`）: 見出し「次にできること」。`talk`「最近のある一日のことを話す」、`continue`「話している途中の場面の続きを話す」、`conditions`「使える時間と場所を、5 つの記録に入れる」、`abilities`「外した見立てを、見えた力の画面で見直す」、`options`「仕事の選択肢を見て、一つ選ぶか保留する」、`deepen`「選んだ案を深める」、`report`「可能性レポートで、ここまでのまとめを見る」
  - あいさつ: 話し終えた場面があるときは、初めての人向けの「ここから、最近の一日の話を始めます。」を出さず、「ここから、続きを進められます。」のような言い方にする（案。Claude の判断）
  - `getNextStep()` が失敗したら、欄を出さずに、いままでどおり「話す」を出す（行き止まりを作らない）
- [ ] **Step 6: 画面のテスト**（`Home.test.tsx`）: 7 つの step それぞれのボタンの言葉と行き先、失敗したときに「話す」が出ること、ボタンの並びに `sm:flex-row` がないこと
- [ ] **Step 7: Spec を直す**: `00-common.md` の「画面」に「次にできること」の決まり（上の順、一つだけ、どこからでもよいと添える、点数や割合にしない）を書き、受け入れ基準に `3. common-3（次にできることを一つ示す）: … 確かめ方: 単体テスト、結合テスト、画面のテスト` を足す。`01-foundation.md` のホームの行を、いまの姿（次にできること、各画面への道、設定）に直し、API の表に `GET /api/next-step` を足す
- [ ] **Step 8: 確認してコミット**: `dotnet build`、`dotnet test`、`npm --prefix src/web test`、`npm --prefix src/web run build`

### Task 2: 各画面から次の一歩への道と、画面の小さな直し

**Files:**
- Create: `src/web/src/components/NextStepLink.tsx`
- Modify: `src/web/src/pages/Talk.tsx`（話し終えた画面）、`Abilities.tsx`、`Profile.tsx`、`Options.tsx`、`Report.tsx`、`Deepen.tsx`、`src/web/src/copy.ts`、裏側の `ReportEndpoints.cs` / `ReportBuilder.cs`（下の F8 の印）
- Modify (Spec): `02-discover.md`、`03-validate.md`、`04-profile.md`、`05-options.md`、`06-deepen.md`、`07-report.md` の「画面」
- Test: 各画面の `*.test.tsx`、`tests/Revalue.Server.Tests/ReportApiTests.cs`

**Interfaces:**
- Consumes: Task 1 の `getNextStep()` と `copy.home.next`
- Produces: `NextStepLink({ refreshKey?: unknown })`。`getNextStep()` を呼び、結果の step へのリンクを一つ出す（`talk` はホームへ、`continue` はその場面へ）。いまいる画面と同じ行き先なら出さない。失敗したら何も出さない。`refreshKey` が変わったら読み直す

- [ ] **Step 1: 画面のテストを先に書く**（呼び名は関係するまとまりのもの）
  - 話し終えた画面（discover-6（一場面ずつ区切り、続きから話せる））、見えた力の画面、5 つの記録の画面の下に、次にできることへの道が一つ出る（common-3（次にできることを一つ示す））
  - 5 つの記録で条件を保存したら、次にできることを読み直して「仕事の選択肢」への道に変わる
  - 仕事の選択肢の「5 つの記録で条件を入れる」は `/profile?ask=conditions` へ行き、5 つの記録はそのとき条件を最初に聞く（F5。profile-4（本人が直せる）の画面）
  - 仕事の選択肢で「この案を選ぶ」を押すと、「選んだ案」の見出しにフォーカスが移り（`tabIndex={-1}` と `focus()`、`scrollIntoView` があれば呼ぶ）、選んだカードのボタンは「選んでいます」と出て押せない（F3）
  - レポート: 見立てを外していて、できることが空のときは、5 つの記録の画面と同じ「外した見立ては、ここには出していません。見えた力の画面で戻せます。」を出す（F8。report-1（一つにまとめて示す））。読み込めなかったときもホームへの道を出す（F12）
  - 深める画面: 「仕事の選択肢へ戻る」の言葉を一つにそろえ、まだ確かめていないことの知識や道具の行に「要る知識や道具（…）」と添える（F12。レポートの `taskKnowledge` と同じ言い方）
  - レポートの考え方の欄の道を「選んだ案を深める画面で直す」にする（F12）
  - 仕事の選択肢の画面で 1 日の上限に当たったときの言葉が、話す画面向けの「また続きを話せます」にならない（F12。foundation-6（使いすぎを穏やかに止める））
- [ ] **Step 2: 落ちることを確かめる**（`npm --prefix src/web test`）
- [ ] **Step 3: 実装する**。F8 のために、裏側のレポートの中身に「本人が外した力があるか」（`abilitiesExcluded: boolean`。`AbilityBookItem.Excluded` が空でないか）を足す。前の版には足さない。結合テストを 1 件足す
- [ ] **Step 4: テストが通ることを確かめる**
- [ ] **Step 5: Spec を直す**（各まとまりの「画面」に、次にできることへの道、条件から聞く入口、選んだあとのフォーカス、外したときの一言、言葉のそろえ）
- [ ] **Step 6: 確認してコミット**

### Task 3: 話す画面と、はじめに

**Files:**
- Modify: `src/web/src/pages/Talk.tsx`、`src/web/src/components/Page.tsx`、`src/web/src/pages/Start.tsx`（はじめに）、`src/web/src/copy.ts`、`src/web/src/App.tsx` または各画面（ページのタイトル）、`src/Revalue.Server/Features/Validate/AbilityText.cs`（ResumeLead）、`src/Revalue.Server/Features/Discover/NextMovePolicy.cs` と、続きの選択肢を見分けるところ、`src/Revalue.Server/Features/Foundation/Consent/ConsentEndpoints.cs`（`CurrentVersion`）
- Modify (Spec): `01-foundation.md`、`02-discover.md`、`03-validate.md`
- Test: `Talk.test.tsx`、`Start.test.tsx`（なければ作る）、`tests/Revalue.Server.Tests/` の NextMovePolicy と続きを話す結合テスト、了解のテスト

- [ ] **Step 1: テストを先に書く**
  - 話している途中の画面に「ホームへ戻る」がある。話は残り、ホームの次にできることは `continue` になる（F4。discover-6（一場面ずつ区切り、続きから話せる））
  - ログインして了解した人の画面では、見出しの「RE:VALUE」がホーム（`/home`）へ行く。案内とはじめにでは、いままでどおり `/`（F4）
  - 相談窓口を出しているあいだは、下の「ここで区切る」「この話は飛ばす」を出さない。窓口の 3 つの続け方（続けて話す、今日はここで区切る、この話は残さずに別の話にする）は出ている（F9。discover-10（つらい状態のサインに応える）、discover-5（つらい話は飛ばせる））
  - 続きの最初の問いの受け止めの一文が、時間に依らない言い方になる（F6。案: 「この場面の続きを、少し聞かせてください。」。Claude の判断）。いまの文を写しているテストは直す
  - 続きの問いに、決まった選択肢「その日のほかのことを話したい」を選んで答えたら、次の一手は足りない行動ではなく「その日にしたこと」を聞く（AskWhatYouDid）。「とくに思い当たりません」を選んだら、その問いで聞いた行動を、聞いた回数の上限に届いたものとして扱い、同じ行動を聞き直さない（F7。validate-2（足りない行動だけ聞き返す）、validate-11（要確認の場面に戻れる））。どちらも、選択肢を選んだ答え（AnswerKind が選んだ答え）で、直前の聞き手の一手が続きの問いのときだけ働く。同じ言葉を書いた答えでは働かない
  - はじめにに「了解せずにやめる（ログアウト）」があり、`/.auth/logout` へページごと移動する（F10。foundation-2（始める前に保存するものを示す））
  - はじめにの「使い道」に、選んだ案を深めるときも、5 つの記録と選んだ案を AI に送ることが入る。保存するものの 5 つ目の記録を「動き出すときに大事にしたいこと」にそろえる（F11）。了解の版（`ConsentInfo.CurrentVersion`）を上げる（案: `2026-11-03-2`）。了解済みの人は、次に開いたときに了解し直す
  - 画面ごとにページのタイトルを変える（例「話す — RE:VALUE」。F12）
- [ ] **Step 2: 落ちることを確かめる**
- [ ] **Step 3: 実装する**。続きの選択肢の見分けは、`AbilityText.ResumeChoices` の決まった言葉と一字一句同じかで見る
- [ ] **Step 4: テストが通ることを確かめる**。`dotnet run --project evals/Revalue.Evals -- --unit discover --dry-run` と `--unit validate --dry-run` も通す
- [ ] **Step 5: Spec を直す**（`01-foundation.md` のはじめにの文と了解の版、`02-discover.md` の話している途中の道とつらい状態のサインのときの操作、`03-validate.md` の続きの受け止めの一文と決まった選択肢の扱い）
- [ ] **Step 6: 確認してコミット**

### Task 4: 実際のブラウザで通し、Spec を合わせる

- [ ] **Step 1**: Development（偽のログインと偽物の AI）で起動し、Playwright MCP で幅 375px、768px、1280px を通す。ホームのはみ出しは 320、640、768、1024px でも `document.documentElement.scrollWidth` を測る
  - 流れ: はじめに（了解せずにやめる道があること）→ ホーム（次にできること: 話す）→ 話す途中でホームへ戻る（次にできること: 続きを話す）→ 話し終える（話し終えた画面に次の道）→ 条件を入れる（仕事の選択肢への道に変わる）→ 仕事の選択肢で選ぶ（選んだ案へフォーカス）→ 深める → ホーム（次にできること: レポート）→ レポート
  - 仕事の選択肢の「5 つの記録で条件を入れる」から入ると、条件から聞かれること
  - コンソールのエラーと警告が、わざと起こしたもの以外 0 件
- [ ] **Step 2**: 見つかったずれを直し、Spec を結果に合わせる。画面の写しは `.playwright-mcp/` に置く
- [ ] **Step 3**: 確認してコミット

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
- `dotnet run --project evals/Revalue.Evals -- --unit options --dry-run`
- `dotnet run --project evals/Revalue.Evals -- --unit deepen --dry-run`
