# 辞書の力に置き換える（手順 3） Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（`.claude/workflows/run-plan.js`）で回す。Steps use checkbox (`- [ ]`) syntax for tracking. 手順 3 は大きいので、Workflow を 2 回に分ける（下の「進め方」）。

**Goal:** 話から確かめる力を、いまの 3 つ（見立てる、調整する、優先順位をつける）から、能力辞書の 24 の力に置き換える。行動が 2 つの力でも芯 1（根拠のない力は出さない）の厳しさを保ち、似た力が並ばない見せ方にし、評価の台本を 24 の力で作り直す。

**Architecture:** 辞書のデータ（`src/shared/abilities.json`）を下書きの 126 項目に置き換える。判定と次の一手は手順 2 で力の数と行動の数をデータから読む形にしてあるので、行動が 2 つの力のテストを足して確かめる。見せ方は新しい `AbilityShowcase`（一つの話から見せる力を絞る）を 1 か所に置き、話す画面、見えた力の画面と履歴、5 つの記録、カード、深める、レポートは、どれもそこを通った力だけを使う。評価は、台本の前書きを「狙った力の期待する状態」と「根拠ありにしてはいけない力」だけにし、根拠ありにしたすべての力の引用を判定役が見て、褒めすぎを数える。

**Tech Stack:** ASP.NET Core（.NET 10）、xUnit v3、React と TypeScript（Vitest）、評価は `evals/Revalue.Evals`

**Spec:** 設計 `docs/superpowers/specs/2026-11-05-ability-dictionary-design.md` の「1. 能力辞書」「2. 聞き方と読み取り」「4. 評価」「点検で決めたこと」と、順番の手順 3。正しい姿は `docs/prd/4-rules.md` の「力を確かめる物差し」「画面での見せ方」「最初の問い」、`docs/specs/00-common.md` の「力」。辞書の中身は、下書き `.tmp/ability-dictionary/abilities-draft.json` と判断のメモ `.tmp/ability-dictionary/abilities-draft-notes.md`（126 項目、active 24、行動は 2〜3 つ）

---

## 進め方（Workflow 2 回）

| 回 | まとまり（taskGroups） | タスク | heavy |
|---|---|---|---|
| 1 回目（3a: データ・判定・見せ方・画面） | A: データと判定 | Task 1〜4 | true |
| | B: 見せる力を絞る | Task 5〜6 | true |
| | C: 画面、最初の問い、文書 | Task 7〜9 | false |
| 2 回目（3b: 評価の作り直し） | D: 褒めすぎの判定役と数え方 | Task 10〜11 | true |
| | E: 根拠ありになる台本（21 本） | Task 12〜13 | false |
| | F: 一部だけそろう台本と、似た力が並ぶ台本 | Task 14〜15 | false |

**準備（メインのセッション、1 回目の前）:**

1. 下書き 2 つ（`abilities-draft.json`、`abilities-draft-notes.md`）を、git が無視する `.tmp/ability-dictionary/` に写した（済み）。Workflow の中のエージェントはそこから読む。scratchpad はセッションが変わると読めないため（Claude の判断）
2. 下書きの名前と理由が協力者の文の写しでないことは、下書きを作ったときに確かめてある（判断のメモの「確かめた結果」）。Workflow では中身を変えない

**args（両方の回で共通）:** `touchesVoice: true`。specs は `00-common.md`、`00-tech-stack.md`、`02-discover.md`、`03-validate.md`、`04-profile.md`、`05-options.md`、`06-deepen.md`、`07-report.md`。

受け入れ基準（1 回目）: validate-1（すべてそろったときだけ根拠あり）、validate-2（足りない行動だけ聞き返す）、validate-4（根拠は本人の言葉）、validate-6（否定の言葉を使わない）、validate-7（見えた力と、もう少し聞きたいことを示す）、validate-11（要確認の場面に戻れる）、validate-12（本人が見立てを外せる）、revisit-4（いまの話を聞き切る）、discover-1（具体的な一日を一つ聞く）、discover-3（選んでも書いてもよい）、profile-2（できることは根拠とつなぐ）、options-8（理由は本人の言葉とつなぐ）、deepen-2（業務ごとに照らす）、report-1（一つにまとめて示す）、report-3（版を残す）

受け入れ基準（2 回目）: validate-1（すべてそろったときだけ根拠あり）、validate-2（足りない行動だけ聞き返す）、validate-3（結果で見立てを変えない）、validate-7（見えた力と、もう少し聞きたいことを示す）

### 話から確かめる 24 の力（下書きの active。辞書の順）

台本とテストで力を指すときに使う。正しい一覧は `src/shared/abilities.json`。

| 分類（id） | 力（id、行動の数） |
|---|---|
| 人を理解する力（`understand-people`） | 情報収集力（`info-gathering`、2）、違和感察知力（`sensing-incongruity`、2） |
| 対話・コミュニケーション（`dialogue`） | 要約力（`summarizing`、2）、質問設計力（`question-design`、2）、傾聴力（`active-listening`、2）、言語化支援力（`helping-put-into-words`、2）、論点整理力（`organizing-issues`、3） |
| 人事・組織（`hr-organization`） | 公平性を考える力（`considering-fairness`、2） |
| 問題発見・分析・判断（`problem-analysis`） | 原因分析力（`cause-analysis`、2）、仮説思考力（`hypothesis-thinking`、2） |
| 調整・実行・仕組み化（`coordination-execution`） | 利害調整力（`balancing-interests`、3）、段取り力（`planning-steps`、2）、優先順位設定力（`setting-priorities`、3）、業務改善力（`improving-work`、2）、期限管理力（`managing-deadlines`、2） |
| 家庭・子育て・人間関係から見える力（`family-life`） | 変化への気づき（`noticing-changes`、3）、相手に応じた説明力（`adapting-explanations`、2）、予定変更への対応力（`handling-schedule-changes`、3） |
| 共感・安心・対人支援（`empathy-support`） | 共感力（`empathy`、2）、不安軽減力（`easing-anxiety`、2） |
| 問い・洞察（`inquiry-insight`） | 深掘り力（`digging-deeper`、3） |
| 実行・挑戦（`action-challenge`） | 走破力（`seeing-it-through`、3）、粘り強さ（`persistence`、2）、回復力（`resilience`、3） |

いまの 3 つの置き換え: `noticing` → `noticing-changes`、`coordinating` → `balancing-interests`、`prioritizing` → `setting-priorities`。

---

## Global Constraints

- 回答・文書・コミットメッセージは日本語。受け入れ基準の呼び名は、必ずタイトルとセットで書く（例: validate-1（すべてそろったときだけ根拠あり））。テスト名（`DisplayName` と Vitest の `it`）も、その呼び名とタイトルで始める
- 芯 1 を緩めない。行動が 2 つの力でも 3 つの力でも、一つの具体的な出来事の中ですべてそろったときだけ根拠あり。一般論だけ、選んだだけの答え、仮の場面の問いの答えだけでは根拠にしない
- 「一つの句を切り分けて、同じ力のすべての行動の根拠にしない」決まりは、「ほかの行動の引用をすべて含む引用は数えない」と読み、行動が 2 つの力にも同じコードで当てはめる（行動が 2 つなら、もう一方の引用を含む引用と、同じ引用は数えない）
- 辞書の中身は `.tmp/ability-dictionary/abilities-draft.json` のとおりに入れる（分類 12、力 126、名前、理由、状態、needsReview、行動の文、手がかり）。足すのは、話から確かめる力の行動ごとの続きの問い（`resumeQuestion`）だけ。置き換え先の 3 つの力の続きの問いは、いまの `AbilityText.Questions` の 9 つの文を一字一句引き継ぐ
- 力の id、名前、行動の文、手がかり、続きの問いを、裏側のコード、画面のコード、AI への指示、Spec の文に決め打ちしない。例外は、`docs/specs/00-common.md` の話から確かめる力の表、テストの値、評価の台本の前書き
- 保存した古い id（`noticing`、`coordinating`、`prioritizing`）は、消さず、移さず、読むときに無視する。名前を引く前に除き、例外にしない。話した中身はそのまま残る（設計の「点検で決めたこと」の「公開中のデータ」）
- 見せ方（PRD 4-rules.md の「画面での見せ方」と設計の「点検で決めたこと」）: 一つの話から見せる根拠ありの力は、分類ごとに 1 つまで（そろった行動の多い順、同じなら辞書の順）。「もう少し聞かせてほしいこと」は場面ごとに 2 つまで（聞き返した力を先に）。「まだ聞けていない力」の名前は、どの画面にも並べない。見えた力（根拠あり）には、核となる行動の文（辞書の共通の文）と本人の言葉を組にして並べる
- 画面に出さない力は、場面の根拠にはそのまま残し、本人が力を見るすべての所（話す画面の見えたこと、見えた力の画面と履歴、5 つの記録の「できること」、カード、深める、レポート）と、カードとレポートの理由に使わない
- 最初の問いの文は変えない。選択肢だけを、この順で「うれしかった日」「困ったことがあった日」「思いどおりにいかなかった日」にする（Claude の判断）。つらい状態のサインのあとの問いと選択肢（`OpeningAfterDistress`、`OpeningAfterDistressChoices`）、飛ばしたあとの問いと選択肢（`AfterSkip`、`AfterSkipChoices`）は変えない
- 状態の呼び名（根拠あり、要確認、未確認）、行動のチェック表、点数、順位、使わない言葉（`src/shared/forbidden-words.json`）を画面に出さない。力の名前「優先順位設定力」の「順位」だけは数えない（いまの `ForbiddenWordList.Allowed` と同じ扱い）
- 業務（`jobs.json`）は 12 のまま。使う力は置き換えの対応のとおりに付け替える。業務に合う力の見直しと、活用場面は手順 4（業務マスター）でする
- 本物の AI を呼ぶのは評価だけ。テストでは偽物を使う。Workflow の中では評価を `--dry-run` まで回し、本物の AI の評価はメインのセッションが回す（Workflow の中では鍵が読めないため）
- 鍵、実在の人の情報、開発者の名前を書かない。台本と架空のデータはすべて架空にし、「このハッカソンの期間中に新しく書いた」と書く。協力者の資料（`.tmp/` の表や文書）の文を写さない
- 合格の線は `docs/prd/6-quality.md` のまま変えない
- `CLAUDE.md` は変えない（芯 1 の「3 つ」は、Workflow のあとに開発者かメインのセッションが直す）。`docs/superpowers/progress.md` も Workflow では触らない
- `evals/results/` の過去の結果、`docs/decisions/` の過去の表、`docs/superpowers/` の過去の計画は書き換えない（決定の記録は行を足すだけ）
- `evals/personas/how-to-judge.md` は手順 5 で書き直すので、この手順では触らない

## Review Focus

### 1 回目

- **古い id の保存データ**: 場面の根拠、聞いた行動の印（`Turn.Target`）、訂正で打ち消された印（`Turn.Withdrawn`）、力の本の状態・外した力・履歴、カードと選んだ案、深めるの業務と問い、レポートの版。どの API も 500 にならず、古い力の名前も id も返さない。話した中身は残る
- **行動が 2 つの力**: 2 つそろえば根拠あり、1 つなら要確認で、残りの 1 つだけを聞く。一方の引用がもう一方の引用を含むとき、同じ引用を 2 つの行動に当てたとき、別々の出来事に 1 つずつ出たときは、根拠ありにしない。続きの問いと手がかりはデータから出る
- **同じ分類の力が 2 つそろった場面**: 見せるのは 1 つ（行動の多い力、同じなら辞書の順で前）。隠れた力は、見えた力の画面、履歴、できること、カード、深める、レポートのどこにも出ず、理由にも使わない。場面の根拠には残る
- **見せた力を本人が外したとき**: 同じ分類で隠れていた力が、代わりにカードやレポートに出てこない
- **要確認が 3 つ以上ある場面**: 見せるのは 2 つで、聞き返した力が先。続きの問いは見せた力の行動を聞き、見せていない力の言葉を映し返さない。見せた 2 つがどちらも一般論だけのときは、一般論向けの続きの問いになる
- **「まだ聞けていない力」**: 話す画面、見えた力の画面、レポートのどこにも、名前の一覧が出ない。代わりの一文が、何も見せない場面でも突き放して読めない
- **準備中の力**: 読み取りの力の表、次の一手、見せる力、カード、深めるで選べる力のどれにも出ない
- **最初の問い**: 初めての人と 2 つ目からの人には新しい 3 つの選択肢、つらい状態のサインのあとと飛ばしたあとは、いまの問いと選択肢のまま
- **読み取りの指示**: 力の名前と行動の番号の決め打ち（「調整する力の 2」の形）がなく、例は行動の言葉で書いてある。表の前の文に力の数を書かない
- **力の並び**: 置き換え先の 3 つの辞書の順は、利害調整力、優先順位設定力、変化への気づきの順になり、いまの順（見立てる、調整する、優先順位）と違う。同じ数のときの選び方が変わって期待を直したテストは、それが並びの違いだけによるかを確かめる

### 2 回目

- **判定役**: 推し量り（期限を確かめた事実から理由を足す）、本人以外がした行動、仮の話、一般論を、「行動を示していない」と答えるか。別々の出来事の言葉を組み合わせた根拠を見抜くか。dry-run の判定役の数字で合否を決めない
- **台本の答え**: 本人の話として自然で、核となる行動の文や手がかりをそのまま写していない。協力者の文を写していない。実在の人、店、学校、地名を書いていない。一つの句に行動を詰めず、行動ごとに別の句で話している
- **一部だけそろう台本**: 狙った力が、その出来事の中でいちばん行動のそろう力になっている（次の一手が狙った力を聞くように、ほかの力の行動を多く入れていない）。足りない行動を、あとの答えで話していない
- **根拠ありにしてはいけない力（`notConfirmed`）**: その話にはっきり行動がない力か、推し量りでしか根拠にならない力だけを書いている。迷う力は書かず、判定役に任せる
- **似た力が並ぶ台本**: 機械で数える「画面に出す力が分類ごとに 2 つ以上」が 0 になる
- **合格の線**: `6-quality.md` のまま。褒めすぎは機械と判定役を合わせて数え、同じ力を 2 回数えない

---

# Workflow 1 回目（3a: データ・判定・見せ方・画面）

## まとまり A: データと判定（heavy）

### Task 1: 台本の前書きを、狙った力と根拠ありにしてはいけない力だけにする

いまの力の id のままで、台本の書き方を先に変える（24 の力すべての状態を台本に書かないため）。次の Task 2 で id を置き換えても、評価が流れるようにする。

**Files:**
- Modify: `evals/Revalue.Evals/EpisodeScript.cs`（`states` を狙った力だけにし、`notConfirmed` を読む。「3 つの力すべてを書きます」「判定に使う力すべて（N つ）を書きます」の文を消す）
- Modify: `evals/Revalue.Evals/EvalSummary.cs`（褒めすぎ、期待どおりだった力、訂正の前の状態、汎用の AI との比較を、台本に書いた力だけで数える）
- Modify: `evals/Revalue.Evals/ReportWriter.cs`（例ごとに、台本に書いた力の期待と結果、根拠ありにしてはいけない力が根拠ありになったか、それ以外で未確認でなかった力を書く。24 の力をすべて並べない）
- Modify: `evals/Revalue.Evals/GenericComparison.cs`（比べるのは台本に書いた力だけ。判定役の指示はまだ変えない。Task 11 で変える）
- Modify: `evals/episodes/e08-*.md`〜`e19-*.md` の前書き（下の表。いまの id のまま）
- Modify: `evals/criteria.md`（「台本の書き方」と、機械で数える「褒めすぎ」の行）
- Test: `tests/Revalue.Server.Tests/EvalsTests.cs`

**Interfaces:**
- Produces: `EpisodeScript.States`（`IReadOnlyDictionary<Ability, AbilityState>?`。狙った力だけ。1 つ以上）、`EpisodeScript.StatesBefore`（狙った力だけ）、`EpisodeScript.NotConfirmed`（`IReadOnlySet<Ability>`。なければ空。`*` は、話から確かめるすべての力から `states` で confirmed の力を除いたもの）、`EpisodeScript.Listed`（`States` のキーと `NotConfirmed` を合わせたもの）
- 前書きの形:

```
states: noticing=confirmed
notConfirmed: coordinating, prioritizing
ask: prioritizing.3
```

- 読めないとき（例外の文は日本語）: 知らない力、同じ力を 2 回書いた、`notConfirmed` の力が `states` で confirmed、`unit: validate` なのに `states` も `notConfirmed` もない
- 褒めすぎ（機械）: `states` で confirmed でない力と、`NotConfirmed` の力のうち、最後の状態で根拠ありになった数。台本に書いていない力の状態は問わない
- 書き直す前書き（いまの `notYet` の力を `notConfirmed` に移す。e13 と e16 は、どの力も根拠ありにしてはいけない話なので `*`）

| 台本 | states | notConfirmed | ほか |
|---|---|---|---|
| e08 | noticing=confirmed | coordinating, prioritizing | |
| e09 | coordinating=confirmed | noticing, prioritizing | |
| e10 | prioritizing=confirmed | noticing, coordinating | |
| e11 | coordinating=needsCheck | noticing, prioritizing | ask: coordinating.3 |
| e12 | prioritizing=needsCheck | noticing, coordinating | ask: prioritizing.3 |
| e13 | coordinating=needsCheck | * | |
| e14 | coordinating=confirmed | noticing, prioritizing | |
| e15 | prioritizing=confirmed | noticing, coordinating | |
| e16 | （書かない） | * | |
| e17 | coordinating=confirmed | noticing, prioritizing | |
| e18 | coordinating=needsCheck | noticing, prioritizing | statesBefore: coordinating=confirmed |
| e19 | prioritizing=needsCheck | noticing, coordinating | ask: prioritizing.3 |

- [x] **Step 1: 失敗するテストを書く**（`EvalsTests.cs`）
  - `評価: 確かめの例の前書きは、狙った力の期待する状態と、根拠ありにしてはいけない力を読む` — `states` が 1 つ、`notConfirmed` が 2 つ、`*` の 3 通り。`*` は、confirmed の狙った力を除くすべての力になる
  - `評価: 知らない力、同じ力の重なり、confirmed と notConfirmed の重なり、states も notConfirmed もない確かめの例は読めない`（いまの 475 行目の Theory を置き換える）
  - `validate-1（すべてそろったときだけ根拠あり）: 評価は、期待が confirmed でない狙った力と、根拠ありにしてはいけない力を Confirmed にした数を褒めすぎとして数え、1 件でも合格にしない`（いまの 500 行目を置き換える）
  - `validate-1（すべてそろったときだけ根拠あり）: 評価は、台本に書いていない力が根拠ありになっても、褒めすぎに数えない`
  - `評価: 汎用の AI との比較は、台本に書いた力だけを数える`（いまの 679 行目を直す）
  - `評価: リポジトリの確かめの例 12 件が読め、どれも狙った力か根拠ありにしてはいけない力を持ち、すべて架空と書いてある`（いまの 743 行目を置き換える）
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter FullyQualifiedName~EvalsTests`
- [x] **Step 3: 読み方と数え方を直し、e08〜e19 の前書きを表のとおりに書き直す**。本文と答えは変えない
- [x] **Step 4: 確かめる** — `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`
- [x] **Step 5: コミット**（「辞書の力に置き換える: 台本の前書きを、狙った力と根拠ありにしてはいけない力だけにする（validate-1（すべてそろったときだけ根拠あり））」）

### Task 2: 能力辞書を 126 項目に置き換え、力の決め打ちを消す

**Files:**
- Modify: `src/shared/abilities.json`（`.tmp/ability-dictionary/abilities-draft.json` の中身にし、話から確かめる力の行動に `resumeQuestion` を足す）
- Modify: `src/Revalue.Server/Features/Validate/AbilityCatalog.cs`（`resumeQuestion` を読む。話から確かめる力が 0 の辞書と、話から確かめる力の行動に続きの問いがない辞書を止める）
- Modify: `src/Revalue.Server/Features/Validate/Ability.cs`（`Ability.Noticing`、`Coordinating`、`Prioritizing` を消す。`AbilityState.Confirmed` などのコメントの「3 つの行動」を「すべての行動」に）
- Modify: `src/Revalue.Server/Features/Validate/AbilityText.cs`（`Questions` の辞書を消し、続きの問いを辞書から引く。「番号が 1〜3 でなければ」を「1〜行動の数でなければ」に）
- Modify: `src/Revalue.Server/Program.cs`（`JobCatalog.Load()` より前に、能力辞書を明示して読み込む。壊れた辞書なら起動で止まる）
- Modify: `src/Revalue.Server/Ai/ScriptedConversationAi.cs`、`ScriptedDeepenAi.cs`、`ScriptedOptionsAi.cs`（置き換え先の id に）
- Modify: `src/Revalue.Server/Features/Options/jobs.json`（12 業務の `ability` を置き換えの対応で付け替える）
- Modify: `src/Revalue.Server/Features/Discover/EpisodeItem.cs` ほか、コメントに古い id や名前がある所
- Modify: `evals/episodes/e08`〜`e19`（前書きの id を置き換え先にし、e19 の `notConfirmed` に `managing-deadlines` を足す。本文の説明の力の名前と行動の文を、置き換え先の名前と辞書の文にする。答えは変えない。ファイル名に古い id がある e08〜e12、e19 は `git mv` で置き換え先の id の名前にする（番号は変えない））
- Modify: `evals/profiles/p01`〜`p08`、`evals/deepen/d01`、`d03`、`evals/Revalue.Evals/DeepenCase.cs`（力の id。記録のファイル名はテストと深めるの案が名前で指すので変えない（Claude の判断））
- Modify: `docs/specs/00-common.md`（「力」の表を 24 の力にする。列は id、名前、分類、行動の数。並びは辞書の順。冒頭の「力ごとに決めた 3 つの核となる行動」を「2〜3 つ」に）
- Modify: `docs/specs/03-validate.md`（「力と核となる行動」の表（13〜19 行目）と、「次の一手」の手がかりの表を消し、00-common.md と辞書を参照する文にする。「9 つの文は `AbilityText.cs` に置く」を、辞書の続きの問いに直す）
- Create: `tests/Revalue.Server.Tests/TestAbilities.cs`（テストで使う力の値。置き換え先の 3 つと、行動が 2 つの力（`Summarizing`、`ActiveListening`、`PlanningSteps` など）、古い id を作る `Old(string id)`）
- Modify: `Ability.Noticing` などを使うテストすべて（約 350 か所）、`ValidateTestKit.CoordinatingAll` は `BalancingInterestsAll` に
- Test: `AbilityCatalogTests.cs`、`AbilityTextTests.cs`、`JobCatalogTests.cs`、`DeepenApiTests.cs`

**Interfaces:**
- Produces: `abilities.json` の行動の形

```json
{ "number": 1, "text": "変化に自分で気づく", "hint": "いつもと違うことに、自分で気づいたこと",
  "resumeQuestion": "その日、いつもと違うと気づいたことはありましたか？" }
```

- Produces: `AbilityActionEntry(int Number, string Text, string Hint, string? ResumeQuestion)`、`AbilityCatalog.ResumeQuestion(ActionRef)`（辞書にない力、番号の外、問いのない行動は `ArgumentOutOfRangeException`）
- Produces: `TestAbilities`（テストだけ）
- 続きの問いの書き方（いまの 9 つの文と同じ決まり。03-validate.md の「続きを話す」）: 「その日、」で始め、本人がその行動をしたことを前提にせず「ありましたか？」か「いましたか？」で終える。一度に一つだけ求める。考えたかどうかを疑う聞き方（「考えて決めましたか」）をしない。3 つの選択肢（「思い当たることがあります」「とくに思い当たりません」「その日のほかのことを話したい」）がどれも自然な答えになる。手がかりの言葉を下敷きにする。新しく書くのは 21 の力の 47 文（Claude の判断。voice-reviewer が点検し、開発者が確かめる）
- 準備中の 102 の力には `resumeQuestion` を書かない

- [x] **Step 1: 失敗するテストを書く**
  - `AbilityCatalogTests`（いまの「3 つの力が enum と同じ順」などを置き換える）
    - `validate-1（すべてそろったときだけ根拠あり）: 辞書は 12 の分類と 126 の力を持ち、話から確かめる力は 24 で、並びは辞書の順` — 24 の id の並びを、上の表と同じ順で確かめる
    - `validate-1（すべてそろったときだけ根拠あり）: どの力も核となる行動が 2〜3 つで、番号は 1 から順` — 行動の数はデータから読む（いまの 1〜3 の決め打ちをやめる。手順 2 の指摘 5）
    - `validate-1（すべてそろったときだけ根拠あり）: 話から確かめる力が 1 つもない辞書は、読み込みで止める`（手順 2 の指摘 2）
    - `validate-11（要確認の場面に戻れる）: 話から確かめる力の行動に続きの問いがない辞書は、読み込みで止める。準備中の力にはなくてよい`
    - `validate-1（すべてそろったときだけ根拠あり）: 古い id（noticing、coordinating、prioritizing）は辞書になく、話から確かめる力として読めない`
    - `validate-2（足りない行動だけ聞き返す）: 置き換え先の 3 つの力は、いまの核となる行動の文と手がかりを引き継ぐ` — 変化への気づきと優先順位設定力は 3 つの文と手がかりが一字一句同じ。利害調整力は手がかりが同じで、行動の文は 1（関わる 2 者以上の、それぞれ違う都合をつかむ）と 2（自分から働きかける）が下書きのとおり
  - `AbilityTextTests`
    - `validate-6（否定の言葉を使わない）: 話から確かめる力の名前、行動の文、手がかり、続きの問いに、使わない言葉がない` — 「優先順位」の「順位」は数えない。「診断」「判定」「スコア」もない
    - `validate-11（要確認の場面に戻れる）: 続きの問いは、話から確かめる力の行動ごとにあり、「その日、」で始まり「ありましたか？」か「いましたか？」で終わる` — 行動の数はデータから読む
    - `validate-11（要確認の場面に戻れる）: 置き換え先の 3 つの力の続きの問いは、いまの 9 つの文と同じ` — 9 つの文はテストの中に固定で持つ
  - `JobCatalogTests`
    - `options-2（選ぶは登録した職種から）: 12 の業務の使う力は、置き換え先の力の id になっている`
    - いまの `ForbiddenWordsIgnoreAbilityNames` を「優先順位設定力」で確かめる形に直す
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~AbilityCatalogTests|FullyQualifiedName~AbilityTextTests|FullyQualifiedName~JobCatalogTests"`
- [x] **Step 3: データを入れ、決め打ちを消す**。下書きを写したあと、`node -e` で、分類 12、力 126、active 24、active の行動すべてに `resumeQuestion` があることを確かめる。`Ability.Noticing` などを消し、テストは `TestAbilities` に置き換える。jobs.json と評価のデータの id を付け替える
- [x] **Step 4: すべてのテストが通ることを確かめる** — `dotnet test`。期待を変えたテストは、id の置き換えか、辞書の順の違い（Review Focus の「力の並び」）によるものだけかを確かめ、並びで変わったものはコミットメッセージの本文に書く。`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`、`--unit options --dry-run`、`--unit deepen --dry-run` が流れる
- [x] **Step 5: コミット**（「辞書の力に置き換える: 能力辞書を 126 項目にし、力の決め打ちを消す（validate-1（すべてそろったときだけ根拠あり）、validate-11（要確認の場面に戻れる））」）

### Task 3: 行動が 2〜3 つの力で、判定、次の一手、読み取りの指示を合わせる

**Files:**
- Modify: `src/Revalue.Server/Features/Validate/AbilityStates.cs`（`Counted` の `<summary>` を「ほかの行動の引用をすべて含む引用は数えない。行動が 2 つなら、もう一方の引用を含む引用」に。コードは行動の数で動いているはずなので、テストで確かめて足りなければ直す）
- Modify: `src/Revalue.Server/Ai/Prompts/reader.md`（「根拠にしないもの」の例から、力の名前と行動の番号（「調整する力の 2」「優先順位をつける力の 3」）を外し、行動の言葉で書く。「一つの句を切り分けて、同じ力の 3 つの行動すべて」を「すべての行動」に。手順 2 の指摘 7）
- Modify: `src/Revalue.Server/Ai/PromptFiles.cs`（表の前の文から力の数を外す。例: 「話から確かめる力と、力ごとの核となる行動です。行動の数は力によって 2 つか 3 つです。」）
- Modify: `src/Revalue.Server/Ai/Prompts/options.md`、`deepen.md`（「力の名前の「優先順位をつける力」は書いてよい」を、力の名前に含まれる言葉は書いてよい形に。deepen.md の「`<abilities>`: 3 つの力の `key` と名前」を「話から確かめる力の」に）
- Modify: `docs/specs/03-validate.md`（「根拠として使える言葉」の、一つの句の決まりと、理由を推し量らない決まりを、力の名前と数に頼らない文に）
- Test: `AbilityStatesTests.cs`、`NextMovePolicyTests.cs`、`EvidenceTests.cs`、`ResumeTests.cs`、`ClaudeConversationAiTests.cs`

**Interfaces:**
- reader.md の「根拠にしないもの」の書き方（Claude の判断）
  - 本人以外がした行動: 「たとえば、夫が近所の人に声をかけたなら、自分から働きかけた行動の根拠にしない」
  - 理由や基準、目的のように、本人の考えを示す行動: 本人がそれを言葉にしているときだけ根拠にする。期限を確かめた、調べた、のような事実から理由を推し量らない（いまの優先順位をつける力 3 の決まりを、どの力にも当てはまる形にする。例の文は e19 と違う言葉のまま）
  - 一つの句の切り分け: 「たとえば「歯医者に電話して、予約を夕方に変えてもらった」は、自分から働きかけた行動と、代わりの案を出した行動の根拠にはなるが、関わる人たちのそれぞれ違う都合をつかんだ行動の根拠にはならない。ほかの行動の引用をすべて含む引用は、コードが数えません」

- [x] **Step 1: 失敗するテストを書く**
  - `AbilityStatesTests`
    - `validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力は、一つの出来事の中で 2 つそろったときだけ根拠ありになる`
    - `validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力で、一方の引用がもう一方の引用をすべて含むときは、含むほうを数えない`（同じ行動に含まない別の根拠があれば、そちらで根拠あり）
    - `validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力で、同じ引用を 2 つの行動に当てても根拠ありにしない`
    - `validate-1（すべてそろったときだけ根拠あり）: 行動が 2 つの力で、別々の出来事に 1 つずつ出たときは要確認のまま`
    - `validate-1（すべてそろったときだけ根拠あり）: 行動が 3 つの力では、ほかの 2 つの引用をすべて含む引用だけを数えない`（1 つだけ含む引用は数える。いまの振る舞いの回帰）
  - `NextMovePolicyTests`
    - `validate-2（足りない行動だけ聞き返す）: 行動が 2 つの力で 1 つそろったら、もう 1 つの行動を聞く`
    - `validate-2（足りない行動だけ聞き返す）: 行動が 2 つの力が 2 つそろったら、その力は聞かない`
    - `revisit-4（いまの話を聞き切る）: 行動が 2 つの力と 3 つの力が同じ出来事にあっても、聞き返した力だけを聞く`
  - `EvidenceTests`: `validate-1（すべてそろったときだけ根拠あり）: 準備中の力と、行動の数を超える番号の根拠は、照らし合わせで捨てる`（行動が 2 つの力の 3 番を捨てる）
  - `ResumeTests`: `validate-11（要確認の場面に戻れる）: 行動が 2 つの力の続きは、辞書の続きの問いで始まる`
  - `ClaudeConversationAiTests`（手順 2 の「改訂前の reader.md と一字一句同じ」テストを置き換える）
    - `validate-1（すべてそろったときだけ根拠あり）: 読み取りの指示の力の表は、話から確かめる 24 の力を辞書の順に持ち、準備中の力を持たない`
    - `validate-1（すべてそろったときだけ根拠あり）: 読み取りの指示に、力の数と、力の名前と行動の番号の決め打ちがない` — 「見る力は」を含まない。表の外に、どの力の名前も「〜の 2（」「〜の 3（」の形もない
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~AbilityStatesTests|FullyQualifiedName~NextMovePolicyTests|FullyQualifiedName~EvidenceTests|FullyQualifiedName~ResumeTests|FullyQualifiedName~ClaudeConversationAiTests"`
- [x] **Step 3: 直す**。判定と次の一手のコードは、テストが通らないところだけ直す
- [x] **Step 4: 確かめる** — `dotnet test`
- [x] **Step 5: コミット**（「辞書の力に置き換える: 行動が 2〜3 つの力で判定と次の一手を確かめ、読み取りの指示から力の決め打ちを外す（validate-1（すべてそろったときだけ根拠あり）、validate-2（足りない行動だけ聞き返す）、revisit-4（いまの話を聞き切る））」）

### Task 4: 辞書から消えた力の id を持つ保存データで、API を落とさない

手順 2 の反証で再現した 500（指摘 1）を直す。

**Files:**
- Modify: `src/Revalue.Server/Features/Validate/AbilityCatalog.cs`、`AbilityText.cs`（名前を引けるかを先に見る関数）
- Modify: `src/Revalue.Server/Features/Validate/ValidateEndpoints.cs`（`DtoAsync` の履歴から、辞書の話から確かめる力でない行を除く）
- Modify: `src/Revalue.Server/Features/Report/ReportEndpoints.cs`（版の力から除く。業務の「まだ確かめていない力」は名前なしにする）
- Modify: `src/Revalue.Server/Features/Options/OptionsEndpoints.cs`（カードと選んだ案の力が辞書にないときは、理由と力を出さない）
- Modify: `src/Revalue.Server/Features/Deepen/DeepenEndpoints.cs`（業務と問いの力が辞書にないときは、力の id と名前を null にし、使えるところとして示さない）
- Modify: `src/Revalue.Server/Ai/ClaudeDeepenAi.cs`、`ClaudeOptionsAi.cs`（AI に渡す文で、辞書にない力の名前を引かない）
- Modify: `src/Revalue.Server/Features/Profile/ProfileEndpoints.cs`、`Options/OptionsInputs.cs`（外した力の一覧の古い id を数えない）
- Modify: `src/web/src/api.ts`、`src/web/src/pages/Deepen.tsx`（深めるの業務と問いの力の名前が null でも出せる。名前のない業務は「この業務で使う〜は、まだ確かめていません」を出さず、直す欄では力を選び直してもらう）
- Modify: `docs/specs/00-common.md`（「力」に読み方を足す: 辞書にない id を持つ保存データは、読めない力として無視する。名前を引く前に除き、例外にしない。消さず、移さない。話した中身は残る）
- Create: `tests/Revalue.Server.Tests/LegacyAbilityDataTests.cs`
- Test: `DeepenApiTests.cs`（手順 2 の指摘 4）、`Deepen.test.tsx`

**Interfaces:**
- Produces: `AbilityCatalog.IsActive(Ability)`（話から確かめる力か）、`AbilityText.NameOrNull(Ability)`（辞書にない力は null）
- Produces: 深めるの `TaskLightDto.AbilityKey` と `AbilityName`、`QuestionDto.AbilityName` を null にできる形（`api.ts` も合わせる）
- Consumes: Task 2 の `TestAbilities.Old("noticing")`（古い id は `new Ability("noticing")` で作る）

- [x] **Step 1: 失敗するテストを書く**（`LegacyAbilityDataTests.cs`。データの置き場に直接、古い id を持つ項目を置いてから API を呼ぶ）
  - `validate-1（すべてそろったときだけ根拠あり）: 辞書から消えた力の id を持つ保存データがあっても、どの API も 500 にならない` — 置くもの: 話し終えた場面（古い id の根拠、`Target` が `noticing.2` の問い、`Withdrawn` が `coordinating.1` の訂正）、力の本（古い id の状態、外した力、履歴）、カードと選んだ案（古い id の力）、深めるの中身（古い id の業務と問い）、レポートの版（古い id の力）。呼ぶもの: `GET /api/abilities`、`GET /api/episodes`、`GET /api/episodes/{id}`、`POST /api/episodes/{id}/resume`、`GET /api/profile`、`GET /api/options`、`GET /api/deepen`、`GET /api/report`、`GET /api/next-step`。どれも 200（続きを話せない場面なら 409）
  - `validate-1（すべてそろったときだけ根拠あり）: 辞書から消えた力の根拠と履歴は数えず、応答に古い id も名前も入らない。話した中身は残る`
  - `validate-12（本人が見立てを外せる）: 辞書から消えた力の id を外す・戻すと 404`
  - `deepen-2（業務ごとに照らす）: 深めるの業務と問いの力が辞書から消えていたら、力の名前を添えずに返す`
  - `report-3（版を残す）: 前の版の力が辞書から消えていたら、その力を除いて返す`
  - `options-8（理由は本人の言葉とつなぐ）: カードと選んだ案の力が辞書から消えていたら、理由と力を出さない`
  - `DeepenApiTests` の `DeepenReturnsActiveAbilitiesFromCatalog` に `DisplayName = "deepen-2（業務ごとに照らす）: GET /api/deepen は、話から確かめる力の一覧を辞書の順で返す"` を付ける
  - `Deepen.test.tsx`: `deepen-2（業務ごとに照らす）: 力の名前のない業務も出し、「まだ確かめていません」の行を出さない`
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter FullyQualifiedName~LegacyAbilityDataTests`（500 が出ることを見る）
- [x] **Step 3: 名前を引く所をすべて直す** — `git grep -n "AbilityText.Name\|AbilityCatalog.Name" src` で洗い出し、保存データから来る力を名前に変える所は、どれも先に `IsActive` で除くか名前なしにする
- [x] **Step 4: 確かめる** — `dotnet test`、`npm --prefix src/web test`
- [x] **Step 5: コミット**（「辞書の力に置き換える: 辞書から消えた力の id を持つ保存データで API を落とさない（validate-1（すべてそろったときだけ根拠あり）、deepen-2（業務ごとに照らす）、report-3（版を残す））」）

## まとまり B: 見せる力を絞る（heavy）

### Task 5: 一つの話から見せる力を絞る（話す画面の見えたこと、続きの問い）

**Files:**
- Create: `src/Revalue.Server/Features/Validate/AbilityShowcase.cs`
- Modify: `src/Revalue.Server/Features/Validate/ValidateEndpoints.cs`（`EpisodeInsights.From` は見せる力だけを返し、「まだ聞けていない力」を返さない。`ResumeTarget`、`ResumeMirrorQuote`、`Reopen` は「もう少し聞かせてほしいこと」に出した力だけを見る。`QuoteDto` に行動の文を足す）
- Modify: `docs/specs/03-validate.md`（「話し終えたとき」「続きを話す」、validate-7（見えた力と、もう少し聞きたいことを示す）と validate-11（要確認の場面に戻れる）の基準）
- Test: `AbilityShowcaseTests.cs`（新規）、`InsightsTests.cs`、`ResumeTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record EpisodeShowcase(IReadOnlyList<AbilityResult> Seen, IReadOnlyList<AbilityResult> MoreToHear)` — `Seen` は辞書の順、`MoreToHear` は聞く順
  - `public static class AbilityShowcase`: `const int SeenPerCategory = 1`、`const int MaxMoreToHear = 2`、`static EpisodeShowcase Of(IReadOnlyList<Turn> turns, IReadOnlyList<Evidence> evidence)`
  - `QuoteDto(string Text, bool FromChoice, string? LinkedText, string? Action)` — `Action` は、その根拠の行動の文（辞書の共通の文）。辞書にない力なら null
  - `EpisodeInsightsDto(Seen, MoreToHear, CanResume)`（`NotYet` と `AbilityNameDto` を消す）
- 決め方（Claude の判断）
  - `Seen`: その場面で根拠ありの力を分類ごとに分け、分類ごとに 1 つ。そろった行動の多い力、同じなら辞書の順で前の力
  - `MoreToHear`: その場面で要確認の力のうち 2 つまで。聞き返した力（`ValidationContext.From(turns, evidence).Focus`）が要確認なら先に置き、残りは見せる根拠の多い順、同じなら辞書の順
  - 続きを話せるか（`CanResume`）は、いまのまま「要確認の力がある」で決める（要確認の力があれば、1 つは必ず見せる）
  - 続きの問いで聞く行動は、`MoreToHear` の順に、一般論だけの力を除いて、いまの決まり（聞いた回数、打ち消し、答えていない最後の問い）で選ぶ。`MoreToHear` がどれも一般論だけなら、一般論向けの続きの問いにする。映し返す言葉も `MoreToHear` の力の根拠から選ぶ

- [x] **Step 1: 失敗するテストを書く**
  - `AbilityShowcaseTests`
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 同じ分類で 2 つの力が根拠ありなら、そろった行動の多い力だけを見せる` — 利害調整力（3）と段取り力（2）
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: そろった行動の数が同じなら、辞書の順で前の力を見せる` — 要約力と傾聴力（どちらも 2）で要約力
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 分類が違えば、根拠ありの力をそれぞれ見せる` — 変化への気づきと利害調整力
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: もう少し聞かせてほしいことは 2 つまでで、聞き返した力を先にする` — 要確認が 3 つ。聞き返した力は見せる根拠がいちばん少ない力
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 聞き返した力がなければ、見せる根拠の多い順、同じなら辞書の順に 2 つ`
  - `InsightsTests`
    - いまの 14 行目のテストを `validate-7（見えた力と、もう少し聞きたいことを示す）: 話し終えた場面に、見えた力と根拠、もう少し聞かせてほしいこと（手がかり）が入り、まだ聞けていない力の一覧は入らない` に置き換える
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 根拠の言葉に、その根拠の核となる行動の文が添えてある`
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 見せない力の根拠も、場面にはそのまま残る`
  - `ResumeTests`
    - `validate-11（要確認の場面に戻れる）: 続きの問いは、もう少し聞かせてほしいことに出した力の行動を聞き、出していない力の言葉を映し返さない`
    - `validate-11（要確認の場面に戻れる）: もう少し聞かせてほしいことに出した力がどれも一般論だけなら、一般論向けの続きの問いで始まる`
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~AbilityShowcaseTests|FullyQualifiedName~InsightsTests|FullyQualifiedName~ResumeTests"`
- [x] **Step 3: `AbilityShowcase` を作り、`EpisodeInsights` をそこへ通す**
- [x] **Step 4: Spec を直す** — 03-validate.md の「話し終えたとき」の 3 つ目の箇条（まだ聞けていない力）を消し、見えた力の見せ方（分類ごとに 1 つ、行動の文と本人の言葉の組）と、もう少し聞かせてほしいことの数（2 つまで、聞き返した力が先）と、代わりの一文を書く。「続きを話す」の「聞く行動は、要確認の力のうち…（同じ数なら見立てる力、調整する力、優先順位をつける力の順）」を、もう少し聞かせてほしいことに出した力の順に直す。validate-7 と validate-11 の基準も同じ中身にする
- [x] **Step 5: 確かめる** — `dotnet test`
- [x] **Step 6: コミット**（「辞書の力に置き換える: 一つの話から見せる力を絞る（validate-7（見えた力と、もう少し聞きたいことを示す）、validate-11（要確認の場面に戻れる））」）

### Task 6: 見えた力、できること、カード、深める、レポートに同じ絞り込みをかける

**Files:**
- Modify: `src/Revalue.Server/Features/Validate/AbilityBook.cs`（`View` は見せた力だけを返す。力の本の状態と履歴も、見せた力で決める）
- Modify: `src/Revalue.Server/Features/Validate/ValidateEndpoints.cs`（`GET /api/abilities` は見せた力だけ）
- Modify: `src/Revalue.Server/Features/Report/ReportBuilder.cs`、`ReportContent.cs`、`ReportEndpoints.cs`（`ReportNotYet.NotHeard` を消す）
- Modify: 必要なら `Profile/ProfileEndpoints.cs`、`Options/OptionsInputs.cs`、`Deepen/DeepenLighting.cs`（`View` を通るので、多くは変えずに済むはず）
- Modify: `docs/specs/03-validate.md`（「力の状態」の利用者ごとの状態、「見えた力の画面」、API の表の `GET /api/abilities` と `{name}`）、`docs/specs/04-profile.md`（できること）、`docs/specs/05-options.md`（使える力）、`docs/specs/06-deepen.md`（使えるところ）、`docs/specs/07-report.md`（まだ確かめていないこと）
- Test: `AbilityBookTests.cs`、`AbilitiesApiTests.cs`、`ProfileApiTests.cs`、`OptionsApiTests.cs`、`ReportApiTests.cs`、`ReportBuilderTests.cs`、`DeepenLightingTests.cs`

**Interfaces:**
- Produces: `AbilityBook.View(episodes, book)` — 見せた力（根拠ありか要確認）だけを辞書の順で返す。見せた力とは、力の確かめに使える場面のどれかで `AbilityShowcase.Of` の `Seen` か `MoreToHear` に入った力。状態と根拠は、その力を見せた場面のうち、いちばん進んだ状態の場面（同じなら新しい場面）から取る（Claude の判断）
- Produces: `AbilityBook.VisibleStates(episodes)`（`RecomputeAsync` が使う。見せた力の状態。ほかは未確認）。履歴は見せた力の移り変わりだけになる
- Produces: `ReportNotYet(IReadOnlyList<Ability> Checking, IReadOnlyList<ReportTaskGap> TaskGaps, bool HasExcluded)`、`ReportNotYetDto(checking, taskGaps, hasExcluded)`
- カードの使える力（`OptionsInputs.Abilities`）、5 つの記録の「できること」、深めるの使えるところ、レポートの確かめた力は、どれも `View` から作るので、見せた力だけになる。前に作ったカードの力が見せた力でなくなっていれば、いまの `ProblemIn`（`Changed`）で出さない

- [ ] **Step 1: 失敗するテストを書く**
  - `AbilityBookTests`: `validate-12（本人が見立てを外せる）: 力の本の状態と履歴は、本人に見せた力だけで決まり、画面に出さない力は未確認のまま`
  - `AbilitiesApiTests`
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: GET /api/abilities は見せた力だけを返し、まだ聞けていない力を並べない`
    - `validate-12（本人が見立てを外せる）: 画面に出さない力は、見えた力の画面にも履歴にも出ない`
  - `ProfileApiTests`: `profile-2（できることは根拠とつなぐ）: できることには見せた力だけが入り、根拠に行動の文が添えてある`
  - `OptionsApiTests`
    - `validate-12（本人が見立てを外せる）: 画面に出さない力は、カードの理由に使わない`
    - `validate-12（本人が見立てを外せる）: 見せた力を外しても、同じ分類で隠れていた力がカードの理由に出ない`
  - `ReportApiTests` / `ReportBuilderTests`
    - `report-1（一つにまとめて示す）: 確かめた力の欄は見せた力だけで、まだ確かめていないことに、まだ聞けていない力の名前を並べない`
    - `validate-12（本人が見立てを外せる）: 画面に出さない力は、レポートの確かめた力にも選んだ案の理由にも使わない`
  - `DeepenLightingTests`: `deepen-2（業務ごとに照らす）: 業務の力が画面に出さない力なら、使えるところとして示さない`
  - 同じ分類の力が 2 つ根拠ありの場面は、偽物の読み取り（`FakeConversationAi`）で、利害調整力の 3 つと段取り力の 2 つを同じ出来事に返して作る
- [ ] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~AbilityBookTests|FullyQualifiedName~AbilitiesApiTests|FullyQualifiedName~ProfileApiTests|FullyQualifiedName~OptionsApiTests|FullyQualifiedName~Report|FullyQualifiedName~DeepenLightingTests"`
- [ ] **Step 3: `View` と力の本を見せた力で決めるようにし、レポートのまだ聞けていない力を消す**
- [ ] **Step 4: Spec を直す** — 03-validate.md「見えた力の画面」の「3 つの力ごとに」を「見せた力ごとに」に、生活の中での状態の言葉から「まだ聞けていない」を外し、見せた力がないときと代わりの一文を書く。API の表の `GET /api/abilities` を「見せた力の…」に、`{name}` を「話から確かめる力の id（ほかは 404）」に。04〜07 は、見せた力だけを使うこと（画面に出さない力は理由にも使わないこと）を、それぞれ 1 文で 00-common.md と 03-validate.md を参照して書く。07-report.md の「まだ聞けていない力」を消し、代わりの一文にする
- [ ] **Step 5: 確かめる** — `dotnet test`
- [ ] **Step 6: コミット**（「辞書の力に置き換える: 見えた力、できること、カード、深める、レポートを見せた力だけにする（validate-12（本人が見立てを外せる）、profile-2（できることは根拠とつなぐ）、report-1（一つにまとめて示す））」）

## まとまり C: 画面、最初の問い、文書

### Task 7: 画面に、行動の文と本人の言葉の組と、代わりの一文を出す

**Files:**
- Modify: `src/web/src/api.ts`（`Quote.action`、`EpisodeInsights` から `notYet` を消す、`ReportNotYet` から `notHeard` を消す）
- Modify: `src/web/src/components/Insights.tsx`（見えた力は行動の文と本人の言葉の組。「まだ聞けていない力」の見出しと名前の一覧を消し、代わりの一文。`QuoteList` に組で出す形を足す）
- Modify: `src/web/src/pages/Abilities.tsx`（API が返した力だけを出す。未確認の札の分かれ道を消す。見せた力がないときの言葉。下に代わりの一文。コメントの「3 つの力ごとに」を直す）
- Modify: `src/web/src/pages/Profile.tsx`、`Options.tsx`、`Report.tsx`、`Deepen.tsx`（根拠ありの力の根拠を組で出す。レポートの「まだ聞けていない力」の行を消し、注記を代わりの一文にする）
- Modify: `src/web/src/copy.ts`（`insights.notYetTitle`、`insights.notYetNote`、`report.notHeard` を消し、代わりの一文と、見えた力がないときの言葉を足す）
- Modify: `src/web/src/test/fake-api.ts` と画面のテスト（偽のデータを置き換え先の id と名前に。行動が 2 つの力も入れる）
- Test: `Talk.test.tsx`、`Abilities.test.tsx`、`Profile.test.tsx`、`Options.test.tsx`、`Report.test.tsx`、`Deepen.test.tsx`、`copy.test.ts`

**Interfaces:**
- Consumes: Task 5 の `QuoteDto.Action`、`EpisodeInsightsDto`（`notYet` なし）、Task 6 の `ReportNotYetDto`（`notHeard` なし）
- 組の出し方（Claude の判断）: 根拠ありの力では、行動の番号の順に「行動の文」と「「本人の言葉」」を 1 組ずつ並べる。チェックの印、番号、そろった数は出さない。同じ言葉が複数の行動の根拠なら、行動の文を「、」でつなぎ、言葉は一度だけ出す。選んだ答えは、いまと同じく「（選んだ答え）」と結びついた言葉を添える。要確認の力（「もう少し聞かせてほしいこと」「確かめ中」）は、いまのまま本人の言葉と手がかりだけにする。そろった行動とそろっていない行動を並べると、チェック表に見えるため
- 代わりの一文（Claude の判断。voice-reviewer が点検し、開発者が確かめる）
  - 何か見せたとき: 「ほかの力も、話を重ねると見つかることがあります。」
  - 何も見せないとき（話す画面の見えたこと）: 「話を重ねると、見えてくる力があります。」
  - 見えた力の画面で見せた力がないとき: 「話を重ねると、ここに見えてきた力が並びます。」
  - どれも、力が「ない」「足りない」と読める言い方、数、「あと〜」を使わない

- [ ] **Step 1: 失敗するテストを書く**
  - `Talk.test.tsx`
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 見えた力に、核となる行動の文と本人の言葉を組にして出す`
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 「まだ聞けていない力」の見出しと名前の一覧を出さず、代わりの一文だけを添える`
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: もう少し聞かせてほしいことには行動の文を添えず、本人の言葉と手がかりを出す`
  - `Abilities.test.tsx`
    - `validate-7（見えた力と、もう少し聞きたいことを示す）: 見えた力の画面は API が返した力だけを出し、ないときは話を重ねると見えてくると伝える`
    - いまの `validate-6（否定の言葉を使わない）` のテストを、置き換え先の名前で通す
  - `Profile.test.tsx`: `profile-2（できることは根拠とつなぐ）: 見えた力に、行動の文と本人の言葉を組にして出す`
  - `Options.test.tsx`: `options-8（理由は本人の言葉とつなぐ）: 見えた力のカードは行動の文と本人の言葉を組にし、確かめ中の力のカードは本人の言葉だけを出す`
  - `Report.test.tsx`: `report-1（一つにまとめて示す）: まだ聞けていない力の名前を並べず、代わりの一文を添える`
  - `copy.test.ts`: 足した文に使わない言葉がない
- [ ] **Step 2: テストが失敗することを確かめる** — `npm --prefix src/web test`
- [ ] **Step 3: 画面を直す**
- [ ] **Step 4: 確かめる** — `npm --prefix src/web run build`、`npm --prefix src/web test`。`git grep -nP "(?<![\w-])(noticing|coordinating|prioritizing)(?![\w-])" -- src/web/src` が 0 件。`git grep -nP "(noticing-changes|balancing-interests|setting-priorities)" -- src/web/src ':!*.test.*' ':!src/web/src/test'` が 0 件
- [ ] **Step 5: コミット**（「辞書の力に置き換える: 見えた力に行動の文と本人の言葉を組にして出し、まだ聞けていない力の一覧を一文にする（validate-7（見えた力と、もう少し聞きたいことを示す））」）

### Task 8: 最初の問いの選択肢を、協力者の入口の言葉に寄せる

**Files:**
- Modify: `src/Revalue.Server/Features/Discover/DiscoverText.cs`（`OpeningChoices` を「うれしかった日」「困ったことがあった日」「思いどおりにいかなかった日」に。`<summary>` の「うまくいかなかった日も同じ重さで」の説明はそのまま当てはまる形に直し、協力者の入口の言葉に寄せたこと（Claude の判断）を書く。`OpeningAfterDistressChoices` の `<summary>` の「「思うようにいかなかった日」のような」を新しい言葉に）
- Modify: `evals/episodes/e20-unexpected-day.md`（題と説明と `[選択]` の行を「思いどおりにいかなかった日」に。ほかの答えは変えない）
- Modify: `evals/judges/discover.md`（12 の `noFailureProbe` の例）、`evals/criteria.md`（判定役の表の最後の行）
- Modify: `docs/prd/4-rules.md`（「最初の問い」の表の選択肢）、`docs/prd/3-features.md`（discover-1 の「思うようにいかなかった日」）、`docs/prd/6-quality.md`（確かめる場面の「最初の問いで「思うようにいかなかった日」を選んだ」）、`docs/specs/02-discover.md`（48 行目付近、67 行目付近の表、discover-1 の基準）
- Modify: `docs/decisions/2026-11-05-ability-dictionary.md`（決めたことの表に 1 行足す: 最初の問いの選択肢を協力者の入口の言葉に寄せる。Claude。外した案はいまの 3 つ。理由は、協力者の深掘りの入口が気持ちの言葉で始まるため。言葉は協力者に確かめる）
- Test: `DiscoverTextTests.cs`、`EvalsTests.cs`（93 行目と 243 行目付近）、`EpisodeTests.cs`

**Interfaces:**
- Produces: `DiscoverText.OpeningChoices`（新しい 3 つ。この順）。`Opening`、`OpeningAnotherDay`、`OpeningAfterDistress`、`OpeningAfterDistressChoices`、`AfterSkip`、`AfterSkipChoices` は変えない

- [ ] **Step 1: 失敗するテストを書く**
  - `DiscoverTextTests`: いまの 61 行目のテストを `discover-1（具体的な一日を一つ聞く）: 最初の問いは、気持ちが動いた日を聞き、選択肢は「うれしかった日」「困ったことがあった日」「思いどおりにいかなかった日」` に直す。つらい状態のサインのあとの問いと選択肢に、新しい 3 つの言葉が入らないことも確かめる
  - `EvalsTests`: `discover-3（選んでも書いてもよい）: リポジトリの e20 は、最初の問いで「思いどおりにいかなかった日」を選び、そのあと出来事を書く`
- [ ] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~DiscoverTextTests|FullyQualifiedName~EvalsTests|FullyQualifiedName~EpisodeTests"`
- [ ] **Step 3: 言葉と文書を直す** — `git grep -n "思うようにいかなかった日\|うまくいったと感じた日\|大変だったけど、乗り切った日" -- src tests evals docs/prd docs/specs ':!evals/results'` が 0 件
- [ ] **Step 4: 確かめる** — `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit discover --dry-run`
- [ ] **Step 5: コミット**（「最初の問いの選択肢を、協力者の入口の言葉に寄せる（discover-1（具体的な一日を一つ聞く））」）

### Task 9: Spec、PRD、README を 24 の力に合わせる

**Files:**
- Modify: `docs/specs/00-common.md`（「言葉」の「画面では「この話から見えた力」「もう少し聞かせてほしいこと」「まだ聞けていない力」と言う」から「まだ聞けていない力」を外し、代わりの一文を書く。「力の名前「優先順位をつける力」を含む」を「優先順位設定力」に）
- Modify: `docs/specs/03-validate.md`（目的の「3 つの力を確かめる」「3 つとも」、力の状態の表の「3 つの行動すべて」、「次の一手」の「同じ数なら見立てる力、調整する力、優先順位をつける力の順」を「辞書の順」に、画面の表の「3 つの力の」、画面の決まりの「優先順位をつける力」、validate-1 の基準の「3 つの行動すべて」）
- Modify: `docs/specs/04-profile.md`（32〜33 行目の「3 つの核となる行動」「3 つはそろっていない」）、`docs/specs/05-options.md`（26 行目「3 つの力のどれか」）、`docs/specs/06-deepen.md`（24、76、105 行目の「3 つの力」）
- Modify: `docs/prd/6-quality.md`（確かめる場面の「別の話でも、同じ力の 3 つがそろった」を「すべてそろった」に）
- Modify: `README.md`（芯 1 を「力ごとに核となる行動を 2〜3 つ決めています」にし、例を利害調整力の 3 つの行動に。22 行目の「3 つの力（見立てる、調整する、優先順位をつける）」を、能力辞書の 24 の力（例: 傾聴力、段取り力、不安軽減力）に。評価の数字（87、95 行目付近）は変えない（本物の AI で回したあとにメインのセッションが直す））
- Modify: `evals/personas/README.md`（163、169 行目の力の id と 3 つの力の説明を、話から確かめる力の id（辞書を見る）に）

- [ ] **Step 1: 直す**
- [ ] **Step 2: 確かめる**
  - `git grep -n "見立てる力\|調整する力\|優先順位をつける力\|3 つの力\|3 つの核となる行動\|3 つとも" -- docs/specs docs/prd README.md src tests evals ':!evals/results' ':!evals/personas/how-to-judge.md'` — 残るのは、力と関係のない「3 つ」（選択肢 3 つ、カード 3 枚など）だけ
  - 00-common.md の力の表の id の並びが、`abilities.json` の active の並びと同じ（`node -e` で表の行の id を取り出して比べる）
- [ ] **Step 3: コミット**（「辞書の力に置き換える: Spec、PRD、README を 24 の力に合わせる（validate-1（すべてそろったときだけ根拠あり））」）

## Workflow 1 回目の確認コマンド

1. `dotnet build`（警告 0）、`dotnet test` — すべて PASS
2. `npm --prefix src/web ci`、`npm --prefix src/web run build`、`npm --prefix src/web test` — すべて PASS
3. `node --test .claude/hooks/guard.test.mjs` — PASS
4. `dotnet run --project evals/Revalue.Evals -- --unit discover --dry-run`、`--unit validate --dry-run`、`--unit options --dry-run`、`--unit deepen --dry-run` — 最後まで流れる
5. `git grep -nP "(?<![\w-])(noticing|coordinating|prioritizing)(?![\w-])" -- src tests evals ':!evals/results' ':!evals/personas/how-to-judge.md'` — 当たるのは、テストの中で古い id を作って確かめる所（`TestAbilities.cs`、`LegacyAbilityDataTests.cs`、`AbilityCatalogTests.cs` の古い id のテスト）だけ。`p01-coordinating-seen` のような記録のファイル名は、前後がハイフンなので当たらない
6. `git grep -n "見立てる力\|調整する力\|優先順位をつける力" -- src tests evals docs/specs docs/prd README.md ':!evals/results' ':!evals/personas/how-to-judge.md'` — 0 件

## Workflow 1 回目のあと（メインのセッション）

1. 本物の AI で `dotnet run --project evals/Revalue.Evals -- --unit discover` を回す。最初の問いの選択肢を変えたので、`6-quality.md` の 02 discover（話す）の合格の線を満たすこと、e20 で「思いどおりにいかなかった日」を選んだ人にわけを問い詰めていないこと（`noFailureProbe`）を見る。結果を `evals/results/<日付>-discover.md` に残す
2. 参考に `--unit validate` も回し、返事が出始めるまでの時間を 11/5 の結果（6〜9 秒）と比べる。力の表が 24 行になり、読み取りの指示が長くなったため。目に見えて遅ければ、2 回目の前に手を入れる。validate の合否は 2 回目のあとで決める（台本と判定役がまだそろっていないため）
3. `docs/superpowers/progress.md` の「開発者に確認してほしいこと」に足す: 続きの問い 47 文（21 の力）、代わりの一文と見えた力がないときの言葉、行動の文と本人の言葉の組の見せ方、最初の問いの選択肢、needsReview の 14 の力（`abilities-draft-notes.md` の表）、組織診断力を「組織の仕組みを見る力」にした名前、`CLAUDE.md` の芯 1 の「3 つ」

---

# Workflow 2 回目（3b: 評価の作り直し）

## まとまり D: 褒めすぎの判定役と数え方（heavy）

### Task 10: 根拠ありにした力ごとに、引用が行動を示しているかを判定役が見る

**Files:**
- Create: `evals/judges/evidence.md`（根拠の判定役の指示）
- Create: `evals/Revalue.Evals/EvidenceJudge.cs`（判定役の型、Claude の判定役、dry-run の判定役）
- Modify: `evals/Revalue.Evals/EvalRunner.cs`（最後の状態で根拠ありになった力すべてを判定役に渡し、答えを記録する。一つの話から画面に出す力（`AbilityShowcase.Of`）も記録する）
- Modify: `evals/Revalue.Evals/EvalProgram.cs`（判定役をつなぐ。dry-run では偽の判定役）
- Modify: `evals/Revalue.Evals/EvalSummary.cs`（褒めすぎの合格の線を、機械と判定役を合わせた数にする。参考の数を足す）
- Modify: `evals/Revalue.Evals/ReportWriter.cs`（例ごとに、根拠ありにした力ごとの行動の文と引用と判定役の答え、画面に出す力を書く）
- Modify: `evals/criteria.md`（機械で数えるものの「褒めすぎ」、AI が判定するものに根拠の判定役の節、合格の線と項目の対応の褒めすぎの行）
- Test: `tests/Revalue.Server.Tests/EvalsTests.cs`

**Interfaces:**
- Produces:
  - `public sealed record EvidenceVerdict(IReadOnlyList<bool> ActionsShown, bool SameEvent, string Reason)` — `ActionsShown` は行動の番号の順
  - `public interface IEvidenceJudge { Task<EvidenceVerdict?> JudgeAsync(string transcript, AbilityResult confirmed, CancellationToken ct); }`
  - `ClaudeEvidenceJudge`（構造化出力、effort high。いまの判定役と同じ呼び方）、`DryRunEvidenceJudge`（いつもすべて true）
  - `EpisodeRun` に、根拠ありにした力ごとの判定役の答えと、画面に出す力（`EpisodeShowcase`）を足す
- 判定役に渡すもの（evidence.md に書く）: 本人の答えに番号を振った会話（読み取りと同じ形）、力の名前と理由、行動ごとに行動の文と、その行動の根拠として見せる引用（選んだ答えなら結びついた言葉も）
- 判定役が答えるもの: 行動ごとに `shown`（引用が、本人がその行動をしたことを、推し量らずに示しているか）、`sameEvent`（引用がどれも同じ一つの具体的な出来事の話か）、`reason`。示していないとみなすもの: 本人以外がした行動、仮の話や一般論、言葉にしていない理由や考えを事実から推し量ったもの、行動の文の一部（たとえば「違う都合をつかむ」の「それぞれ」）が欠けているもの
- 褒めすぎ（合格の線）: 次のどれかに当たる（例、力）の組の数。同じ組は 1 件と数える。0 件で合格
  - 機械: 期待が confirmed でない狙った力と、`notConfirmed` の力が、根拠ありになった（Task 1）
  - 判定役: 根拠ありにした力のうち、どれかの行動が `shown: false`、または `sameEvent: false`、または判定役が答えられなかった
- 参考の数（合格の線なし）: 機械の褒めすぎ、判定役の褒めすぎ、根拠ありにした力の数と画面に出した力の数、画面に出す力が分類ごとに 2 つ以上だった話の数、もう少し聞かせてほしいことが 3 つ以上だった話の数

- [ ] **Step 1: 失敗するテストを書く**（`EvalsTests.cs`）
  - `validate-1（すべてそろったときだけ根拠あり）: 評価は、根拠ありにした力ごとに、判定役へ会話と行動の文と引用を渡し、示していない行動があれば褒めすぎに数える`
  - `validate-1（すべてそろったときだけ根拠あり）: 判定役が別の出来事の話だと答えた力と、判定役が答えられなかった力も、褒めすぎに数える`
  - `validate-1（すべてそろったときだけ根拠あり）: 機械の褒めすぎと判定役の褒めすぎが同じ力なら、1 件と数える`
  - `validate-1（すべてそろったときだけ根拠あり）: 判定役がすべての行動を示していると答えた力は、褒めすぎに数えない`
  - `validate-7（見えた力と、もう少し聞きたいことを示す）: 評価は、一つの話から画面に出す力を記録し、分類ごとに 2 つ以上出した話の数を参考の数字に残す`
  - `評価: 根拠の判定役の指示に、判定役の答えの項目がすべて書いてある`（いまの 366 行目と同じ形）
  - `評価: 結果のファイルに、根拠ありにした力ごとの行動の文、引用、判定役の答えと、画面に出す力を書く`
- [ ] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter FullyQualifiedName~EvalsTests`
- [ ] **Step 3: 判定役と数え方を作り、criteria.md を直す**
- [ ] **Step 4: 確かめる** — `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`（結果のファイルに判定役の欄が出る）
- [ ] **Step 5: コミット**（「辞書の力に置き換える: 根拠ありにした力ごとに、引用が行動を示しているかを判定役が見る（validate-1（すべてそろったときだけ根拠あり））」）

### Task 11: 汎用の AI との比較を台本に書いた力で読み、評価との対応を書き直す

**Files:**
- Modify: `evals/judges/generic.md`（決め打ちの 3 つの力と例をやめ、渡した `<abilities>` の力だけを読む形に。力ごとに名前と核となる行動の文を渡し、言い方が違っても核となる行動が同じ強みなら当たるとする）
- Modify: `evals/Revalue.Evals/GenericComparison.cs`（`IGenericReader.ReadAsync` に台本に書いた力を渡す。答えの形を `{ abilities: [{ id, named, quotes }], reason }` にし、渡した力がそれぞれちょうど 1 回あるかをコードで確かめる。力の一覧は、キャッシュの効くシステムの指示ではなく、会話と一緒に渡す）
- Modify: `evals/criteria.md`（「汎用の AI との比較」）
- Modify: `docs/specs/03-validate.md`（「評価との対応」の台本の数と種類: 24 の力それぞれに根拠ありになる台本、分類ごとに一部だけそろう台本、似た力が並ぶ台本。褒めすぎの数え方は criteria.md を参照）
- Modify: `docs/prd/6-quality.md`（確かめる場面に 1 行: 「一つの話で、同じ分類の力がいくつもそろった | 画面に出す力は分類ごとに 1 つ。根拠ありにした力の引用が、核となる行動を本当に示している」。合格の線の表は変えない）
- Test: `EvalsTests.cs`

**Interfaces:**
- Produces: `IGenericReader.ReadAsync(string transcript, string answer, IReadOnlyList<Ability> abilities, CancellationToken ct)`、`GenericReading`（渡した力だけを持つ）

- [ ] **Step 1: 失敗するテストを書く**
  - `評価: 汎用の AI の答えを読む判定役には、台本に書いた力だけを、名前と核となる行動の文と一緒に渡す`
  - `評価: 汎用の AI の答えを読む判定役の答えに、渡した力が欠けているか重なっていれば、読めなかったと数える`
  - いまの `評価: 汎用の AI との比較は、…` のテストを、渡した力だけで数える形で通す
- [ ] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter FullyQualifiedName~EvalsTests`
- [ ] **Step 3: 直す**
- [ ] **Step 4: 確かめる** — `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`
- [ ] **Step 5: コミット**（「辞書の力に置き換える: 汎用の AI との比較を台本に書いた力で読み、評価との対応を書き直す（validate-1（すべてそろったときだけ根拠あり））」）

## まとまり E: 根拠ありになる台本（21 本）

### 台本の書き方（Task 12〜15 で共通）

- 置き場所と形: `evals/episodes/eNN-<力の id>.md`。前書きは Task 1 の形（`id`、`title`、`unit: validate`、`expect: concreteEvent`、`states`、必要なら `notConfirmed` と `ask`）。本文に「すべて架空の話。このハッカソンの期間中に新しく書いた。」と「## どんな例か」（狙った力の名前と、どの答えにどの行動が出るか）を書く
- 答えは 4〜6 行。最初の答えは、最初の問い（「最近、気持ちが動いた日のことを、一つ聞かせてください。どんな日でしたか？」）への答えとして、いつのどんな日かから始める
- 狙った力の核となる行動を、一つの具体的な出来事の中で、行動ごとに別の句で話す。一つの句に 2 つの行動を詰めない（ほかの行動の引用を含む引用は数えないため）
- 本人がしたことを本人の言葉で話す（「私が」「私から」）。家族やほかの人がしたことと分かる書き方にしない
- 核となる行動の文と手がかりを、そのまま写さない。普通の話し言葉にする
- 結果は良くても悪くても、話さなくてもよい。結果の良し悪しで根拠を変えない例になる
- 子育て、家事、親の介護、地域、学校、パートのような、育児などでキャリアを中断した人の日々の場面にする。実在の人、店、学校、地名、病名を書かない。家族の病気の詳しいこと、つらい状態のサインになる言葉を入れない
- `notConfirmed` には、その話にはっきり行動がない近い力（同じ分類の力、名前の似た力）か、推し量りでしか根拠にならない力だけを書く。迷う力は書かず、判定役に任せる（Claude の判断）
- 場面の筋は下の表の案から始めてよい（Claude の判断）。ほかの台本と筋が重ならないようにする

### Task 12: 人を理解する力、対話・コミュニケーション、人事・組織、問題発見・分析・判断の 10 本

**Files:** Create `evals/episodes/e21`〜`e30`

| 台本 | 狙った力（states） | 場面の案 |
|---|---|---|
| e21-info-gathering | 情報収集力 = confirmed | 保育園のお迎えで、先生に子どもの園での様子を、答えやすい聞き方を選んで聞く |
| e22-sensing-incongruity | 違和感察知力 = confirmed | 子どもが「宿題は終わった」と言うのに、ノートが鞄に入ったままなのを見て、言うこととしていることの食い違いに気づく |
| e23-summarizing | 要約力 = confirmed | 実家の母からの長い電話を聞き、言いたいことをまとめて、自分の言葉で言い直して返す |
| e24-question-design | 質問設計力 = confirmed | 「今日どうだった」に答えない子に、答えにくい聞き方だと気づき、給食のことのような具体的な聞き方に変える |
| e25-active-listening | 傾聴力 = confirmed | 近所の友人の悩みを、助言をこらえて聞き、何を言いたいのかを受け取る |
| e26-helping-put-into-words | 言語化支援力 = confirmed | 言葉に詰まる上の子の気持ちを、「くやしかったのかな」と言葉にして確かめる |
| e27-organizing-issues | 論点整理力 = confirmed | 子ども会の話し合いがあちこちに広がり、何を決める話かを言い、決めることを分けて並べる |
| e28-considering-fairness | 公平性を考える力 = confirmed | きょうだいのゲームの時間の決め方を決め、2 人に同じように当てはめる |
| e29-cause-analysis | 原因分析力 = confirmed | 朝の支度が遅れたわけを考え、起きたことと、前の晩の寝る時間のような条件を分けて挙げる |
| e30-hypothesis-thinking | 仮説思考力 = confirmed | 部屋干しの洗濯物のにおいの原因を、干す間隔かもしれないと仮に置き、干し方を変えて確かめる |

- [ ] **Step 1: 10 本を書く**（上の「台本の書き方」）
- [ ] **Step 2: 確かめる** — `dotnet test --filter FullyQualifiedName~EvalsTests`、`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`（すべて読めて流れる）
- [ ] **Step 3: コミット**（「辞書の力に置き換える: 根拠ありになる台本を 10 本足す（validate-1（すべてそろったときだけ根拠あり））」）

### Task 13: 調整・実行・仕組み化、家庭・子育て、共感・安心、問い・洞察、実行・挑戦の 11 本

**Files:** Create `evals/episodes/e31`〜`e41`

| 台本 | 狙った力（states） | 場面の案 |
|---|---|---|
| e31-planning-steps | 段取り力 = confirmed | 子どもの誕生日の集まりのために、やることを書き出し、どの順で進めるかを決める |
| e32-improving-work | 業務改善力 = confirmed | 毎朝の水筒とお弁当の準備で二度手間に気づき、前の晩にまとめるやり方に変える |
| e33-managing-deadlines | 期限管理力 = confirmed | 学校の提出物と役所の手続きの締め切りをつかみ、それに合わせて取りかかる日を決める（決めた日と締め切りのつながりを、本人が言葉にする） |
| e34-adapting-explanations | 相手に応じた説明力 = confirmed | 引っ越しのことを、年長の子と祖父に、それぞれが分かる言葉で説明し分ける |
| e35-handling-schedule-changes | 予定変更への対応力 = confirmed | 学級閉鎖で急に子どもが家にいることになり、パート先と祖母に連絡し、その日の予定を組み直す |
| e36-empathy | 共感力 = confirmed | 手伝いを断られて機嫌を損ねた義母の立場を思い浮かべ、気持ちのわけを考えて尋ねる |
| e37-easing-anxiety | 不安軽減力 = confirmed | 初めての歯医者を怖がる子から心配なことを聞き取り、何をするかの順番を前もって伝える |
| e38-digging-deeper | 深掘り力 = confirmed | 習い事をやめたいと言う子に、最初の答えのあと、具体的な場面、背景、そう決めたわけを順に尋ねる |
| e39-seeing-it-through | 走破力 = confirmed | 自治会の会報づくりで困りごとが続いても、何のために出すかを持ったまま、次の工程を進める |
| e40-persistence | 粘り強さ = confirmed | 外れた網戸を直そうとして一度ではうまくいかず、やり方を変えてもう一度取り組む |
| e41-resilience | 回復力 = confirmed | 入園グッズを縫っていてミシンが動かなくなり、残っている作業を整理し直して、手縫いで続ける |

- e33 は、締め切りを確かめた事実だけでは根拠にしない決まり（e19）の対になる。e19 の `notConfirmed` に期限管理力を書いた理由が分かるよう、「どんな例か」に書く
- [ ] **Step 1: 11 本を書く**
- [ ] **Step 2: 確かめる** — `dotnet test --filter FullyQualifiedName~EvalsTests`、`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`
- [ ] **Step 3: コミット**（「辞書の力に置き換える: 根拠ありになる台本を 11 本足す（validate-1（すべてそろったときだけ根拠あり）、validate-3（結果で見立てを変えない））」）

## まとまり F: 一部だけそろう台本と、似た力が並ぶ台本

### Task 14: 分類ごとの一部だけそろう台本 8 本

調整・実行・仕組み化は、いまの e11、e12、e19 があるので書かない。

**Files:** Create `evals/episodes/e42`〜`e49`

| 台本 | 狙った力（states） | ask | 場面の案 |
|---|---|---|---|
| e42-info-gathering-partial | 情報収集力 = needsCheck | info-gathering.1 | 学童の先生から子どもの様子を聞き出すが、聞き方で気をつけたことは話さない |
| e43-summarizing-partial | 要約力 = needsCheck | summarizing.2 | 夫の話の要点をまとめたことは話すが、自分の言葉で返したことは話さない |
| e44-considering-fairness-partial | 公平性を考える力 = needsCheck | considering-fairness.2 | お手伝いの当番の決め方を決めたが、それをどう当てはめたかは話さない |
| e45-hypothesis-thinking-partial | 仮説思考力 = needsCheck | hypothesis-thinking.2 | 子どもの寝つきが悪い原因を仮に置くが、確かめたことは話さない |
| e46-handling-schedule-changes-partial | 予定変更への対応力 = needsCheck | handling-schedule-changes.3 | 急な予定の変更と、関わる人への連絡までは話すが、あとの予定の組み直しは話さない |
| e47-easing-anxiety-partial | 不安軽減力 = needsCheck | easing-anxiety.2 | 転校を前にした子の心配を聞き取るが、伝えたことは話さない |
| e48-digging-deeper-partial | 深掘り力 = needsCheck | digging-deeper.3 | 子どもの話に具体的な例と背景は尋ねるが、考えのわけは尋ねない |
| e49-resilience-partial | 回復力 = needsCheck | resilience.3 | 手作りの準備が途中で止まり、状況を整理し直したところまでで、また動き出したことは話さない |

- 足りない行動は、あとの答えでも話さない（聞き返したかを見るため）。狙った力の行動が、その出来事でいちばん多くそろうようにし、ほかの力の行動を重ねない
- [ ] **Step 1: 8 本を書く**
- [ ] **Step 2: 確かめる** — `dotnet test --filter FullyQualifiedName~EvalsTests`、`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`
- [ ] **Step 3: コミット**（「辞書の力に置き換える: 分類ごとに一部だけそろう台本を足す（validate-2（足りない行動だけ聞き返す））」）

### Task 15: 似た力が並ぶ台本と、台本のそろい方のテスト

**Files:**
- Create: `evals/episodes/e50-similar-dialogue.md`（対話・コミュニケーションの力が一つの出来事で並ぶ話。近所の友人の相談に乗った夜に、助言をこらえて聞き、言いたいことをつかみ、要点をまとめて自分の言葉で返す。前書きは `states: summarizing=confirmed, active-listening=confirmed`）
- Modify: `tests/Revalue.Server.Tests/EvalsTests.cs`
- Modify: `docs/specs/03-validate.md`（「評価との対応」に e21〜e50 の数が合っているか見直す）

- [ ] **Step 1: 失敗するテストを書く**（`EvalsTests.cs`。リポジトリの台本を読む）
  - `validate-1（すべてそろったときだけ根拠あり）: 話から確かめる 24 の力それぞれに、根拠ありになる台本が 1 本以上ある` — 話から確かめる力は辞書から読む（力の id をテストに決め打ちしない）
  - `validate-2（足りない行動だけ聞き返す）: 話から確かめる力のある分類それぞれに、一部だけそろう台本（ask あり）が 1 本以上ある`
  - `validate-7（見えた力と、もう少し聞きたいことを示す）: 同じ分類の 2 つの力が根拠ありになる台本が 1 本以上ある`
  - `評価: リポジトリの確かめの例がすべて読め、すべて架空と書いてあり、ask の行動は states で needsCheck の力のもの`
  - `評価: 台本の答えに、狙った力の核となる行動の文と手がかりを、そのまま写していない`
- [ ] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter FullyQualifiedName~EvalsTests`（e50 がないので、似た力のテストが FAIL）
- [ ] **Step 3: e50 を書く**
- [ ] **Step 4: 確かめる** — `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit validate --dry-run`
- [ ] **Step 5: コミット**（「辞書の力に置き換える: 似た力が並ぶ台本を足し、台本のそろい方をテストで確かめる（validate-7（見えた力と、もう少し聞きたいことを示す））」）

## Workflow 2 回目の確認コマンド

1. `dotnet build`（警告 0）、`dotnet test` — すべて PASS
2. `npm --prefix src/web ci`、`npm --prefix src/web run build`、`npm --prefix src/web test` — すべて PASS
3. `node --test .claude/hooks/guard.test.mjs` — PASS
4. `dotnet run --project evals/Revalue.Evals -- --unit discover --dry-run`、`--unit validate --dry-run`、`--unit options --dry-run`、`--unit deepen --dry-run` — 最後まで流れる。validate の結果のファイルに、42 本（e08〜e19、e21〜e50）の例と、根拠の判定役の欄が出る

## Workflow 2 回目のあと（メインのセッション）

1. 本物の AI で `--unit validate`、`--unit discover`、`--unit options`、`--unit deepen` を回し、結果を `evals/results/<日付>-<まとまり>.md` に残す。合格の線は `6-quality.md` のまま（褒めすぎ 0 件、引用の一致すべて、そろった例 9 割以上、足りない行動だけ聞き返す 9 割以上など）
2. 返事が出始めるまでの時間を、11/5 の評価（6〜9 秒）と比べる
3. 通らなければ、原因を力ごとに見る。台本の書き方の問題なら台本を、読み取りの問題なら `reader.md` を直す。日々の話から確かめにくい力（設計の「まだ分かっていないこと」。公平性を考える力、業務改善力など）は、準備中に戻すことも選べる。そのときは 00-common.md の表と台本のそろい方のテストも合わせる。2 回直しても通らなければ保留にする
4. 判定役が「示していない」とした引用と、画面に出さなかった力の数を読み、褒めすぎに見えないかを確かめる。AI の言い方は AI 同士の判定だけで確定しないので、会話記録を開発者が確かめる項目に残す
5. `README.md` の評価の数字を、新しい結果に直す。`docs/superpowers/progress.md` を直す
6. `evals/personas/how-to-judge.md` の「力の見込み」「カードの見込み」は手順 5 で書き直す

---

## この計画で Claude が決めたこと

- Workflow を 2 回に分け、台本の前書きの形（Task 1）を辞書の置き換え（Task 2）より先にする。24 の力すべての状態を台本に書かずに、評価を流し続けるため
- 見せた力の決め方（Task 6）: 力の確かめに使える場面のどれかで見せた力だけを、見えた力の画面、力の本の状態と履歴、できること、カード、深める、レポートに使う。状態は見せた場面のうちいちばん進んだもの。ある話で隠れた根拠ありの力が、別の話で要確認として見せてあれば、要確認として出す
- 続きの問いは辞書のデータ（`resumeQuestion`）に持たせ、21 の力の 47 文を新しく書く。手がかりから型で組み立てると、いまの 9 つの文の言い方（「ありましたか」「いましたか」）を保てないため
- 要確認の力（もう少し聞かせてほしいこと、確かめ中）には行動の文を添えない。そろった行動とそろっていない行動を並べると、チェック表に見えるため
- 判定役に、引用が同じ出来事の話か（`sameEvent`）も聞く。読み取りが別の日の言葉を同じ出来事にしても、褒めすぎとして見つけるため
- 汎用の AI との比較は、台本に書いた力だけで数える
- ファイル名に古い id がある台本は、番号を変えずに名前だけ直す。架空の記録（`evals/profiles/`）は、テストと深めるの案が名前で指すので名前を変えない
