export const meta = {
  name: 'run-plan',
  description: '計画を実装し、確認・レビュー・反証・直し（2 回まで）・Spec の読みやすさの点検まで回す',
  whenToUse: 'run-plan スキルから呼ぶ。args の形はスクリプトの先頭のコメントを参照',
  phases: [
    { title: '実装', detail: 'タスクのまとまりごとに、テストから書いて実装する' },
    { title: '確認', detail: 'ビルド・テスト・評価を実行し、受け入れ基準ごとのテストがあるかを確かめる' },
    { title: 'レビュー', detail: 'Spec と製品の芯に照らして差分を見る' },
    { title: '反証', detail: '確認とレビューが通ったら、「満たしている」という結論を実際に動かして壊しにいく' },
    { title: '直し', detail: '通らなければ 1 段強いモデルで直す（2 回まで）' },
    { title: '文書の点検', detail: '変えた Spec の読みやすさを点検して削る' },
  ],
}

// args の形（run-plan スキルが作る）
// {
//   plan: 'docs/superpowers/plans/2026-11-03-discover.md',
//   specs: ['docs/specs/00-common.md', 'docs/specs/01-discover.md'],
//   branch: 'unit/01-discover',            // main から切って、チェックアウト済み
//   baseBranch: 'main',
//   criteria: ['discover-1（予定が崩れた日を一つ聞く）'],
//   taskGroups: [{ title: 'タスク 1〜3: 対話の API', tasks: ['タスク 1: …'], heavy: false }],  // 3 つまで
//   verify: ['dotnet test', 'npm --prefix src/web run build'],
//   touchesVoice: true,                     // AI が利用者に話す言葉に関わるなら true
// }

const LADDER = [
  { model: 'haiku', effort: 'low' }, // 0
  { model: 'sonnet', effort: 'medium' }, // 1
  { model: 'opus', effort: 'high' }, // 2
  { model: 'opus', effort: 'xhigh' }, // 3
  { model: 'opus', effort: 'max' }, // 4
]

const a = args || {}
for (const k of ['plan', 'branch', 'taskGroups', 'verify']) {
  if (!a[k]) throw new Error(`args.${k} がありません`)
}
const specs = a.specs || []
const criteria = a.criteria || []
const base = a.baseBranch || 'main'

const CONTEXT = [
  `計画: ${a.plan}`,
  `Spec: ${specs.join('、') || '（なし）'}`,
  `ブランチ: ${a.branch}（${base} から切ってある。ほかのブランチに切り替えない）`,
  `受け入れ基準: ${criteria.join('、') || '（計画と Spec を参照）'}`,
  '人に質問しない。決められないことは安全な側に仮に決め、報告に「（Claude の判断）」と書く。',
  'docs/superpowers/progress.md は書き換えない（main でだけメインのセッションが直す）。開発者に確かめてほしいことは、報告に書く。',
].join('\n')

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    commits: { type: 'array', items: { type: 'string' } },
    summary: { type: 'string' },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['done', 'summary'],
}

const VERIFY_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    commands: {
      type: 'array',
      items: {
        type: 'object',
        properties: { command: { type: 'string' }, ok: { type: 'boolean' }, summary: { type: 'string' } },
        required: ['command', 'ok', 'summary'],
      },
    },
    criteriaWithoutTests: { type: 'array', items: { type: 'string' } },
    evalSummary: { type: 'string' },
  },
  required: ['passed', 'commands', 'criteriaWithoutTests'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['must', 'should', 'nit'] },
          where: { type: 'string' },
          problem: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'where', 'problem'],
      },
    },
    forHuman: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'findings'],
}

const REFUTE_SCHEMA = {
  type: 'object',
  properties: {
    pass: { type: 'boolean' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['must', 'should'] },
          where: { type: 'string' },
          problem: { type: 'string' },
          evidence: { type: 'string' },
          fix: { type: 'string' },
        },
        required: ['severity', 'where', 'problem', 'evidence'],
      },
    },
    tried: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'findings', 'tried'],
}

function implPrompt(g) {
  return `${CONTEXT}

計画のうち、次のタスクだけを実装する: ${g.title}
${(g.tasks || []).map((t) => `- ${t}`).join('\n')}

- superpowers:test-driven-development に従い、テストを先に書いて失敗を確かめてから実装する
- 計画の手順・ファイル・コマンドに従う。計画が Spec や製品の芯と食い違っていたら、Spec と芯を優先し、summary に書く
- 振る舞いが Spec と変わったら、同じコミットで Spec も直す（いまの正しい姿だけを書き、経緯は書かない）
- テスト名には受け入れ基準の呼び名を入れる（例: discover-1）
- 終えたタスクは、計画ファイルのチェックボックスを [x] にして同じコミットに含める
- タスクごとに日本語のメッセージでコミットする。呼び名はタイトルとセットで書く`
}

phase('実装')
const impl = []
for (const [i, g] of a.taskGroups.entries()) {
  let r = null
  for (let attempt = 0; attempt < 2 && !r; attempt++) {
    r = g.heavy
      ? await agent(implPrompt(g), { label: `impl:${i + 1} ${g.title}`, phase: '実装', schema: IMPL_SCHEMA, ...LADDER[2] })
      : await agent(implPrompt(g), { label: `impl:${i + 1} ${g.title}`, phase: '実装', schema: IMPL_SCHEMA, ...LADDER[1] })
  }
  impl.push({ title: g.title, ...(r || { done: false, summary: '実装のエージェントが結果を返さなかった' }) })
  if (!r || !r.done) {
    log(`実装が途中で止まった: ${g.title}`)
    break
  }
}
const implDone = impl.length === a.taskGroups.length && impl.every((r) => r.done)

async function verifyOnce(round) {
  const prompt = `${CONTEXT}

次のコマンドを順に実行し、結果を報告する。コードは直さない。評価の結果のファイルができたら、それだけコミットする。
${a.verify.map((c) => `- \`${c}\``).join('\n')}

あわせて、受け入れ基準の呼び名ごとに、テストか評価のケースがあるかを grep で確かめ、ないものを criteriaWithoutTests に挙げる（呼び名はタイトルとセットで）。
passed は、すべてのコマンドが通り、criteriaWithoutTests が空のときだけ true。summary には、失敗したものの出力の要点を短く書く。`
  let v = null
  for (let attempt = 0; attempt < 2 && !v; attempt++) {
    v = await agent(prompt, { label: `verify:${round}`, phase: '確認', schema: VERIFY_SCHEMA, model: 'sonnet', effort: 'high' })
  }
  return v || { passed: false, commands: [], criteriaWithoutTests: [], evalSummary: '確認のエージェントが結果を返さなかった' }
}

async function reviewOnce(round) {
  const codePrompt = `${CONTEXT}

\`git diff ${base}...HEAD\` を読み、次の点でレビューする。ファイルは直さない。
- 計画と Spec の受け入れ基準を満たしているか。Spec と実装が食い違っていないか
- 製品の芯（CLAUDE.md）に反する振る舞いや文言がないか
- 鍵や実在の人の情報が入っていないか。保存するデータが Spec の範囲を超えていないか
- テストが振る舞いを確かめているか（実装をなぞるだけになっていないか）
must は直さないと ${base} に入れられないもの。should と nit は直すとよいもの。pass は must が 0 件のときだけ true。`
  const voicePrompt = `${CONTEXT}

\`git diff ${base}...HEAD\` のうち、AI が利用者に話す言葉（プロンプト、画面の文言、評価の会話記録）を点検する。
pass は must が 0 件のときだけ true。開発者に確かめてほしい言い方は forHuman に、引用と理由をつけて挙げる。`
  let code = null
  let voice = null
  for (let attempt = 0; attempt < 2 && (!code || (a.touchesVoice && !voice)); attempt++) {
    const [c, v] = await parallel([
      () => (code ? Promise.resolve(code) : agent(codePrompt, { label: `review:code ${round}`, phase: 'レビュー', schema: REVIEW_SCHEMA, ...LADDER[2] })),
      () => (!a.touchesVoice || voice
        ? Promise.resolve(voice)
        : agent(voicePrompt, { label: `review:voice ${round}`, phase: 'レビュー', schema: REVIEW_SCHEMA, agentType: 'voice-reviewer', ...LADDER[2] })),
    ])
    code = c
    voice = v
  }
  const missing = { pass: false, findings: [{ severity: 'must', where: '-', problem: 'レビューのエージェントが結果を返さなかった' }] }
  const reviews = [code || missing, ...(a.touchesVoice ? [voice || missing] : [])]
  return {
    pass: reviews.every((r) => r.pass),
    findings: reviews.flatMap((r) => r.findings || []),
    forHuman: reviews.flatMap((r) => r.forHuman || []),
  }
}

// 確認とレビューが通ったときだけ動かす。通っていなければ、直しのあとに改めて動かす
async function refuteOnce(round) {
  if (!(implOk && verify.passed && review.pass)) {
    return { pass: false, skipped: true, findings: [], tried: [] }
  }
  phase('反証')
  const prompt = `${CONTEXT}

確認とレビューは通った。「このブランチは、受け入れ基準と製品の芯（CLAUDE.md）を満たしている」という結論を、壊しにいく。
- \`git diff ${base}...HEAD\` と Spec の受け入れ基準を読み、破れそうなところを選ぶ。特に見るのは、データを消す・残さない・人と結びつけないという約束、鍵と個人情報、利用者の条件や登録したデータの範囲を超える出力、AI の言い方（褒めすぎ、突き放し、本人の代わりに決める）
- 読むだけで終えず、実際に動かして確かめる。テストやコマンドを実行し、要れば使い捨てのテストや入力を作る。使い捨てのものは git の管理外に置くか終わったら消し、最後に \`git status\` がきれいなことを確かめる。コミットしない
- 反例は、再現の手順と、実際に見た出力を evidence に添えたものだけを挙げる。推測や好みは挙げない
- must は、受け入れ基準か製品の芯を実際に破っている反例。should は、破ってはいないが壊れやすいところ
- 試したことは、反例が見つからなかったものも含めて tried に書く
- pass は must が 0 件のときだけ true`
  let r = null
  for (let attempt = 0; attempt < 2 && !r; attempt++) {
    r = await agent(prompt, { label: `refute:${round}`, phase: '反証', schema: REFUTE_SCHEMA, ...LADDER[2] })
  }
  return r || { pass: false, findings: [{ severity: 'must', where: '-', problem: '反証のエージェントが結果を返さなかった', evidence: '-' }], tried: [] }
}

let implOk = implDone
phase('確認')
let verify = await verifyOnce(0)
phase('レビュー')
let review = await reviewOnce(0)
let refute = await refuteOnce(0)

const ok = () => implOk && verify.passed && review.pass && refute.pass
let tier = a.taskGroups.some((g) => g.heavy) ? 2 : 1
let fixes = 0
while (!ok() && fixes < 2) {
  fixes++
  phase('直し')
  const problems = {
    implementation: implOk ? null : impl.filter((r) => !r.done),
    verify: verify.passed ? null : verify,
    review: review.findings.filter((f) => f.severity === 'must' || f.severity === 'should'),
    refute: refute.skipped ? null : refute.findings,
  }
  const fixPrompt = `${CONTEXT}

確認、レビュー、反証で、次の問題が見つかった（原文のまま）。must と、実装が止まった問題、確認の失敗をすべて直す。反証の反例は、再現の手順で直ったことを確かめる。should はできる範囲で直す。
${JSON.stringify(problems, null, 2)}

- superpowers:systematic-debugging で原因を確かめてから直す。テストを弱めたり消したりして通さない
- 実装が途中で止まっていたら、計画の残りのタスク（チェックボックスが [ ] のもの）を終える
- 振る舞いが Spec と変わったら、同じコミットで Spec も直す
- 日本語のメッセージでコミットする`
  const fixed = await agent(fixPrompt, { label: `fix:${fixes}`, phase: '直し', schema: IMPL_SCHEMA, ...LADDER[tier + 1] })
  tier++
  if (fixed) impl.push({ title: `直し ${fixes} 回目`, ...fixed })
  if (fixed && fixed.done) implOk = true
  phase('確認')
  verify = await verifyOnce(fixes)
  phase('レビュー')
  review = await reviewOnce(fixes)
  refute = await refuteOnce(fixes)
}

const passed = ok()

let doc = null
if (passed && specs.length) {
  phase('文書の点検')
  doc = await agent(`${CONTEXT}

このブランチで変えた文書（\`git diff --name-only ${base}...HEAD -- docs/prd/ docs/specs/ README.md\`）の読みやすさを点検する。意味を変えない直しはその場で直し、日本語のメッセージでコミットする。意味が変わる指摘は直さずに返す。`, { label: 'review:doc', phase: '文書の点検', agentType: 'doc-reviewer', ...LADDER[2] })
}

return {
  status: passed ? 'passed' : 'hold',
  fixes,
  impl,
  verify,
  review: { pass: review.pass, findings: review.findings },
  refute: { pass: refute.pass, skipped: !!refute.skipped, findings: refute.findings, tried: refute.tried },
  forHuman: review.forHuman,
  doc,
}
