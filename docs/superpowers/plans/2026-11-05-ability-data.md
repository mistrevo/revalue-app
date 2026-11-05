# 力をデータに出す（振る舞いは変えない） Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（`.claude/workflows/run-plan.js`）で回す。Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 力（見立てる力、調整する力、優先順位をつける力）を C# の enum と決め打ちの文から外し、能力辞書のデータ `src/shared/abilities.json` から読むようにする。振る舞いは一つも変えない。

**Architecture:** 力は文字の id で表す値（`Ability`）にし、名前、核となる行動の文、手がかり、分類、行動の数を `AbilityCatalog` がデータから返す。読み取りの指示の力の表は、データから作って差し込む。保存する JSON の値（`"noticing"` など）は変えない。

**Tech Stack:** ASP.NET Core（.NET 10）、xUnit v3、React と TypeScript（Vitest）、評価は `evals/Revalue.Evals`

**Spec:** 設計 `docs/superpowers/specs/2026-11-05-ability-dictionary-design.md` の「1. 能力辞書」「2. 聞き方と読み取り」と、順番の手順 2。正しい姿は `docs/prd/4-rules.md` の「力を確かめる物差し」

## Global Constraints

- 振る舞いを変えない。いまのテスト（裏側 705 件、画面のテスト）は、enum の書き方を置き換える以外の期待を変えずに通る
- 保存する値と API の値は変えない。力の id は `noticing`、`coordinating`、`prioritizing` のまま
- 読み取りの指示（`reader.md`）に差し込む力の表は、いまの表と一字一句同じ文字列になる（テストで確かめる）
- 手がかりの言葉と力の名前は、いまの `AbilityText` の文と一字一句同じ
- 核となる行動の数は、データから読む（いまは 3 つとも 3）。2〜3 以外の数、id の重なり、ない分類を、データの読み込みで止める
- 受け入れ基準の呼び名とテスト名の付け方は、いまのまま（validate-1（3 つともそろったときだけ根拠あり）など）
- 鍵、実在の人の情報、開発者の名前を書かない

## Review Focus

- データにない力の id を持つ根拠（古いデータ、読み取りの書き間違い）: 落とさずに無視する。例外にしない
- 判定に使わない（`preparing`）の力: 読み取りの表、次の一手、見えた力のどれにも出ない
- 力の並び: いまの enum の順（見立てる、調整する、優先順位）と同じ順で並ぶ（同じ数のときの選び方と表示の順が変わらない）
- 行動の番号: データの行動の数を超える番号は、いまの「1〜3 でない」と同じく捨てる
- 画面: 力の名前は API から受け取り、画面のコードに力の id を書かない

---

### Task 1: 能力辞書のデータと、力の型

**Files:**
- Create: `src/shared/abilities.json`
- Create: `src/Revalue.Server/Features/Validate/AbilityCatalog.cs`
- Modify: `src/Revalue.Server/Features/Validate/Ability.cs`（enum をやめ、文字の id の値にする。`ActionRef` の行動の数をデータから読む）
- Modify: `Ability` を使う裏側のファイル（`Enum.GetValues<Ability>()` を `AbilityCatalog.Active` に、`ActionRef.ActionsPerAbility` を `AbilityCatalog.ActionCount(ability)` に）
- Modify: `src/Revalue.Server/Revalue.Server.csproj`（`abilities.json` を、`forbidden-words.json` と同じ仕組みでビルドの出力に写す）
- Test: `tests/Revalue.Server.Tests/AbilityCatalogTests.cs`（新規）と、enum の書き方を使うテスト

**Interfaces:**
- Produces: `public readonly record struct Ability(string Id) : IComparable<Ability>`。JSON では id の文字列。並びは `AbilityCatalog` の順。移る間だけ `Ability.Noticing`、`Ability.Coordinating`、`Ability.Prioritizing` を残す（手順 3 で消すと `<summary>` に書く）
- Produces: `AbilityCatalog`（静的。`PromptFiles` と同じく出力から読む）: `IReadOnlyList<Ability> Active`、`AbilityEntry? Find(string id)`、`int ActionCount(Ability)`、`string Name(Ability)`、`string ActionText(ActionRef)`、`string Hint(ActionRef)`、`string Category(Ability)`、`static AbilityCatalog Load(string json)`（テスト用。不正なら例外）
- Produces: `abilities.json` の形

```json
{
  "categories": [{ "id": "understand-people", "name": "人を理解する力" }],
  "abilities": [{
    "id": "noticing", "name": "見立てる力", "category": "family-life",
    "reason": "変化に自分で気づき、手がかりを挙げて、いつもと比べる",
    "status": "active", "needsReview": false,
    "actions": [{ "number": 1, "text": "変化に自分で気づく", "hint": "いつもと違うことに、自分で気づいたこと" }]
  }]
}
```

- 分類は、設計の表の 12 分類を書き起こして入れる（id は英語の小文字とハイフン）。いまの 3 つの力の分類は、見立てる力 = 家庭・子育て・人間関係から見える力、調整する力と優先順位をつける力 = 調整・実行・仕組み化する力
- 核となる行動の文は `docs/prd/4-rules.md` の改訂前の表（`git show origin/main~3:docs/prd/4-rules.md` などで見る）の文、手がかりは `AbilityText.Hints` の文をそのまま写す

- [x] **Step 1: 失敗するテストを書く** — `AbilityCatalogTests`: 3 つの力が enum と同じ順で `Active` に並ぶ、名前と手がかりがいまの `AbilityText` と同じ、`ActionCount` が 3、行動が 1 つや 4 つの力・id の重なり・ない分類で `Load` が例外、`preparing` の力は `Active` に入らない、`Ability` の JSON が `"noticing"` のまま
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter FullyQualifiedName~AbilityCatalogTests`
- [x] **Step 3: データと `AbilityCatalog` を作り、`Ability` を値にする**。enum に頼るところ（`switch`、`Enum.GetValues`、`ActionsPerAbility`）を置き換える
- [x] **Step 4: すべてのテストが通ることを確かめる** — `dotnet test`。期待を変えたテストがあれば、それが enum の書き方の置き換えだけかを確かめる
- [x] **Step 5: コミット**（「力をデータに出す: 能力辞書のデータと力の型（validate-1（3 つともそろったときだけ根拠あり））」）

### Task 2: 力の名前、手がかり、読み取りの表をデータから作る

**Files:**
- Modify: `src/Revalue.Server/Features/Validate/AbilityText.cs`（名前と手がかりを `AbilityCatalog` から）
- Modify: `src/Revalue.Server/Ai/Prompts/reader.md`（力の表と「見る力は 3 つです。…」の文を差し込みの印 `{{ABILITY_TABLE}}` にする）
- Modify: 読み取りの指示を組み立てるところ（`ClaudeConversationAi.cs`。`PromptFiles.Read(PromptFiles.Reader)` の結果の印を置き換える。毎回同じ文字列になるので、キャッシュの位置は変えない）
- Modify: `OptionsValidator`、`DeepenValidator` など、力の id を受け取って確かめるところ（`AbilityCatalog.Find` で確かめる）
- Test: `tests/Revalue.Server.Tests/ClaudeConversationAiTests.cs`、`AbilityTextTests.cs`

**Interfaces:**
- Consumes: Task 1 の `AbilityCatalog`
- Produces: `public static string ReaderPrompt()`（読み取りの指示を、表を差し込んだ形で返す。置き場所は実装者が決める）

- [ ] **Step 1: 失敗するテストを書く** — 差し込んだ読み取りの指示が、改訂前の `reader.md`（`git show` で取った文字列をテストの中に固定で持つ）と一字一句同じ
- [ ] **Step 2〜4: 実装して、`dotnet test` が通ることを確かめる**
- [ ] **Step 5: コミット**

### Task 3: 画面と評価を、力の id の決め打ちから外す

**Files:**
- Modify: `src/web/src/api.ts`（`AbilityKey` を `string` にする）
- Modify: `src/web/src/pages/Deepen.tsx`（業務の見立てで選ぶ力の一覧を、API から受け取る）
- Modify: `src/Revalue.Server/Features/Deepen/DeepenEndpoints.cs`（`GET /api/deepen` の応答に、判定に使う力の一覧 `abilities: [{ key, name }]` を足す）
- Modify: `evals/Revalue.Evals` の台本の読み込み（`states:` と `ask:` の力の id を `AbilityCatalog` で確かめる）
- Modify: `docs/specs/00-common.md`（判定に使う力の表を置き、`abilities.json` が正だと書く）、`docs/specs/06-deepen.md`（応答に足した一覧）
- Test: 画面のテスト（`npm --prefix src/web test`）、`EvalsTests.cs`、`DeepenApiTests.cs`

- [ ] **Step 1: 失敗するテストを書く** — `GET /api/deepen` が `abilities` を返す（裏側の結合テスト）。画面の深めるのテストで、選べる力が API の一覧から出る
- [ ] **Step 2〜4: 実装して、裏側と画面のテストが通ることを確かめる**。`grep -rn "noticing\|coordinating\|prioritizing" src/web/src` が、テストの偽のデータ以外で 0 件
- [ ] **Step 5: 呼び名をそろえる** — PRD で validate-1 の呼び名を「validate-1（すべてそろったときだけ根拠あり）」に変えた。`docs/specs/`、テストの `DisplayName`、`evals/`（criteria.md、判定役、`ReportWriter` などの文字列）の「validate-1（3 つともそろったときだけ根拠あり）」を、すべて新しい呼び名にする。`evals/results/` の過去の結果は書き換えない。`grep -rn "3 つともそろったときだけ" docs/specs tests evals --include=*.md --include=*.cs` が、`evals/results/` 以外で 0 件
- [ ] **Step 6: コミット**

## 確認コマンド

1. `dotnet build`（警告 0）、`dotnet test` — すべて PASS
2. `npm --prefix src/web ci`、`npm --prefix src/web run build`、`npm --prefix src/web test` — すべて PASS
3. `node --test .claude/hooks/guard.test.mjs` — PASS
4. `dotnet run --project evals/Revalue.Evals -- --unit discover --dry-run`、`--unit validate --dry-run`、`--unit options --dry-run`、`--unit deepen --dry-run` — 最後まで流れる
5. 本物の AI の評価（`--unit validate`）は、Workflow の中では鍵が読めないので、Workflow のあとにメインのセッションで回す。11/5 の結果（`evals/results/2026-11-05-validate.md`）と同じ合格の線を満たす
