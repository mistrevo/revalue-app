# 話す・確かめるの小さな直し Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（`.claude/workflows/run-plan.js`）で回す。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 最初の問いを「気持ちが動いた日」を聞く形に変え、revisit-4（いまの話を聞き切る）を先に作り、優先順位をつける力の 3 つ目（決めた理由や基準）を推し量りで根拠にしないようにする。

**Architecture:** 最初の問いは、裏側が決める言葉（`DiscoverText`）と、どの問いで始めるかを決めるエンドポイントで変える。聞き返す力を一つに絞るのは、次の一手を決めるコード（`NextMovePolicy`）で行う。AI に任せるのは、聞き手の指示（`listener.md`）と読み取りの指示（`reader.md`）の文言だけ。

**Tech Stack:** ASP.NET Core（.NET 10）、xUnit v3、React と TypeScript（Vitest）、評価は `evals/Revalue.Evals`（本物の Claude）

**Spec:** 設計 `docs/superpowers/specs/2026-11-05-persona-eval-and-listening-design.md` の「小さな変更（順番 2）」。正しい姿は `docs/prd/4-rules.md` の「最初の問い」「対話の決まり」、`docs/prd/3-features.md` の discover-1（具体的な一日を一つ聞く）と revisit-4（いまの話を聞き切る）。直す Spec は `docs/specs/02-discover.md` と `docs/specs/03-validate.md`

## Global Constraints

- 回答・文書・コミットメッセージは日本語。受け入れ基準の呼び名は、必ずタイトルとセットで書く（例: discover-1（具体的な一日を一つ聞く））
- テスト名（`DisplayName`）は、受け入れ基準の呼び名とタイトルで始める。revisit-4 のテストは `revisit-4（いまの話を聞き切る）: …` とする
- 最初の問い: 「最近、気持ちが動いた日のことを、一つ聞かせてください。どんな日でしたか？」
- 最初の問いの選択肢（この順）: 「うまくいったと感じた日」「大変だったけど、乗り切った日」「思うようにいかなかった日」
- 2 つ目からの場面の問い: 「また、最近、気持ちが動いた日のことを、一つ聞かせてください。どんな日でしたか？」。選択肢は最初の問いと同じ 3 つ
- いちばん新しい話し終えた場面が、つらい状態のサインで力の確かめに使わない場面（`ExcludedFromValidation`）なら、気持ちは聞かず、いまの `OpeningAnotherDay` の文（「また、最近のある一日のことを、聞かせてください。特別な日でなくてかまいません。その日の朝起きてから夜までに、どんなことがありましたか？」）と、いまの `OpeningChoices`（「家族と出かけた」「家で過ごした」「人と会った」）を使う
- 「この話は飛ばす」のあとの問い（`AfterSkip`）と選択肢は変えない
- 画面と AI の言葉に、使わない言葉（`src/shared/forbidden-words.json`）、状態の呼び名、点数、順位を出さない
- 本物の AI を呼ぶのは評価だけ。テストでは偽物を使う
- 鍵、実在の人の情報、開発者の名前を書かない。台本はすべて架空にし、「このハッカソンの期間中に新しく書いた」と書く
- ホームの「最近のある一日のことを話す」（`src/web/src/copy.ts` と `docs/specs/00-common.md` の表）は変えない（Claude の判断。ボタンの名前で、問いの言葉ではないため）

## Review Focus

- 最初の問いの選択肢を選んだだけの答え（例:「思うようにいかなかった日」）: 根拠にせず、責めずに、その日にあったことを一つ聞く。聞き手が「なぜうまくいかなかったのですか」と理由を問い詰めない
- つらい状態のサインで終わった人が次の場面を始めたとき: 「思うようにいかなかった日」を含む気持ちの問いが出ない
- 聞き返す力を一つに絞ったあと、その力が根拠ありになるか聞き切ったら、別の力の足りない行動を追いかけて聞かない。ほかの力の行動が本人の話に出てきたら、根拠としては拾う
- 続きを話す（validate-11（要確認の場面に戻れる））で戻った場面: 続きの問いで聞いた力が、絞る力になる
- 優先順位をつける力の 3 つ目: 「期限を確かめた」「調べた」のような事実だけでは根拠にしない。本人が理由や基準を言葉にしたときは、これまでどおり根拠にする

---

### Task 1: 最初の問いを、気持ちが動いた日を聞く形にする

**Files:**
- Modify: `src/Revalue.Server/Features/Discover/DiscoverText.cs`（`Opening`、`OpeningAnotherDay`、`OpeningChoices` を変え、`OpeningAfterDistress`、`OpeningAfterDistressChoices` を足す）
- Modify: `src/Revalue.Server/Features/Discover/DiscoverEndpoints.cs:62-72`（どの問いで始めるかを決める）
- Modify: `src/Revalue.Server/Ai/Prompts/listener.md`（`AskWhatYouDid` に、出来事をまだ話していないときの聞き方を足す）
- Modify: `docs/specs/02-discover.md`（discover-1（具体的な一日を一つ聞く）の受け入れ基準と、最初の問いを書いた振る舞いの節）
- Modify: `docs/prd/4-rules.md`（「最初の問い」の 4 つ目の箇条書きと、「別の日の入口」の表の 1 行目）、`docs/prd/3-features.md`（revisit-7（つらい話を持ち出さない）の括弧）、`docs/prd/6-quality.md`（つらい状態のサインで終わった人の行）、`docs/decisions/2026-11-05-opening-question.md`（表の 4 行目）
- Test: `tests/Revalue.Server.Tests/DiscoverTextTests.cs`、`tests/Revalue.Server.Tests/EpisodeTests.cs`

**Interfaces:**
- Produces: `DiscoverText.Opening`、`DiscoverText.OpeningAnotherDay`、`DiscoverText.OpeningChoices`（文言は Global Constraints）、`DiscoverText.OpeningAfterDistress`（いまの `OpeningAnotherDay` の文）、`DiscoverText.OpeningAfterDistressChoices`（いまの `OpeningChoices`）

- [x] **Step 1: 失敗するテストを書く**

`DiscoverTextTests.cs`:
- `discover-1（具体的な一日を一つ聞く）: 最初の問いは、気持ちが動いた日を聞き、うまくいかなかった日も同じ重さで選べる` — `Opening` と `OpeningChoices` が Global Constraints の文と一字一句同じ。`OpeningChoices.Count == 3`
- `discover-1（具体的な一日を一つ聞く）: 2 つ目からの問いは「また」で始まり、選択肢は最初の問いと同じ` — `OpeningAnotherDay.StartsWith("また、")`、`OpeningAnotherDay != Opening`
- `discover-1（具体的な一日を一つ聞く）: つらい状態のサインで終わった人の問いは、気持ちを聞かない` — `OpeningAfterDistress` と `OpeningAfterDistressChoices` に「気持ち」「うまくいかなかった」「思うように」を含まない。選択肢は 3 つ
- 使わない言葉のテスト（いまの `DiscoverTextTests.cs:79` の一覧）に、新しい 4 つの言葉を足す

`EpisodeTests.cs`（結合テスト）:
- いまの 3 つのテスト（45、65、85 行目）を、新しい文で通るように直す
- `discover-1（具体的な一日を一つ聞く）: いちばん新しい話し終えた場面がつらい状態のサインで終わっていれば、新しい場面は気持ちを聞かない問いで始まる` — 話し終えた答えのある場面を 1 つ置き、その次に `ExcludedFromValidation = true` で話し終えた場面を置いてから `POST /api/episodes`。最初のターンが `OpeningAfterDistress`、選択肢が `OpeningAfterDistressChoices`
- `discover-1（具体的な一日を一つ聞く）: つらい状態のサインの場面のあとに、ふつうに話し終えた場面があれば、「また」の気持ちの問いに戻る` — 順番を逆にして、`OpeningAnotherDay`

- [x] **Step 2: テストが失敗することを確かめる**

Run: `dotnet test --filter "FullyQualifiedName~DiscoverTextTests|FullyQualifiedName~EpisodeTests"`
Expected: 新しいテストが FAIL

- [x] **Step 3: `DiscoverText` を変え、`DiscoverEndpoints` で問いを選ぶ**

いちばん新しい場面は、本人が答えた話し終えた場面（いまの `answered` と同じ条件）のうち `StartedAt` がいちばん新しいもの。それが `ExcludedFromValidation` なら `OpeningAfterDistress`、ほかは `OpeningAnotherDay`、なければ `Opening`。`EpisodeItem.Start` に渡す選択肢も、問いと組で選ぶ。`DiscoverText` の各定数の `<summary>` に、どの場面で使うかと理由（重い日に話を戻さない）を書く。

- [x] **Step 4: 聞き手の指示を足す**

`listener.md` の `AskWhatYouDid` に 1 文足す: 本人がまだ出来事を話していないとき（最初の問いの答えの例を選んだだけのときなど）は、映し返しを書かず、受け止める一文のあと、その日にどんなことがあったかを一つ聞く。うまくいかなかった日を選んだ人に、理由やうまくいかなかったわけを聞かない。

- [x] **Step 5: PRD と Spec を直す**

- `docs/prd/4-rules.md`「最初の問い」の 4 つ目: 「話を飛ばしたあとの問いと、つらい状態のサインに応えたところで終わった人の入口では、気持ちが動いた日を聞かず、ふだんの一日を聞く。重い日に話を戻さないため」
- 同「別の日の入口」の表の 1 行目の 2 列目: 「気持ちが動いた日を聞かず、ふだんの一日を聞く。選択肢も出来事の種類にする。前の話にも一歩にもふれない」。例: 「また、最近のある一日のことを、聞かせてください。特別な日でなくてかまいません」
- `docs/prd/3-features.md` revisit-7 の括弧を「（気持ちが動いた日ではなく、ふだんの一日を聞く）」に、`docs/prd/6-quality.md` の該当行の後半を「気持ちが動いた日を聞かない」に、決定記録の表の 4 行目を同じ内容に直す（Claude の判断と添える）
- `docs/specs/02-discover.md` の discover-1 の基準と、最初の問いを書いた節（64 行目付近）を、3 つの問い（初めて、2 つ目から、つらい状態のサインのあと）に直す。「最近のある一日」「たとえば昨日」が残らないこと

- [x] **Step 6: テストが通ることを確かめる**

Run: `dotnet test`
Expected: すべて PASS（`ClaudeConversationAiTests`、`EvalsTests`、`ResumeTests` は `DiscoverText` を参照しているだけなので、文を変えても通る）

- [x] **Step 7: コミット**

```bash
git add src/Revalue.Server/Features/Discover src/Revalue.Server/Ai/Prompts/listener.md tests/Revalue.Server.Tests docs/specs/02-discover.md docs/prd docs/decisions
git commit -m "最初の問いを、気持ちが動いた日を聞く形にする（discover-1（具体的な一日を一つ聞く））"
```

---

### Task 2: 聞き返す力を、場面の中で一つに絞る（revisit-4（いまの話を聞き切る））

**Files:**
- Modify: `src/Revalue.Server/Features/Discover/NextMovePolicy.cs`（`ValidationContext` に `Focus` を足し、`MissingActionToAsk` で使う）
- Modify: `src/Revalue.Server/Ai/Prompts/listener.md`（`AskWhatYouDid` の例から「どうやって〜しましたか？」を外し、行動の細部を聞かないと足す）
- Modify: `docs/specs/03-validate.md`（validate-2（足りない行動だけ聞き返す）の基準と、次の一手を書いた振る舞いの節）
- Test: `tests/Revalue.Server.Tests/NextMovePolicyTests.cs`

**Interfaces:**
- Consumes: `ActionRef`（`Ability` と行動の番号）、`Turn.Target`（聞いた行動。`ActionRef.Parse` で読む）
- Produces: `ValidationContext` の位置引数の最後に `Ability? Focus = null`。`ValidationContext.From(turns, evidence)` が、この場面でいちばん新しく行動を添えた聞き手のターン（足りない行動を聞く一手と、続きの問い）の力を `Focus` に入れる

- [x] **Step 1: 失敗するテストを書く**

`NextMovePolicyTests.cs`:
- `revisit-4（いまの話を聞き切る）: 一度聞き返した力があれば、ほかの力に行動が多くても、その力の足りない行動を聞く` — 根拠: 見立てる力の 1、優先順位をつける力の 1 と 3。`Focus = Ability.Noticing`、見立てる力の 2 を 1 回聞いた。期待: `AskMissingAction`、見立てる力の行動（2 か 3）
- `revisit-4（いまの話を聞き切る）: 絞った力が根拠ありになったら、ほかの力の足りない行動は聞かない` — 根拠: 見立てる力の 1〜3（同じ出来事）、調整する力の 1。`Focus = Ability.Noticing`。期待: `AskWhatYouDid`
- `revisit-4（いまの話を聞き切る）: 絞った力の行動を聞き切ったら、ほかの力に移らない` — 見立てる力の 2 と 3 を 2 回ずつ聞いた。根拠: 見立てる力の 1、調整する力の 1 と 2。期待: `AskWhatYouDid`
- `revisit-4（いまの話を聞き切る）: まだ聞き返していない場面では、いまの決め方で一つ選ぶ` — `Focus = null` で、いまの `MostCompleteAbilityFirst` と同じ結果
- `revisit-4（いまの話を聞き切る）: 絞る力は、いちばん新しく行動を添えて聞いた力` — `ValidationContext.From` に、調整する力の 1 を聞いたターン、そのあと優先順位をつける力の 2 を聞いたターンを渡す。`Focus == Ability.Prioritizing`。続きの問い（`Move = EpisodeInsights.ResumeMove`、`Target` あり）も数に入る

- [x] **Step 2: テストが失敗することを確かめる**

Run: `dotnet test --filter "FullyQualifiedName~NextMovePolicyTests"`
Expected: 新しいテストが FAIL（`Focus` がない）

- [x] **Step 3: `Focus` を足して、`MissingActionToAsk` で絞る**

`Focus` があるとき: その力が場面全体で根拠ありなら null を返す。そうでなければ、いまの出来事の候補をその力だけにする（いまの出来事にその力の根拠がなければ null）。`Focus` がないときは、いまの決め方のまま。`MissingActionToAsk` の `<summary>` に revisit-4 を書き足す。

- [x] **Step 4: 聞き手の指示を直す**

`listener.md` の `AskWhatYouDid` の例から「どうやって〜しましたか？」を外し、1 文足す: 移動の手段、食べたものや持ち物の中身のような、行動の細部は聞かない。その出来事の中で、本人がしたこと、決めたことを聞く。

- [x] **Step 5: Spec を直す**

`docs/specs/03-validate.md` の validate-2 の基準の最後に足す: 「一度聞き返した力があれば、その場面ではその力だけを聞き返す。その力が根拠ありになるか、聞ける行動がなくなったら、ほかの力の足りない行動は聞かない（revisit-4（いまの話を聞き切る）を、08 revisit（別の日に話す）より先にここで作る）」。確かめ方に、次の一手の単体テストを足す

- [x] **Step 6: テストが通ることを確かめる**

Run: `dotnet test`
Expected: すべて PASS。いまの validate-2 のテストのうち、聞いた回数を渡すもの（`SameActionAtMostTwice` など）は、同じ力の中で動くので変えずに通る。通らないテストがあれば、revisit-4 で振る舞いが変わったものかを確かめ、変わったものだけを期待値ごと直す

- [x] **Step 7: コミット**

```bash
git add src/Revalue.Server tests/Revalue.Server.Tests docs/specs/03-validate.md
git commit -m "聞き返す力を、場面の中で一つに絞る（revisit-4（いまの話を聞き切る）、validate-2（足りない行動だけ聞き返す））"
```

---

### Task 3: 優先順位をつける力の 3 つ目を、推し量りで根拠にしない

**Files:**
- Modify: `src/Revalue.Server/Ai/Prompts/reader.md`（「根拠にしないもの」に 1 項目）
- Create: `evals/episodes/e19-prioritizing-checked-deadline.md`
- Modify: `docs/specs/03-validate.md`（読み取りの決まりを書いた節に同じ決まり）
- Test: `tests/Revalue.Server.Tests/EvalsTests.cs`（台本の数を数えるテストがあれば、その期待値）

**Interfaces:**
- Consumes: 台本の形（`evals/episodes/e12-prioritizing-partial.md` と同じ前書き: `id`、`title`、`unit: validate`、`expect`、`states`、`ask`）

- [x] **Step 1: 再現する台本を書く**

`e19-prioritizing-checked-deadline.md`（架空。「このハッカソンの期間中に新しく書いた」と書く）。前書き: `id: e19`、`unit: validate`、`expect: concreteEvent`、`states: noticing=notYet, coordinating=notYet, prioritizing=needsCheck`、`ask: prioritizing.3`。答えは 4 つ。1 つ目で 3 つの用事が同じ朝に重なる。2 つ目で、何を先にし、何を後に回したかを具体的に話し、その中に「締め切りをサイトで確かめた」事実を入れる。3 つ目と 4 つ目は、理由を言わずにその後のことを話す。11/4 のペルソナ評価の E と同じ形だが、言葉は新しく書く

- [x] **Step 2: いまの指示で評価を回し、台本が問題を再現することを確かめる**

Run: `dotnet run --project evals/Revalue.Evals -- --unit validate`
Expected: e19 で優先順位をつける力が根拠あり（期待と違う）になる。再現しなければ、その結果を計画のこのステップに書き残し、Step 3 へ進む（台本は回帰の確かめとして残す）

結果（2026-11-05）: 実装を回したエージェントの環境に `ANTHROPIC_API_KEY` がなく、本物の AI で回せなかった。偽物の AI（`--dry-run`）で、e19 が読めて最後まで流れることだけを確かめた。再現の確かめは、Step 5 と合わせて開発者の環境で回す（Claude の判断）

- [x] **Step 3: 読み取りの指示を足す**

`reader.md` の「根拠にしないもの」に足す: 優先順位をつける力の 3（決めた理由や基準がある）は、本人が理由や基準を言葉にしているときだけ根拠にする。期限を確かめた、調べた、のような事実から、理由を推し量らない。例は、e19 と違う言葉で書く（台本の答えを指示に写さない）

- [x] **Step 4: Spec を直す**

`docs/specs/03-validate.md` の読み取りの決まりの節に、同じ決まりを 1 行で足す

- [ ] **Step 5: 評価を回して確かめる**

Run: `dotnet run --project evals/Revalue.Evals -- --unit validate`
Expected: e19 で優先順位をつける力が要確認になり、足りない行動に 3 を聞く。ほかの台本（とくに e10-prioritizing-complete、e14-bad-result、e15-no-result）が、これまでどおり根拠ありのまま。`evals/criteria.md` の合格の線をすべて満たす

未実施（2026-11-05）: Step 2 と同じく鍵がなく、本物の AI で回せなかった。開発者の環境で回す。

- [x] **Step 6: コミット**

```bash
git add src/Revalue.Server/Ai/Prompts/reader.md evals/episodes/e19-prioritizing-checked-deadline.md docs/specs/03-validate.md tests/Revalue.Server.Tests
git commit -m "優先順位をつける力の 3 つ目を、推し量りで根拠にしない（validate-1（3 つともそろったときだけ根拠あり））"
```

---

## 確認コマンド

1. `dotnet build` と `dotnet test` — すべて PASS
2. `npm --prefix src/web ci`、`npm --prefix src/web run build`、`npm --prefix src/web test` — すべて PASS（画面のコードは変えていないが、裏側の文言を参照する画面のテストがないかを確かめる）
3. `node --test .claude/hooks/guard.test.mjs` — PASS
4. `dotnet run --project evals/Revalue.Evals -- --unit discover` — `evals/criteria.md` の 02 discover（話す）の合格の線をすべて満たす。結果を `evals/results/2026-11-05-discover.md` に残す
5. `dotnet run --project evals/Revalue.Evals -- --unit validate` — 03 validate（確かめる）の合格の線をすべて満たす。結果を `evals/results/2026-11-05-validate.md` に残す
6. 言い方を変えたもの（最初の問い、listener.md の 2 か所、reader.md の 1 か所）を、voice-reviewer で点検し、開発者が確かめる項目として残す（`forHuman`）
