export const meta = {
  name: 'persona-eval',
  description: '架空の人物を AI に演じさせて手元の RE:VALUE を通し、評価の見方に照らして人ごとの結果とまとめを書く',
  whenToUse: 'persona-eval スキルから呼ぶ。サーバーと画面を動かす道具は、呼ぶ前にスキルが起動しておく。args の形はスクリプトの先頭のコメントを参照',
  phases: [
    { title: '演じる', detail: '人ごとに 1 体。人物ファイルと演じ方だけを読み、画面を動かす' },
    { title: '評価する', detail: '3 人ごとに 1 体。記録の全文と機械の確かめを、評価の見方と PRD に照らす' },
    { title: 'まとめる', detail: '前の回と比べたまとめを書く' },
  ],
}

// args の形（persona-eval スキルが作る）
// {
//   run: '2026-11-05-r1',                       // 回の名前。記録は evals/personas/.run/<run>/<人>/
//   date: '2026-11-05',                         // 結果のファイルの日付
//   people: ['a', 'b', 'c', 'd', 'e', 'f'],     // 回す人（省くと 6 人）
//   previous: 'evals/results/2026-11-04-persona.md',  // 比べる前の回のまとめ（なければ null）
//   commit: '9a477a0',                          // 動かしたコード
// }

const LADDER = [
  { model: 'haiku', effort: 'low' }, // 0
  { model: 'sonnet', effort: 'medium' }, // 1
  { model: 'opus', effort: 'high' }, // 2
  { model: 'opus', effort: 'xhigh' }, // 3
  { model: 'opus', effort: 'max' }, // 4
]

const PERSONAS = {
  a: { file: 'a-madoka', name: 'A まどか' },
  b: { file: 'b-fumi', name: 'B ふみ' },
  c: { file: 'c-kenichi', name: 'C 健一' },
  d: { file: 'd-reina', name: 'D 玲奈' },
  e: { file: 'e-sayaka', name: 'E さやか' },
  f: { file: 'f-rin', name: 'F リン' },
}

const a = args || {}
for (const k of ['run', 'date', 'commit']) {
  if (!a[k]) throw new Error(`args.${k} がありません`)
}
const people = (a.people && a.people.length ? a.people : Object.keys(PERSONAS))
for (const p of people) {
  if (!PERSONAS[p]) throw new Error(`知らない人: ${p}（a〜f）`)
}
const resultDir = `evals/results/${a.date}-persona`

// 3 人ずつの組。組ごとに「演じる 3 体 → 評価する 1 体」を流す（エージェントを 10 体未満に収めるため）
const groups = []
for (let i = 0; i < people.length; i += 3) groups.push(people.slice(i, i + 3))
log(`回 ${a.run}: ${people.map((p) => PERSONAS[p].name).join('、')}（${groups.length} 組）`)

const PLAY_SCHEMA = {
  type: 'object',
  properties: {
    finished: { type: 'boolean', description: '人物ファイルの「終わり方」まで進んだか' },
    stoppedAt: { type: 'string', description: '止まった、またはやめた画面。最後まで進んだら空' },
    summary: { type: 'string', description: 'どこまで進んだか、迷った場所、引っかかった言葉を短く' },
  },
  required: ['finished', 'summary'],
}

const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    people: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          persona: { type: 'string' },
          file: { type: 'string', description: '書いた人ごとの結果のパス' },
          stages: { type: 'string', description: '8 つの段階の記録を「始める: 通った / 話す: 引っかかった …」の形で' },
          playerAdded: { type: 'string', description: '演じる役が人物ファイルにない行動を足していたか。なければ空' },
        },
        required: ['persona', 'file', 'stages'],
      },
    },
    issues: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          persona: { type: 'string' },
          severity: { type: 'string', enum: ['芯に反する', '重い', '軽い'] },
          core: { type: 'string', description: '関わる製品の芯（番号と名前）か、価値の名前' },
          screen: { type: 'string' },
          what: { type: 'string', description: '何が起きたか。画面の言葉のまま引く' },
          kind: { type: 'string', enum: ['アプリ', '見込み', '線引き', '演じ方'] },
        },
        required: ['persona', 'severity', 'what', 'kind'],
      },
    },
    forHuman: { type: 'array', items: { type: 'string' }, description: '開発者が確かめる言い方（画面の言葉のまま）' },
  },
  required: ['people', 'issues'],
}

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    headline: { type: 'array', items: { type: 'string' }, description: 'いちばん大事なこと（3 行まで）' },
    comparedWith: { type: 'string' },
  },
  required: ['file', 'headline'],
}

function playPrompt(p) {
  const who = PERSONAS[p]
  return [
    `あなたは ${who.name} です。人物ファイルは evals/personas/people/${who.file}.md、演じ方は evals/personas/how-to-play.md。この 2 つだけを cat で読んでから始めてください。`,
    `画面を動かす道具の人の記号は「${p}」です（node evals/personas/driver/pw.mjs ${p} start から始める）。`,
    '人物ファイルの「画面での振る舞い」と「終わり方」に従って、最初の画面から使ってください。終えるときは snapshot end を送り、演じ方の「終わったら答えること」を answers で残してください。',
  ].join('\n')
}

function reviewPrompt(group, plays) {
  const lines = group.map((p, i) => {
    const r = plays[i]
    const state = r ? `${r.finished ? '最後まで進んだ' : `途中で止まった（${r.stoppedAt || '場所の記録なし'}）`}。演じる役の報告: ${r.summary}` : '演じる役が結果を返さなかった（記録が途中までかもしれない）'
    return `- ${PERSONAS[p].name}（記号 ${p}、人物ファイル evals/personas/people/${PERSONAS[p].file}.md）: ${state}`
  })
  return [
    `回 ${a.run}（コード ${a.commit}）の、次の人の記録を評価してください。`,
    ...lines,
    `人ごとの結果は ${resultDir}/<人物ファイルの名前>.md に書いてください（例: ${resultDir}/${PERSONAS[group[0]].file}.md）。`,
    'この回で演じていない人のことは書かない。演じる役が結果を返さなかった人は、残っている記録の範囲で書き、そう明記する。',
  ].join('\n')
}

const reviews = await pipeline(
  groups,
  (group) => parallel(group.map((p) => () =>
    agent(playPrompt(p), { label: `investigate:play-${p}`, phase: '演じる', agentType: 'persona-player', model: 'sonnet', effort: 'medium', schema: PLAY_SCHEMA }))),
  (plays, group) =>
    agent(reviewPrompt(group, plays), { label: `review:judge-${group.join('')}`, phase: '評価する', agentType: 'persona-reviewer', model: 'opus', effort: 'high', schema: REVIEW_SCHEMA }),
)

const done = reviews.filter(Boolean)
const issues = done.flatMap((r) => r.issues || [])
const forHuman = done.flatMap((r) => r.forHuman || [])
const reviewed = done.flatMap((r) => r.people || [])

phase('まとめる')
const summary = await agent([
  `ペルソナ評価の回 ${a.run}（${a.date}、コード ${a.commit}）のまとめを evals/results/${a.date}-persona.md に書いてください。`,
  '形は evals/personas/how-to-judge.md の「結果の書き方」に従い、evals/results/2026-11-04-persona.md の見出しに合わせる。冒頭に、人物と進め方は evals/personas/README.md、人ごとの全文は ' + `${resultDir}/` + ' にあると書く。',
  a.previous ? `前の回のまとめ ${a.previous} を読み、「前の回との違い」の節を書く。直った問題、残った問題、新しく出た問題を分ける。1 人 1 回ずつなので、AI の返事のばらつきで変わった可能性も添える。` : '前の回はないので、比べる節は書かない。',
  `この回で演じた人: ${people.map((p) => PERSONAS[p].name).join('、')}。演じていない人を「止まった」と書かない。`,
  `評価する役が書いた人ごとの結果: ${reviewed.map((r) => r.file).join('、') || '（なし）'}`,
  `段階の記録: ${JSON.stringify(reviewed.map((r) => ({ persona: r.persona, stages: r.stages, playerAdded: r.playerAdded || '' })))}`,
  `直す候補（評価する役が挙げたもの）: ${JSON.stringify(issues)}`,
  '直す候補は、発見した時点では直さない。直すかどうかは開発者が決めると書く。物差しどおりの読み取りで本人が納得しなかったもの（線引き）は、違反と書かない。',
  '使った額は、話す 1 往復 $0.06、1 人通し $1 の目安からの見積もりとして書き、実額は確かめていないと書く。',
  '実在の人の名前、開発者の名前を書かない。',
].join('\n'), { label: 'investigate:summary', phase: 'まとめる', model: 'opus', effort: 'high', schema: SUMMARY_SCHEMA })

return {
  run: a.run,
  people,
  summary,
  files: reviewed.map((r) => r.file),
  issues,
  forHuman,
  missing: people.filter((p) => !reviewed.some((r) => r.persona.includes(p) || r.persona.includes(PERSONAS[p].name))),
}
