# 業務マスター（手順 4） Implementation Plan

> **For agentic workers:** このリポジトリでは run-plan スキル（`.claude/workflows/run-plan.js`）で回す。Steps use checkbox (`- [ ]`) syntax for tracking. Workflow は 1 回（3 まとまり）。

**Goal:** 仕事の選択肢のもとにする職種と業務を、いまの 3 職種 12 業務から、協力者のインタビューをもとにした業務マスター（10 領域、30 職種、125 業務。カードに使うのは 115）に置き換える。業務の力を「主な力と補助の力」に広げ、力が生きる場面、小さな試し方、本人に確かめる条件を、カード、深める、レポートで使う。

**Architecture:** `jobs.json` を下書き `.tmp/task-master/jobs-draft.json` の形と中身にし（時給の下限と準備中の業務だけ直す）、`JobCatalog` が領域、職種、業務の状態（`active` / `preparing`）、主な力と補助の力、活用場面、小さな試し方、確かめる条件を読む。カードの候補は `active` の業務だけで、業務が力に「つながる」とは、主な力か補助の力のうち話から確かめる力にその力があること。カードの業務の写し（`CardTask`）の形は変えず、活用場面は表示のときに業務マスターから引く。保存データ（カード、選んだ案、深めた中身、レポートの版）は業務の id で業務マスターを引くので、いまの 12 業務の id を残す。

**Tech Stack:** ASP.NET Core（.NET 10）、xUnit v3、React と TypeScript（Vitest）、評価は `evals/Revalue.Evals`

**Spec:** 設計 `docs/superpowers/specs/2026-11-05-ability-dictionary-design.md` の「3. 業務マスター」「点検で決めたこと」と、順番の手順 4。正しい姿は `docs/specs/05-options.md`、`06-deepen.md`、`07-report.md`、`00-common.md` の「力」、`docs/prd/5-information.md` の「職種と業務のデータ」。業務マスターの中身は、下書き `.tmp/task-master/jobs-draft.json` と判断のメモ `.tmp/task-master/jobs-draft-notes.md`（どちらも git が無視する置き場所。Workflow の中のエージェントはそこから読む）

---

## 進め方（Workflow 1 回）

| まとまり（taskGroups） | タスク | heavy |
|---|---|---|
| A: 業務マスターのデータと、仕事の選択肢 | Task 1〜2 | true |
| B: 選んだ案を深める、可能性レポート | Task 3〜4 | true |
| C: 画面、保存データ、評価、文書 | Task 5〜6 | false |

**args:** `touchesVoice: true`（AI への指示 `options.md`、`deepen.md` と、画面の文言を変えるため）。specs は `docs/specs/00-common.md`、`00-tech-stack.md`、`05-options.md`、`06-deepen.md`、`07-report.md`。PRD は `docs/prd/5-information.md` も変える。

**受け入れ基準:** options-2（選ぶは登録した職種から）、options-3（組み合わせるは登録した業務から）、options-5（条件の範囲だけ）、options-8（理由は本人の言葉とつなぐ）、options-9（業務マスターの形を守る。新規）、options-10（力が生きる場面を添える。新規）、deepen-2（業務ごとに照らす）、deepen-3（最初の一歩は小さく）、deepen-6（仮の場面での考え方を聞く）、report-1（一つにまとめて示す）、report-3（版を残す）、validate-12（本人が見立てを外せる）、common-1（使わない言葉を出さない）

**準備（済み）:** 下書き、判断のメモ、下書きを作ったスクリプト（`jobs-build.py`、`jobs-check.py`）は `.tmp/task-master/` に、job tag の CSV は `.tmp/jobtag/utf8/` に、協力者の表は `.tmp/REVALUE_業務マスター120 (1).xlsx` にある。どれもコミットしない。

### 下書きから変えること（Task 1 で入れる）

下書きを作ったあとで決めたこと。決めたことの記録 `docs/decisions/2026-11-05-task-master.md` にも書く。

1. 話から確かめる力は 22（原因分析力 `cause-analysis` と仮説思考力 `hypothesis-thinking` は辞書で準備中）。業務の力に準備中の力が入っていてもよい（辞書にある id ならよい）。カード、深める、レポートで力として示し、理由に使うのは、見せた力だけ（`00-common.md` の「見せる力」）
2. 時給の目安の下限を 1,300 円にそろえる（Claude の判断）。下限が 1,300 円未満の業務は下限を 1,300 円にし、上限が 1,300 円未満なら上限も 1,300 円にする。2026 年度の地域別最低賃金は東京都 1,280 円、全国加重平均 1,177 円で、下書きの 1,200 円は東京都などで下回るため。いまの 12 業務も同じ（下書きでは 51 業務が当たる）
3. 保険の営業（`insurance-sales`、job tag 453）の 6 業務と、キャリアコンサルタント（`career-consultant`、136）の 1 業務は `preparing` にする（Claude の判断）。保険を扱うには登録が要り、給与が歩合で決まることが多く、時給の目安と合わない。キャリアコンサルタントは名乗るのに国家資格が要る。どちらも「短い時間から小さく始める」選択肢として出せない。`needsReview` は下書きのまま
4. 業務のデジタル化の支援（`dx-support`）は `active` のまま。開発者に確かめる事項に残す

2 と 3 を入れたあとの数（計算済み）: 業務 125、`active` 115、`active` の業務のない職種 5（保険の営業、キャリアコンサルタント、職種の決まっていない 3 つ）。話から確かめる 22 の力は、どれも `active` の業務の主な力か補助の力に 2 回以上出る（いちばん少ないのは回復力の 2 回、次が走破力の 3 回）。そのため補助の力は足さない。`active` の業務のうち `web-marketing-ad-results`（広告の効果の比較）だけは、力が準備中の 2 つ（仮説思考力、原因分析力）で、いまはカードの候補に入らない（下の「AI に渡す候補」）。準備中の力を戻したときに使えるので `active` のまま置く（Claude の判断）。

### 出典の `note`（Task 1 で置き換える。この文のとおり）

```
職種と業務の言葉は、協力者の業務マスターと job tag のタスクを元に、家庭と両立しながら受けやすい形に言い換えた（jobtagTasks は job tag の職業のタスクの番号）。使う力、力が生きる場面、週あたりの時間、時間帯、場所、時給の目安、要る知識や道具、小さな試し方、本人に確かめる条件は job tag にない値で、Claude が下書きした。開発者が確かめて直す。時給の目安の下限は、2026 年度の地域別最低賃金（東京都 1,280 円）を下回らないよう、1,300 円以上にそろえた。needsReview が true の業務は、使う力を Claude が付け替えたか足したもので、協力者に確かめる。preparing の業務はカードに使わない。job tag の近いタスクがまだ見つかっていない業務と、登録や国家資格が要るか給与が歩合で決まることが多く、短い時間から小さく始める形で出せない業務（保険の営業、キャリアコンサルタント）
```

### 活用場面、小さな試し方、確かめる条件の使い道（Claude の判断）

最小で筋の通る形として、次のようにする。設計の「レポートとカードでは、力に仕事のどの場面に役立つか（活用場面）を添える」を満たし、ほかの場所には広げない。

| 項目 | 使う所 | 使わない所 |
|---|---|---|
| 活用場面（`scene`） | 仕事の選択肢の AI に渡す候補（理由で業務のどこに生かせそうかを書く手がかり）。カードの業務のうち、カードに使った力を主な力に持つ業務に添える。深めるの使えるところで、主な力が使える力の業務に添える。レポートの選んだ案に、カードと同じ決め方で添える | 理由と力を出さないとき（外した、記録と合わない）。前の版。主な力でない力に添えること（活用場面は主な力を中心に書いてあるため） |
| 小さな試し方（`trial`） | 深めるの AI に渡す登録の業務に「小さな試し方の例」として渡し、一歩の候補の手がかりにする | 画面にはそのまま出さない。コードが決めた一歩の候補にも使わない |
| 本人に確かめる条件（`checks`） | 深めるとレポートの「まだ確かめていないこと」に、業務ごとに「確かめておきたいこと（…）」の一行で出す。前の版にも残す（知識や道具と同じく業務の値で、本人の状態ではないため） | カードの絞り込み、力の確かめ、AI に渡す文 |

### AI に渡す候補（Claude の判断）

仕事の選択肢の AI に渡す候補は、`active` の業務のうち、本人の条件に合い、本人の使える力のどれかにつながる業務だけにする。115 業務がすべて条件に合うと、1 回の文が数万字になるため。また理由が業務から離れないため。「組み合わせる」は、どの業務も使える力のどれかにつながる組み合わせになる（いまは 1 つがつながればよかった）。カードの力の決まり（「選ぶ」「組み合わせる」の力は、カードの業務のどれかにつながる力）は変えない。

---

## Global Constraints

- 回答・文書・コミットメッセージは日本語。受け入れ基準の呼び名は、必ずタイトルとセットで書く（例: options-9（業務マスターの形を守る））。テスト名（`DisplayName` と Vitest の `it`）も、その呼び名とタイトルで始める
- 製品の芯を守る。登録していない職種と準備中の業務をカードに出さない。条件を超える案を出さない。言い切りと順位を付けない。本人が外した力と、画面に出さない力（見せていない力）は、カード、深める、レポートの理由にも、活用場面にも使わない
- 業務マスターの中身は、下書き `.tmp/task-master/jobs-draft.json` のとおりに入れ、上の「下書きから変えること」の 2 と 3 と出典の `note` だけを変える。業務の名前、中身、力、活用場面、小さな試し方、確かめる条件の文を書き換えない（文を直すときは、Task 1 の写しの確かめを回し直す）
- 協力者の表の文をそのまま写さない（8 文字以上の重なり。いまは業務名「固定資産台帳の更新」だけが重なり、一般的な呼び名なので残す）。協力者の資料（`.tmp/` の表や文書）をコミットしない。実在の人、会社、製品名を入れない
- 小さな試し方には、`DeepenValidator.PushyStepWords`（応募、契約、申し込、申込、購入、ましょう、すべき）を入れない
- 業務の id は英語の小文字とハイフン。いまの 12 業務の id（`online-secretary-email`、`online-secretary-schedule`、`online-secretary-arrangement`、`online-secretary-briefing`、`accounting-check`、`accounting-invoice`、`accounting-monthly`、`accounting-cash`、`recruiting-posting`、`recruiting-interview-schedule`、`recruiting-applications`、`recruiting-reception`）は消さず、職種（`online-secretary`、`accounting-clerk`、`recruiting-clerk`）も変えない
- 保存データの形を変えない。`CardTask.Ability`（保存名 `ability`）は、カードを作ったときの業務の主な力の写しとして残す。深めた中身の見立ての業務（`DeepenTask`）と問いの力は 1 つのまま
- 力の id、名前を、裏側のコード、画面のコード、AI への指示に決め打ちしない（例外はテストの値と評価のデータ）
- 本物の AI を呼ぶのは評価だけ。テストでは偽物を使う。Workflow の中では評価を `--dry-run` まで回し、本物の AI の評価はメインのセッションが回す（Workflow の中では鍵が読めないため）
- 合格の線は `docs/prd/6-quality.md` のまま変えない
- `CLAUDE.md`、`docs/superpowers/progress.md`、`evals/personas/how-to-judge.md` は触らない。`evals/results/` の過去の結果、`docs/decisions/` の過去の記録、`docs/superpowers/` の過去の計画は書き換えない
- Spec には正しい姿だけを書き、経緯（「下書きでは」「前は」）を書かない

## Review Focus

1. **業務マスターに置き換える前の保存データ**: いまの 12 業務の id と前の名前（「日程の調整」など）を持つカード、選んだ案、深めた中身、レポートの版がある人が、仕事の選択肢、深める、レポートを開く。どれも 200 で、カードは写しの名前のまま出て、時間帯と収入はいまの業務マスターの値で計算し直す。深めた中身は、選んだ案の業務の id が同じなので作り直さない（Task 6 のテスト）
2. **主な力が準備中の業務と、力がすべて準備中の業務**（`planning-cause-hypothesis`、`web-marketing-ad-results`）: カードの力にならない。深めるとレポートの「まだ確かめていない力」に準備中の力の名前を出さない。問いの力に使わない。画面の「直す」の欄を開かない（Task 1、3、4、5 のテスト）
3. **補助の力だけでつながる業務**（例: `online-secretary-schedule` の利害調整力）: 「選ぶ」「組み合わせる」の理由に使え、深めるの使えるところに出る。活用場面は添えない（Task 1、2、3 のテスト）
4. **カードに使う業務のない職種と準備中の業務**（保険の営業、キャリアコンサルタント、職種の決まっていない 3 つ）: AI に渡す候補に出ない。AI が準備中の業務の id を返したら、渡していない ID として落とす。前に保存したカードの業務が準備中になっていたら、そのカードは出さず、選んだ案の中身は残す。評価は準備中の業務の id を「登録していない職種」に数える（Task 1、2 のテスト）
5. **外した力と、画面に出さない力が、業務の補助の力にあるとき**: 深めるの使えるところに出ない。活用場面も添えない。外した力が業務の主な力なら、名前を出さずに外した見立てはここに出していないと伝える（いまのまま）（Task 3、4 のテスト）

---

# まとまり A: 業務マスターのデータと、仕事の選択肢（heavy）

### Task 1: 業務マスターを読み込み、jobs.json を置き換え、業務の力を「主な力と補助の力」にする

**Files:**
- Modify: `src/Revalue.Server/Features/Options/JobCatalog.cs`（形を広げ、読み込みの決まりを足す。`JobTask.Ability` を消す）
- Modify: `src/Revalue.Server/Features/Options/jobs.json`（下書きの中身にする）
- Modify: 業務の力を使う所すべて（つながりの決まりだけを変え、表示は変えない）
  - `Features/Options/OptionCandidates.cs`（つながる = `JobTask.Uses`。候補は `active` の業務だけ。絞り込みは Task 2）
  - `Features/Options/OptionsValidator.cs`（`abilityNotInTasks` の判定を `Uses` に。`CardTaskOf` の `Ability` は `Abilities.Main`。保存したカードの業務が準備中なら、`Resolve` で見つからないものとして扱う）
  - `Features/Deepen/DeepenLighting.cs`（この Task では、`TaskLight.Ability` に `Abilities.Main` を入れるだけ。Task 3 で広げる）
  - `Features/Deepen/DeepenValidator.cs`（問いの力の `allowed` は、登録の業務なら `ActiveAbilities` の和。見立ての業務はいまのまま）
  - `Ai/ScriptedOptionsAi.cs`（業務の力の中から使える力を探す）、`Ai/ScriptedDeepenAi.cs`（登録の業務の `ActiveAbilities` の最初の力。なければいまの `BalancingInterests`）
  - `Ai/ClaudeOptionsAi.cs`、`Ai/ClaudeDeepenAi.cs`（この Task では「使う力」の行を、話から確かめる力を「、」でつないだ 1 行にするだけ。Task 2、3 で形を決める）
- Modify: `docs/specs/05-options.md`（「登録した職種と業務」を下の中身に。「カードの理由」の「使った力が、カードの業務のどれかの「使う力」と同じ」を「業務の主な力か補助の力のどれか」に。「AI が書いた中身をコードで確かめる」の「業務の「使う力」と合わない力」も同じ。受け入れ基準に options-9 を足す。「やらないこと」の「職種と業務を増やすこと。P1」を「準備中の業務をカードに使うこと。条件と出典を足して active にするのは P1」と「本人に確かめる条件で、カードを絞り込むこと」に。「評価との対応」の最後の行に、業務マスターの値（力、活用場面、時間、時給の目安、小さな試し方、確かめる条件）は Claude の下書きと書く）
- Modify: `docs/prd/5-information.md`（「職種と業務のデータ」の表に 3 行足す: 力が生きる場面 | カード、深める、レポートで、力が業務のどこで生きるかを添える。小さな試し方 | 深めるの最初の一歩の候補の手がかり。本人に確かめる条件 | 深めるとレポートで、まだ確かめていないこととして示す。力の確かめにもカードの絞り込みにも使わない）
- Create: `docs/decisions/2026-11-05-task-master.md`
- Test: `tests/Revalue.Server.Tests/JobCatalogTests.cs`（作り直す）、`ConditionFitTests.cs`（小さい JSON を新しい形に）、`OptionsValidatorTests.cs`、`OptionsApiTests.cs`、`DeepenValidatorTests.cs`、`ScriptedOptionsAiTests.cs`、ほかデータの数・並び・名前・時給で期待が変わるテスト

**Interfaces:**
- Produces（`JobCatalog.cs`）:

```csharp
[JsonConverter(typeof(NamedEnumConverter<JobTaskStatus>))]
public enum JobTaskStatus { [JsonStringEnumMemberName("active")] Active, [JsonStringEnumMemberName("preparing")] Preparing }

public sealed record JobDomain(string Id, string Name);

/// 業務の力。Main と Sub は辞書にある力（準備中の力でもよい）。All は主な力、補助の力の順。
public sealed record TaskAbilities(Ability Main, IReadOnlyList<Ability> Sub) { public IReadOnlyList<Ability> All { get; } }

public sealed record JobTask(
    string Id, string Name, string Detail, JobTaskStatus Status, bool NeedsReview, IReadOnlyList<int> JobTagTasks,
    TaskAbilities Abilities, string Scene, HoursRange HoursPerWeek, IReadOnlyList<TimeSlot> TimeSlots, TaskPlace Place,
    YenRange HourlyYen, IReadOnlyList<string> Knowledge, string Trial, IReadOnlyList<string> Checks)
{
    public bool IsActive { get; }                         // Status == Active
    public IReadOnlyList<Ability> ActiveAbilities { get; } // All のうち AbilityCatalog.IsActive。主な力、補助の力の順
    public bool Uses(Ability ability);                     // ActiveAbilities に ability がある（業務がその力に「つながる」）
}

public sealed record Occupation(string Id, string Name, string DomainId, string Summary, JobTagRef? JobTag, IReadOnlyList<JobTask> Tasks);

public sealed record JobCatalog(JobSource Source, IReadOnlyList<JobDomain> Domains, IReadOnlyList<Occupation> Occupations)
{
    public IEnumerable<JobTask> AllTasks { get; }
    public IEnumerable<JobTask> ActiveTasks { get; }   // カードに使う業務
    public JobTask? FindTask(string id);              // 準備中も引く（保存データと深めるのため）
    public JobTask? FindActiveTask(string id);        // カードと評価のため
    // FindOccupation、OccupationOf はいまのまま
}
```

- JSON の形は下書きのとおり（`domains`、職種の `domain` と `jobtag`（null 可）、業務の `status`、`needsReview`、`abilities: { main, sub }`、`scene`、`trial`、`checks`）
- 読み込みで止めるもの（`InvalidOperationException`。文は英語でいまの形「jobs.json: …」）: 領域・職種・業務の id の重なり、id が `^[a-z0-9]+(-[a-z0-9]+)*$` でない、辞書にない領域を指す職種、辞書（`AbilityCatalog.Find`）にない力、主な力と補助の力の重なり、補助の力が 4 つ以上、知らない状態、名前・中身・活用場面・小さな試し方が空、いまの時間・時間帯・時給の決まり（どの業務にも）、`active` の業務の `jobtagTasks` が空、`jobtag` が null の職種に `active` の業務がある
- 止めないもの: 準備中の力を持つ業務、`active` の業務がない職種（job tag のある職種でもよい。下書きのメモにあった「job tag のある職種には active の業務が 1 つ以上」は、保険の営業とキャリアコンサルタントを準備中にしたので入れない）、`checks` が空
- 文の長さはデータのテストで見る（読み込みでは止めない）: 業務の名前 30、中身 80、知識や道具 60、活用場面 80、小さな試し方 100 文字まで（Claude の判断。深めるの上限と同じ。活用場面は下書きの最長 60 文字に余裕を持たせた）

- [x] **Step 1: 失敗するテストを書く**（`JobCatalogTests.cs`。いまの 3 職種と 12 業務のテストを置き換える）
  - `options-9（業務マスターの形を守る）: 登録データは 10 の領域、30 の職種、125 の業務を持ち、カードに使う業務は 115`
  - `options-9（業務マスターの形を守る）: 話から確かめる力それぞれに、カードに使う業務が 2 つ以上つながる（主な力か補助の力）` — 力は `AbilityCatalog.Active` から読む
  - `options-9（業務マスターの形を守る）: カードに使う業務の時給の目安の下限は 1,300 円以上で、上限は下限以上` — 出典の `note` に「1,300 円」がある
  - `options-9（業務マスターの形を守る）: 保険の営業とキャリアコンサルタントの業務は準備中で、カードに使う業務のない職種はその 2 つと職種の決まっていない 3 つだけ` — `insurance-sales`、`career-consultant`、`planning-unassigned`、`logistics-unassigned`、`service-unassigned`
  - `options-9（業務マスターの形を守る）: いまの 12 業務の id は残り、カードに使う業務で、職種も前と同じ` — 上の Global Constraints の 12 の id と 3 職種
  - `options-9（業務マスターの形を守る）: 業務の力は辞書にある力で、主な力と補助の力が重ならず、補助の力は 3 つまで`
  - `options-9（業務マスターの形を守る）: 業務の名前、中身、知識や道具、活用場面、小さな試し方は決めた長さまで`
  - `common-1（使わない言葉を出さない）: 登録データの言葉に、使わない言葉、言い切りと順位の言葉、大げさな褒め言葉、お金の額がない` — 職種の名前と説明、業務の名前、中身、活用場面、知識や道具、小さな試し方、確かめる条件。`ForbiddenWordList`、`OptionsValidator.AssertiveIn`、`PraiseIn`、`HasMoneyAmount` を使う
  - `deepen-3（最初の一歩は小さく）: 小さな試し方は、一歩で落とす言葉（応募、契約、購入など）を含まない` — `DeepenValidator.PushyStepWords`
  - いまの出典のテストと `ForbiddenWordsIgnoreAbilityNames` はそのまま
  - `options-9（業務マスターの形を守る）: 正しい小さいデータは読め、準備中の力を持つ業務と、業務がすべて準備中の職種（job tag あり・なし）も読める`
  - `options-9（業務マスターの形を守る）: 壊れたデータは読み込みで止める`（Theory。いまの行に足す: 主な力と補助の力の重なり、補助の力 4 つ、知らない領域、知らない状態 `"draft"`、id `"T01-001"`、job tag のない職種の `active` の業務、`active` で `jobtagTasks` が空、空の活用場面。いまの「辞書にない力 `cooking`」「古い id `coordinating`」も主な力で残す）
  - `OptionsValidatorTests`
    - `options-2（選ぶは登録した職種から）: 選ぶの力は、業務の主な力でも補助の力でもよく、どちらでもない力なら落とす` — `online-secretary-schedule` に利害調整力（補助）は通り、共感力は `abilityNotInTasks`
    - `options-3（組み合わせるは登録した業務から）: 組み合わせるの力は、業務のどれかの主な力か補助の力`
    - `options-2（選ぶは登録した職種から）: 準備中の業務の id は、渡していない ID として落とす` — `insurance-sales` と `insurance-sales-hearing` は `unknownId`
    - `options-8（理由は本人の言葉とつなぐ）: 業務の準備中の力（原因分析力）は、カードの力にできない` — `abilityNotUsable`
  - `OptionsApiTests`: `options-2（選ぶは登録した職種から）: 前に保存したカードの業務が準備中なら、そのカードは出さず、選んだ案の中身は残す`（`insurance-sales-hearing` の「選ぶ」を置いてから `GET /api/options`）
  - `DeepenValidatorTests`: `deepen-6（仮の場面での考え方を聞く）: 問いの力は、選んだ案の業務の主な力か補助の力のうち、話から確かめる力` — `online-secretary-schedule` の利害調整力（補助）は通り、`planning-cause-hypothesis` の原因分析力（主、準備中）は落とす
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~JobCatalogTests|FullyQualifiedName~OptionsValidatorTests|FullyQualifiedName~DeepenValidatorTests"`
- [x] **Step 3: jobs.json を作る** — `.tmp/task-master/jobs-draft.json` を読み、上の「下書きから変えること」の 2（時給）と 3（準備中）と、出典の `note` だけを変えて `src/Revalue.Server/Features/Options/jobs.json` に書く（`node -e` で。字下げ 2、末尾に改行）。書いたあと `node -e` で、領域 10、職種 30、業務 125、`active` 115、`active` の時給の下限が 1,300 以上、22 の力それぞれ `active` の業務が 2 つ以上を確かめる
- [x] **Step 4: 写しと job tag の番号を確かめる** — `.tmp/task-master/jobs-check.py` を `.tmp/task-master/jobs-check-repo.py` に写し、読むファイルを `src/Revalue.Server/Features/Options/jobs.json` と `.tmp/jobtag/utf8/numeric.csv` に変える（協力者の表のパスはそのまま）。リポジトリの根で `PYTHONIOENCODING=utf-8 python .tmp/task-master/jobs-check-repo.py` を回す。期待: `jobtag check problems: 0`。`collab:` が空でない行は「固定資産台帳の更新」の 1 行だけ（`jobtag:` だけの重なりは「商品やサービスの」のような言い回しで、写しではない）。どちらも git が無視する置き場所なのでコミットしない
- [x] **Step 5: `JobCatalog` を広げ、業務の力を使う所を `Uses` と `ActiveAbilities` に直す**。`JobTask.Ability` を消し、`git grep -n "\.Ability\b" src/Revalue.Server/Features/Options src/Revalue.Server/Features/Deepen src/Revalue.Server/Ai` で、業務の力として読んでいる所が残っていないことを見る（カードと根拠の `Ability` は別物なので残る）
- [x] **Step 6: すべてのテストを通す** — `dotnet test`。データの数、並び（職種は経理事務から始まる）、名前を変えた 6 業務（`online-secretary-schedule` 会議や面会の日程調整、`accounting-check` 帳簿と口座の照合、`accounting-invoice` 請求書の発行、`accounting-monthly` 月の締めの進行管理、`recruiting-posting` 求人票の作成、`recruiting-applications` 応募の受付と書類の確認）、業務の主な力、時給の下限で期待が変わったテストは、それだけが理由かを確かめ、コミットメッセージの本文に書く。`dotnet run --project evals/Revalue.Evals -- --unit options --dry-run` と `--unit deepen --dry-run` が流れる
- [x] **Step 7: Spec、PRD、決めたことを書く**
  - `05-options.md` の「登録した職種と業務」: 置き場所。業務マスター（10 の領域、職種、業務）で、協力者のインタビューをもとに Claude が書き起こしたこと。職種は job tag の職業の番号と名前、業務はタスクの番号を持つこと。業務ごとの値（使う力 = 主な力と補助の力、力が生きる場面、週の時間、時間帯、場所、時給の目安、要る知識や道具、小さな試し方、本人に確かめる条件、状態）。カードに使うのは `active` の業務だけで、`active` にはどの値がそろっていること。業務が力に「つながる」とは、主な力か補助の力のうち話から確かめる力にその力があること。業務の力に準備中の力が入っていてもよいが、カードの力にはならないこと。時給の目安の下限は 1,300 円以上（最低賃金を下回らないため）。読み込みで止めるもの（上の Interfaces）。options-9 の基準: `9. options-9（業務マスターの形を守る）: 業務マスターの形が崩れていれば起動で止める。登録データでは、話から確かめる力それぞれに、カードに使う業務が 2 つ以上つながり、カードに使う業務の時給の目安の下限は 1,300 円以上で、小さな試し方に一歩で落とす言葉がない。確かめ方: 単体テスト（一つの処理だけを取り出して確かめるテスト）`
  - `docs/prd/5-information.md`: 上の Files の 3 行
  - `docs/decisions/2026-11-05-task-master.md`: 見出しは「# 業務マスターの値と範囲」、日付の行、「## 決めたこと」の表（決めたこと | 決めた人 | 外した案 | 理由）、「## まだ分かっていないこと」。表の行は、active にした範囲（10 領域で job tag の職業とタスクが見つかった業務。外した案は 5 領域だけ。理由はメモの「active と preparing」）、まとめた 7 業務と id を残したこと（理由は公開中の保存データ）、時給の下限 1,300 円、保険の営業とキャリアコンサルタントを準備中、業務のデジタル化の支援を active のまま（開発者に確かめる）、主な力と補助の力をどちらもつながりに数える（設計の点検）、AI に渡す候補を使える力につながる業務に絞る（上の「AI に渡す候補」）、活用場面・小さな試し方・確かめる条件の使い道（上の表）、`web-marketing-ad-results` を active のまま置く。「まだ分かっていないこと」は、needsReview の 87 業務の力（協力者に確かめる）、時給の目安の出典、業務のデジタル化の支援が短い時間から始められるか
- [x] **Step 8: コミット**（「業務マスター: jobs.json を 125 業務にし、業務の力を主な力と補助の力にする（options-9（業務マスターの形を守る）、options-2（選ぶは登録した職種から））」）

### Task 2: 仕事の選択肢の候補を絞り、AI に業務の力と活用場面を渡し、カードに活用場面を添える

**Files:**
- Modify: `src/Revalue.Server/Features/Options/OptionCandidates.cs`（AI に渡す候補を、使える力につながる業務だけにする）
- Modify: `src/Revalue.Server/Ai/ClaudeOptionsAi.cs`（`Brief` の業務の行）
- Modify: `src/Revalue.Server/Ai/Prompts/options.md`（「使う力」を「主な力と補助の力」に。活用場面の使い方）
- Modify: `src/Revalue.Server/Features/Options/OptionsEndpoints.cs`（`CardTaskDto` に `Scene`）
- Modify: `evals/Revalue.Evals/OptionsEval.cs`（登録していない職種の数え方で、準備中の業務を登録にないものとして数える。`FindActiveTask` を使う）、`evals/Revalue.Evals/OptionsReport.cs`（案ごとに「AI に渡した業務の数」を参考に書く）
- Modify: `evals/criteria.md`（05 options の「登録していない職種」の行に、準備中の業務の id を足す）
- Modify: `docs/specs/05-options.md`（下の Step 5）
- Test: `OptionCandidatesTests.cs`（新規）、`ClaudeOptionsAiTests.cs`、`OptionsApiTests.cs`、`OptionsEvalTests.cs`

**Interfaces:**
- Consumes: Task 1 の `JobCatalog.ActiveTasks`、`JobTask.Uses`、`ActiveAbilities`、`Abilities.Main`、`Scene`、`FindTask`、`FindActiveTask`
- Produces: `OptionCandidates.From(catalog, inputs)` の決め方（Claude の判断）
  - 条件に合う `active` の業務がなければ、どちらも `NoFit`
  - 条件に合う業務のうち、使える力のどれかに `Uses` でつながる業務だけを `Tasks` と `Occupations` に入れる。それが 0 なら「選ぶ」は `NoAbilityMatch`
  - 「組み合わせる」は、条件に合う業務で 2 つの職種にまたがる組（`CombineFits`）がなければ `NoFit`、つながる業務だけでそういう組がなければ `NoAbilityMatch`
- Produces: `CardTaskDto(string Id, string OccupationName, string Name, string Detail, string? Ability, IReadOnlyList<TimeSlot> TimeSlots, TaskPlace Place, string? Scene)` — `Scene` は、カードの理由と力を出すとき（`ShowsReason`）で、業務マスターの業務（`FindTask(TaskId)`）の主な力がカードの力と同じときだけ、その業務の活用場面。ほかは null
- `Brief` の業務の行（Claude の判断。この順）:

```
- 業務 id: <id>
  名前: <name>
  中身: <detail>
  主な力: <key>（<名前>）          ← 主な力が話から確かめる力のときだけ
  補助の力: <key>（<名前>）、…      ← 補助の力のうち話から確かめる力があるときだけ
  力が生きる場面: <scene>          ← 主な力が話から確かめる力のときだけ
  週あたりの時間: …（いまのまま）
```

- `options.md` に書くこと: `ability` は `taskIds` の業務のどれかの「主な力」か「補助の力」と同じにする（2 か所）。「力が生きる場面」は、主な力が業務のどこで生きるかの手がかりで、理由に、本人がしたことがその業務のどこに生かせそうかを書くときに使ってよい。場面の文をそのまま写さず、主な力でない力のカードでは使わない。言葉は voice-reviewer が点検する

- [x] **Step 1: 失敗するテストを書く**
  - 候補（小さい JSON の業務マスターで作る）
    - `options-2（選ぶは登録した職種から）: AI に渡す候補は、条件に合い、使える力のどれかにつながる業務だけで、準備中の業務を含まない`
    - `options-2（選ぶは登録した職種から）: 条件に合う業務はあるが、どれも使える力につながらなければ、選ぶは noAbilityMatch`
    - `options-3（組み合わせるは登録した業務から）: 使える力につながる業務が 1 つの職種にしかなければ、組み合わせるは noAbilityMatch で、条件に合う組がなければ noFit`
    - `options-2（選ぶは登録した職種から）: 補助の力だけでつながる業務も候補に入る`
  - `ClaudeOptionsAiTests`
    - `options-10（力が生きる場面を添える）: AI に渡す業務には、話から確かめる主な力と補助の力と、力が生きる場面を書き、準備中の力を書かない` — `planning-cause-hypothesis` の行に原因分析力と仮説思考力がなく、違和感察知力だけが補助の力にあり、活用場面の行がない
    - `options-2（選ぶは登録した職種から）: 仕事の選択肢の指示は、カードの力を業務の主な力か補助の力から選ぶよう書く`（`options.md` に「主な力」「補助の力」「力が生きる場面」がある）
  - `OptionsApiTests`
    - `options-10（力が生きる場面を添える）: カードの業務のうち、使った力を主な力に持つ業務にだけ、力が生きる場面を添える` — 偽物の AI が補助の力で作ったカードの業務には添えない
    - `options-10（力が生きる場面を添える）: 選んだ案の力を外したときと、記録と合わなくなったときは、力が生きる場面も出さない`（validate-12（本人が見立てを外せる）の確かめも兼ねる）
  - `OptionsEvalTests`: `options-2（選ぶは登録した職種から）: 評価は、準備中の業務の id を返したカードを、登録していない職種として数える`
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~Options"`
- [x] **Step 3: 候補、`Brief`、`options.md`、`CardTaskDto`、評価の数え方を直す**
- [x] **Step 4: 確かめる** — `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit options --dry-run`（結果のファイルに AI に渡した業務の数が出る）
- [x] **Step 5: Spec を直す**（`05-options.md`）
  - 「AI が書いた中身をコードで確かめる」の冒頭: AI に渡すのは、条件に合い、本人の使える力のどれかにつながる `active` の業務と、その職種だけ（理由は上の「AI に渡す候補」を 1 文で）。業務ごとに、話から確かめる主な力と補助の力、力が生きる場面を渡す
  - 「3 枚のカード」の表の「組み合わせる」: どの業務も、使える力のどれかにつながる
  - 「画面」のカードの中身に、使った力を主な力に持つ業務の力が生きる場面を足す（理由と力を出さないときは出さない）
  - 受け入れ基準: options-3 に「どの業務も、使える力のどれかにつながる」を足す。`10. options-10（力が生きる場面を添える）: 「選ぶ」と「組み合わせる」のカードと選んだ案で、使った力を主な力に持つ業務に、その力が業務のどこで生きるか（力が生きる場面）を添える。理由と力を出さないときは添えない。確かめ方: 単体テスト、結合テスト（裏側を丸ごと立ち上げて API を呼ぶテスト）、画面のテスト`
- [x] **Step 6: コミット**（「業務マスター: 仕事の選択肢の候補を使える力につながる業務に絞り、カードに力が生きる場面を添える（options-2（選ぶは登録した職種から）、options-3（組み合わせるは登録した業務から）、options-10（力が生きる場面を添える））」）

# まとまり B: 選んだ案を深める、可能性レポート（heavy）

### Task 3: 深めるで、業務の力をすべて照らし、活用場面と確かめる条件を出し、小さな試し方を AI に渡す

**Files:**
- Modify: `src/Revalue.Server/Features/Deepen/DeepenLighting.cs`（`TaskLight` を広げる）
- Modify: `src/Revalue.Server/Features/Deepen/DeepenEndpoints.cs`（`TaskLightDto`、`UsableDto`）
- Modify: `src/Revalue.Server/Ai/ClaudeDeepenAi.cs`（`Brief` の登録の業務の行）
- Modify: `src/Revalue.Server/Ai/Prompts/deepen.md`（業務の「使う力」を主な力と補助の力に。一歩の候補で小さな試し方の例を手がかりにしてよいこと）
- Modify: `src/Revalue.Server/Features/Report/ReportBuilder.cs`（`TaskLight` の形が変わるので、`NotYet` を `MainUsable` で読むようにしてコンパイルを通すだけ。中身は Task 4）
- Modify: `docs/specs/06-deepen.md`（下の Step 5）
- Test: `DeepenLightingTests.cs`、`DeepenApiTests.cs`、`ClaudeDeepenAiTests.cs`

**Interfaces:**
- Consumes: Task 1 の `JobTask.ActiveAbilities`、`Abilities.Main`、`Scene`、`Trial`、`Checks`
- Produces:

```csharp
/// Ability は登録の業務なら主な力、見立ての業務ならその力。Usable は業務の力のうち本人の使える力（主な力、補助の力の順。見立ての業務は 0〜1 つ）。
/// Scene は、登録の業務で主な力が使える力のときだけ。Checks は登録の業務の確かめる条件（見立ての業務は空）。
public sealed record TaskLight(
    string? Id, string Name, string Detail, Ability Ability, IReadOnlyList<UsableAbility> Usable, string? Scene,
    IReadOnlyList<string> Checks, IReadOnlyList<string> Knowledge, bool Drafted)
{
    public bool MainUsable { get; } // Usable に Ability がある
}

public sealed record UsableDto(string Key, string Name, AbilityState State, IReadOnlyList<QuoteDto> Quotes);
public sealed record TaskLightDto(
    string? Id, string Name, string Detail, string? Ability, string? AbilityName, IReadOnlyList<UsableDto> Usable,
    string? Scene, IReadOnlyList<string> Checks, IReadOnlyList<string> Knowledge, bool Drafted);
```

- `TaskLightDto.Ability` と `AbilityName` は、`Ability` が話から確かめる力のときだけ（準備中の力と辞書から消えた力は null。いまの古い id の扱いと同じ）。画面は、`Ability` があり `Usable` にその力がないときだけ「この業務で使う○○は、まだ確かめていません」を出す。補助の力の「まだ確かめていない」は並べない（採点表に見えないため。Claude の判断）
- `Usable` は `inputs.Abilities`（見せた力で、外していない力）から引くので、外した力と画面に出さない力は補助の力でも入らない
- `Brief` の登録の業務の行（Claude の判断。この順）: 名前、中身、使う力（話から確かめる主な力と補助の力を「key（名前）」で「、」につなぐ。なければ行を書かない）、要る知識や道具、`小さな試し方の例: <trial>`
- `deepen.md` に書くこと: 問いの `ability` は `<target>` の業務の「使う力」のどれか（主な力でも補助の力でもよい）。一歩の候補は、`<target>` の業務の「小さな試し方の例」を手がかりにしてよい。そのまま使ってもよいが、時間と場所の決まりと、勧める言い方をしない決まりはいつも守る。言葉は voice-reviewer が点検する

- [x] **Step 1: 失敗するテストを書く**
  - `DeepenLightingTests`（いまの 12〜37 行目の 3 つは、新しい形で通す）
    - `deepen-2（業務ごとに照らす）: 登録した業務は、主な力と補助の力のうち使える力をすべて、主な力から順に、根拠の言葉と示す`
    - `deepen-2（業務ごとに照らす）: 主な力が使える力でなければ、主な力だけをまだ確かめていない力として示し、補助の力は並べない`
    - `deepen-2（業務ごとに照らす）: 主な力が準備中の業務は、まだ確かめていない力の名前を出さず、使える補助の力は示す`（`planning-cause-hypothesis` と違和感察知力）
    - `deepen-2（業務ごとに照らす）: 主な力が使える力のときだけ、力が生きる場面を添える`
    - `deepen-2（業務ごとに照らす）: 登録した業務には本人に確かめる条件を並べ、AI の見立ての業務には並べない`
    - `validate-12（本人が見立てを外せる）: 外した力と画面に出さない力は、業務の補助の力でも使えるところに出さず、力が生きる場面も添えない`
  - `DeepenApiTests`: いまの `schedule.GetProperty("ability")` の確かめを新しい形で通し、`deepen-2（業務ごとに照らす）: GET /api/deepen の業務は、使える力を名前と状態と根拠の言葉の一覧で、力が生きる場面と確かめる条件と一緒に返す` を足す
  - `ClaudeDeepenAiTests`
    - `deepen-3（最初の一歩は小さく）: 登録した業務の小さな試し方を、一歩の手がかりとして AI に渡す`
    - `deepen-6（仮の場面での考え方を聞く）: 登録した業務の使う力は、話から確かめる主な力と補助の力を渡し、準備中の力を渡さない`
- [x] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~Deepen"`
- [x] **Step 3: `DeepenLighting`、DTO、`Brief`、`deepen.md` を直す**
- [x] **Step 4: 確かめる** — `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit deepen --dry-run`
- [x] **Step 5: Spec を直す**（`06-deepen.md`）
  - 「業務ごとに照らす」: 使えるところは、業務の使う力（主な力と補助の力のうち話から確かめる力）のうち本人の使える力すべてを、主な力から順に示す。主な力が使える力なら、力が生きる場面を添える。まだ確かめていないことは、主な力が使える力でなければその名前（準備中の力は名前を出さない）、要る知識や道具、本人に確かめる条件（「確かめておきたいこと（…）」の一行。力の確かめには使わない）
  - 「最初の一歩」: 選んだ案が「選ぶ」「組み合わせる」なら、登録の業務の小さな試し方を、AI に一歩の手がかりとして渡す
  - 「AI が書いた中身をコードで確かめる」の「問いの力が、選んだ案の業務の「使う力」のどれでもない」を、主な力と補助の力のうち話から確かめる力に
  - 受け入れ基準: deepen-2 に「使える力は主な力と補助の力のすべて、力が生きる場面と本人に確かめる条件」を足す。deepen-3 に「登録した業務なら、小さな試し方を手がかりとして AI に渡す」を足す
- [x] **Step 6: コミット**（「業務マスター: 深めるで業務の力をすべて照らし、力が生きる場面と確かめる条件を示し、小さな試し方を一歩の手がかりにする（deepen-2（業務ごとに照らす）、deepen-3（最初の一歩は小さく））」）

### Task 4: レポートに、選んだ案の活用場面と、業務の確かめる条件を出す

**Files:**
- Modify: `src/Revalue.Server/Features/Report/ReportContent.cs`（`ReportTaskGap` と `ReportChoice`）
- Modify: `src/Revalue.Server/Features/Report/ReportBuilder.cs`（`NotYet` は Task 3 の `TaskLight` で組み立てる。選んだ案の活用場面。版の中身）
- Modify: `src/Revalue.Server/Features/Report/ReportEndpoints.cs`（DTO）
- Modify: `docs/specs/07-report.md`（下の Step 5）
- Test: `ReportBuilderTests.cs`、`ReportApiTests.cs`

**Interfaces:**
- Consumes: Task 3 の `TaskLight`（`Ability`、`MainUsable`、`Checks`、`Knowledge`）、Task 1 の `JobCatalog.FindTask`
- Produces:
  - `ReportTaskGap(string TaskName, Ability? Ability, IReadOnlyList<string> Knowledge, IReadOnlyList<string> Checks)` — `Ability` は、主な力が話から確かめる力で、使える力でなく、本人が外してもいないとき。外していれば、いまのとおり `HasExcluded`。力、知識や道具、確かめる条件のどれかがある業務だけを入れる
  - `public sealed record ReportScene(string TaskName, string Scene);`、`ReportChoice` の最後に `IReadOnlyList<ReportScene> Scenes` — 理由と力を出すとき（`problem is null`）の「選ぶ」「組み合わせる」で、カードの業務（`CardTask`）のうち、業務マスターの主な力がカードの力と同じ業務の活用場面。業務の名前はカードの写しの名前
  - `ReportTaskGapDto(string TaskName, string? AbilityName, IReadOnlyList<string> Knowledge, IReadOnlyList<string> Checks)`、`ReportChoiceDto` に `IReadOnlyList<ReportSceneDto> Scenes`（`ReportSceneDto(string TaskName, string Scene)`）
  - 版の中身: 選んだ案の `Scenes` は残さない（理由と同じ扱い）。まだ確かめていないことの業務には、知識や道具と確かめる条件を残す

- [ ] **Step 1: 失敗するテストを書く**
  - `report-1（一つにまとめて示す）: まだ確かめていないことに、選んだ案の業務の本人に確かめる条件を並べる`
  - `report-1（一つにまとめて示す）: 選んだ案の業務の主な力が準備中なら、まだ確かめていない力に名前を出さない`
  - `report-1（一つにまとめて示す）: 選んだ案の理由と力を出すときは、使った力を主な力に持つ業務の力が生きる場面を添え、外したときは添えない`（validate-12（本人が見立てを外せる）も兼ねる）
  - `report-3（版を残す）: 前の版には、業務の確かめる条件を残し、力が生きる場面を残さない`
- [ ] **Step 2: テストが失敗することを確かめる** — `dotnet test --filter "FullyQualifiedName~Report"`
- [ ] **Step 3: 直す**。`JobTask.Ability` のような単数の業務の力が残っていないことを `git grep -n "light.Ability\|task.Ability\|t.Ability" src/Revalue.Server` で見る（`TaskLight.Ability` を主な力として読む所はよい）
- [ ] **Step 4: 確かめる** — `dotnet test`
- [ ] **Step 5: Spec を直す**（`07-report.md`）: 「まとめる中身」の表の「まだ確かめていないこと」に、業務の本人に確かめる条件を足し、業務で使う力のうちまだ確かめていない力を「主な力」に。「選んだ案」に、理由と力を出すときは使った力を主な力に持つ業務の力が生きる場面を添えると足す。「版を残す」の「まだ確かめていないことの欄は、業務に要る知識や道具だけ」を「知識や道具と、本人に確かめる条件だけ」に、理由と同じく力が生きる場面も前の版に出さないと足す。report-1 の基準に、選んだ案の力が生きる場面と、業務の本人に確かめる条件を足す
- [ ] **Step 6: コミット**（「業務マスター: レポートに選んだ案の力が生きる場面と、業務の確かめる条件を出す（report-1（一つにまとめて示す）、report-3（版を残す））」）

# まとまり C: 画面、保存データ、評価、文書

### Task 5: 画面に、活用場面、業務の使える力の一覧、確かめる条件を出す

**Files:**
- Modify: `src/web/src/api.ts`（`CardTask.scene`、`DeepenTask` の `usable` を一覧に、`scene`、`checks`、`ReportTaskGap.checks`、`ReportChoice.scenes`、`ReportSnapshotNotYet` の業務に `checks`）
- Modify: `src/web/src/pages/Options.tsx`（カードと選んだ案の業務の下に活用場面）
- Modify: `src/web/src/pages/Deepen.tsx`（使える力を力ごとに名前と状態と根拠の言葉で並べる。主な力が使える力なら活用場面。まだ確かめていないことに確かめる条件の行。登録の業務は `ability` が null でも直す欄を開かない）
- Modify: `src/web/src/pages/Report.tsx`（選んだ案の活用場面、まだ確かめていないことの確かめる条件、前の版の確かめる条件）
- Modify: `src/web/src/copy.ts`（下の文）
- Modify: `src/web/src/test/fake-api.ts` と画面のテスト（偽のデータを新しい形に。業務の名前は架空のデータのままでよい）
- Modify: `docs/specs/05-options.md`、`06-deepen.md`、`07-report.md` の「画面」の箇条（下の Step 4）
- Test: `Options.test.tsx`、`Deepen.test.tsx`、`Report.test.tsx`、`copy.test.ts`

**Interfaces:**
- Consumes: Task 2 の `CardTaskDto.Scene`、Task 3 の `TaskLightDto`、Task 4 の `ReportTaskGapDto.Checks`、`ReportChoiceDto.Scenes`
- copy.ts に足す文（Claude の判断。voice-reviewer が点検し、開発者が確かめる）
  - `options.sceneLine: '力が生きる場面: {scene}'`
  - `deepen.sceneLine: '力が生きる場面: {scene}'`
  - `deepen.checksLine: '確かめておきたいこと（{items}）'`（`knowledgeLine` と同じ形。項目は「、」でつなぐ）
  - `report.sceneLine: '{task}: {scene}'`（見出し `report.sceneTitle: '力が生きる場面'`）
  - `report.taskChecks: '{task}: 確かめておきたいこと（{items}）'`

- [ ] **Step 1: 失敗するテストを書く**
  - `Options.test.tsx`: `options-10（力が生きる場面を添える）: カードと選んだ案の業務に力が生きる場面が来たら、その業務の下に添え、来なければ出さない`
  - `Deepen.test.tsx`
    - `deepen-2（業務ごとに照らす）: 使える力をすべて、それぞれ名前と本人の言葉で出し、主な力が使える力なら力が生きる場面を添える`
    - `deepen-2（業務ごとに照らす）: 本人に確かめる条件を、まだ確かめていないことの一行で出す`
    - `deepen-2（業務ごとに照らす）: 登録した業務の力の名前がなくても、まだ確かめていないの行も直す欄も出さない`
  - `Report.test.tsx`: `report-1（一つにまとめて示す）: 選んだ案に力が生きる場面を、まだ確かめていないことに本人に確かめる条件を出す`。前の版の確かめる条件も出す（`report-3（版を残す）`）
  - `copy.test.ts`: 足した文に使わない言葉がない（いまの common-1（使わない言葉を出さない）のテストが拾う）
- [ ] **Step 2: テストが失敗することを確かめる** — `npm --prefix src/web test`
- [ ] **Step 3: 画面を直す**
- [ ] **Step 4: Spec の「画面」を直す** — 05: カードに出すものに「使った力を主な力に持つ業務の力が生きる場面」。06: 業務ごとの「まだ確かめていないこと」の一行に確かめる条件、使えるところに使える力の一覧と力が生きる場面。07: 選んだ案の欄の力が生きる場面と、まだ確かめていないことの確かめる条件の一行
- [ ] **Step 5: 確かめる** — `npm --prefix src/web run build`、`npm --prefix src/web test`。`git grep -nP "(online-secretary|accounting|recruiting)-[a-z-]+" -- src/web/src ':!*.test.*' ':!src/web/src/test'` が 0 件（画面のコードに業務の id がない）
- [ ] **Step 6: コミット**（「業務マスター: 画面に力が生きる場面、業務の使える力の一覧、確かめる条件を出す（options-10（力が生きる場面を添える）、deepen-2（業務ごとに照らす）、report-1（一つにまとめて示す））」）

### Task 6: 前の保存データを確かめ、評価のデータと文書を業務マスターに合わせる

**Files:**
- Create: `tests/Revalue.Server.Tests/SavedTaskDataTests.cs`
- Modify: `evals/deepen/d01-online-secretary.json`、`d05-accounting-out.json`（`title` の業務の名前を、いまの名前に。d01「選ぶ: オンライン秘書（会議や面会の日程調整、出張や会食の手配）」、d05「選ぶ: 経理事務（月の締めの進行管理、手元の現金の管理。外に出る業務を含む）」。id は変えない。d02 は名前の変わった業務がないのでそのまま）
- Modify: `evals/Revalue.Evals/DeepenCase.cs`（選んだ案の業務は `FindActiveTask` で引き、準備中なら「登録にないか、準備中の業務 {id} です。」で読めない）
- Modify: `evals/criteria.md`（06 deepen の「選んだ案の書き方」の「職種と業務の id は登録（`jobs.json`）にあるものだけ」に「カードに使う（active）業務だけ」を足す）
- Modify: `docs/specs/00-common.md`（「力」に 1 項目足す: 業務マスターの業務の使う力（主な力と補助の力）には準備中の力が入っていてもよい。業務が力に「つながる」のは話から確かめる力だけで、カード、深める、レポートで力として示し理由に使うのは見せた力だけ（[05-options.md](05-options.md) の「登録した職種と業務」）
- Modify: `README.md`（116 行目付近の「登録した職種と業務のデータ」の段落を、業務マスター（10 の領域、30 の職種、125 の業務。カードに使うのは 115）に。協力者へのインタビューをもとに Claude が書き起こし、job tag のダウンロードデータの職業とタスクの番号を持つこと。使う力、時給の目安などは Claude の下書きで、時給の目安の下限は最低賃金を下回らないよう 1,300 円以上にそろえたこと。評価の数字（88 行目付近）は変えない）
- Test: `SavedTaskDataTests.cs`、`DeepenEvalTests.cs`

**Interfaces:**
- Consumes: Task 1〜4 のすべて。保存データは、データの置き場に直接置いてから API を呼ぶ（`LegacyAbilityDataTests.cs` と同じやり方）

- [ ] **Step 1: 失敗するテスト（か、通ることを確かめるテスト）を書く**（`SavedTaskDataTests.cs`。置くものは、いまの 12 業務の id と前の名前「日程の調整」「月の締めの手伝い」を持つ「選ぶ」と「組み合わせる」のカード、その「選ぶ」を選んだ案、その案で深めた中身（前の `Basis` のまま）、レポートの版 1 つ）
  - `options-8（理由は本人の言葉とつなぐ）: 業務マスターに置き換える前に保存したカードと選んだ案は、写しの名前のまま出し、時間帯と収入はいまの業務マスターの値で計算し直す` — `GET /api/options` が 200。収入の目安は時給の下限 1,300 円で計算した値
  - `deepen-2（業務ごとに照らす）: 前に選んだ案の業務は、いまの業務マスターの名前と力で照らし、深めた中身を作り直さない` — `GET /api/deepen` が 200 で、`stale` が false、業務の名前は「会議や面会の日程調整」
  - `report-3（版を残す）: 前の版を持つ人のレポートは開け、前の版はそのまま残る` — `GET /api/report` が 200、前の版の数が減らない
  - `DeepenEvalTests`: `deepen-2（業務ごとに照らす）: 評価の選んだ案は、カードに使う業務だけを読み、準備中の業務なら読めない`。リポジトリの d01〜d07 がすべて読める
- [ ] **Step 2: テストを回す** — `dotnet test --filter "FullyQualifiedName~SavedTaskDataTests|FullyQualifiedName~DeepenEvalTests"`。通らなければ、superpowers:systematic-debugging で原因を調べてから直す（直す所は Task 1〜4 のコード）
- [ ] **Step 3: 評価のデータ、criteria.md、00-common.md、README.md を直す**
- [ ] **Step 4: 確かめる**
  - `dotnet test`、`dotnet run --project evals/Revalue.Evals -- --unit options --dry-run`、`--unit deepen --dry-run`
  - `git grep -n "3 職種\|職種ごとに業務が 4\|オンライン秘書、経理事務、採用事務の" -- docs/specs docs/prd README.md src tests evals ':!evals/results'` が 0 件
  - `git grep -n "日程の調整\|月の締めの手伝い\|帳簿の見直し\|請求と入金の確認\|求人の準備\|応募の受付と整理" -- evals ':!evals/results' ':!evals/personas/how-to-judge.md'` が 0 件（保存データのテストの値は tests の中なので当たらない。how-to-judge.md の「カードの見込み」は手順 5 で書き直す）
  - Task 1 の Step 4 の写しの確かめを回し直し、同じ結果になる
- [ ] **Step 5: コミット**（「業務マスター: 前の保存データを確かめ、評価のデータと文書を業務マスターに合わせる（options-8（理由は本人の言葉とつなぐ）、deepen-2（業務ごとに照らす）、report-3（版を残す））」）

## 確認コマンド

1. `dotnet build`（警告 0）、`dotnet test` — すべて PASS
2. `npm --prefix src/web ci`、`npm --prefix src/web run build`、`npm --prefix src/web test` — すべて PASS
3. `node --test .claude/hooks/guard.test.mjs` — PASS
4. `dotnet run --project evals/Revalue.Evals -- --unit discover --dry-run`、`--unit validate --dry-run`、`--unit options --dry-run`、`--unit deepen --dry-run` — 最後まで流れる

## Workflow のあと（メインのセッション）

1. 本物の AI で `dotnet run --project evals/Revalue.Evals -- --unit options` と `--unit deepen` を回し、結果を `evals/results/<日付>-options.md`、`<日付>-deepen.md` に残す。合格の線は `6-quality.md` のまま（登録していない職種 0 件、条件を超える案 0 件、言い切りと順位 0 件など）
2. 11/5 の結果（`evals/results/2026-11-05-options.md`、`2026-11-05-deepen.md`）と、入力トークン数と返事の時間を比べる。AI に渡す業務が増えたため。目に見えて増えていれば、候補の渡し方（業務の数の上限など）を次の手順で考える
3. 通らなければ、原因を `options.md`、`deepen.md` か業務マスターのデータに分けて直す。2 回直しても通らなければ保留にする
4. `README.md` の評価の数字を、新しい結果に直す。`docs/superpowers/progress.md` を直し、「開発者に確認してほしいこと」に足す: 時給の下限 1,300 円、保険の営業とキャリアコンサルタントを準備中にしたこと、業務のデジタル化の支援を active のままにしたこと、needsReview の 87 業務の力（協力者に）、AI に渡す候補を使える力につながる業務に絞ったこと（「組み合わせる」の決まりが変わる）、活用場面と確かめる条件の見せ方と画面の文、小さな試し方を一歩の手がかりにした指示の文、前に作ったカードは名前の写しが前のまま残ること

---

## この計画で Claude が決めたこと

- 時給の目安の下限を 1,300 円にそろえる。保険の営業とキャリアコンサルタントの業務を準備中にする。業務のデジタル化の支援は active のまま（開発者に確かめる）
- 業務の力は主な力と補助の力をどちらも「つながる」に数え、準備中の力は数えない。読み込みでは準備中の力も辞書にある id として受け付ける
- AI に渡す候補を、使える力につながる業務だけにする（「組み合わせる」は、どの業務も使える力につながる組み合わせになる）
- 活用場面は、主な力に添える（カード、選んだ案、深めるの使えるところ、レポートの選んだ案）。理由と力を出さないときと前の版には出さない
- 小さな試し方は、深めるの AI に一歩の手がかりとして渡すだけにする。確かめる条件は、深めるとレポートの「まだ確かめていないこと」に一行で出し、前の版にも残す
- 深めるとレポートの「まだ確かめていない力」は主な力だけ。補助の力は並べない
- `CardTask` の保存の形は変えず、活用場面は表示のときに業務マスターから引く。前に保存したカードの業務が準備中になっていたら、そのカードは出さない
- 読み込みで「job tag のある職種には active の業務が 1 つ以上」を求めない
- 文の長さの上限（活用場面 80 文字）
- `web-marketing-ad-results`（力がすべて準備中）を active のまま置く
- 画面の文（`力が生きる場面: …`、`確かめておきたいこと（…）`）
