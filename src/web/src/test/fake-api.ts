import { vi } from 'vitest'
import type {
  Abilities,
  AbilityKey,
  ChoiceRequest,
  Deepen,
  DeepenContent,
  DeepenTask,
  DeepenTaskRequest,
  Episode,
  EpisodeInsights,
  EpisodeSummary,
  NextStep,
  OptionCards,
  Options,
  Profile,
  ProfileConditions,
  ProfileEntry,
  Report,
  ReportContent,
  ReportSnapshot,
  Turn,
} from '@/api'

export type FakeCall = { method: string; url: string; body?: unknown }
export type FakeEvent = { event: string; data: unknown }

/** 画面のテストで使う、裏側が決める言葉の代わり（本物は DiscoverText.cs）。 */
export const FAKE_OPENING = '最近のある一日のことを、聞かせてください。'
export const FAKE_OPENING_CHOICES = ['家族と出かけた', '家で過ごした', '人と会った']
export const FAKE_AFTER_SKIP = 'では、別の日のことにしましょう。'
export const FAKE_SUPPORT_URL = 'https://www.mhlw.go.jp/mamorouyokokoro/'
export const FAKE_SUPPORT_LABEL = 'まもろうよ こころ（厚生労働省の相談窓口のページ）'
export const FAKE_DISTRESS_TEXT = '話してくれて、ありがとうございます。'
export const FAKE_DISTRESS_ACTIONS = ['続けて話す', '今日はここで区切る', 'この話は残さずに、別の話にする']

/** 架空の場面を作る。 */
export function fakeEpisode(overrides: Partial<Episode> = {}): Episode {
  return {
    id: 'episode-1',
    status: 'talking',
    startedAt: '2026-11-03T01:00:00Z',
    finishedAt: null,
    turns: [
      { role: 'assistant', text: FAKE_OPENING, choices: FAKE_OPENING_CHOICES, move: 'opening', at: '2026-11-03T01:00:00Z' },
    ],
    notice: null,
    insights: null,
    ...overrides,
  }
}

/** 裏側が決める続きの問いと選択肢の代わり（本物は AbilityText.cs）。 */
export const FAKE_RESUME_QUESTION = 'また話しに来てくれて、ありがとうございます。その日、用事の順番を決めたことがあれば、どう考えて決めたかを聞かせてもらえますか？'
export const FAKE_RESUME_CHOICES = ['思い当たることがあります', 'とくに思い当たりません', 'その日のほかのことを話したい']

/** 裏側が決める手がかりの言葉の代わり（本物は AbilityText.cs）。 */
export const FAKE_HINT = '先にすること、後に回すことを、どう考えて決めたか'

/** 架空の場面の「見えたこと」。引用はすべて架空。 */
export function fakeInsights(overrides: Partial<EpisodeInsights> = {}): EpisodeInsights {
  return {
    seen: [
      {
        key: 'coordinating',
        name: '調整する力',
        quotes: [
          { text: '班の 2 家族の都合を聞きました', fromChoice: false, linkedText: null },
          { text: '私から声をかけた', fromChoice: true, linkedText: '前の晩に、グループのメッセージで声をかけました' },
          { text: '順番を入れ替える案を出しました', fromChoice: false, linkedText: null },
        ],
      },
    ],
    moreToHear: [
      {
        key: 'prioritizing',
        name: '優先順位をつける力',
        quotes: [
          { text: '用事が重なっていました', fromChoice: false, linkedText: null },
          { text: '先に書類を仕上げました', fromChoice: false, linkedText: null },
        ],
        hints: [FAKE_HINT],
      },
    ],
    notYet: [{ key: 'noticing', name: '見立てる力' }],
    canResume: true,
    ...overrides,
  }
}

/** 架空の「見えた力」。 */
export function fakeAbilities(): Abilities {
  return {
    abilities: [
      {
        key: 'noticing',
        name: '見立てる力',
        life: 'notYet',
        quotes: [],
        episodeId: null,
        hints: [],
        work: 'notChecked',
        excluded: false,
      },
      {
        key: 'coordinating',
        name: '調整する力',
        life: 'confirmed',
        quotes: [{ text: '班の 2 家族の都合を聞きました', fromChoice: false, linkedText: null }],
        episodeId: 'episode-1',
        hints: [],
        work: 'notChecked',
        excluded: false,
      },
      {
        key: 'prioritizing',
        name: '優先順位をつける力',
        life: 'needsCheck',
        quotes: [{ text: '先に書類を仕上げました', fromChoice: false, linkedText: null }],
        episodeId: 'episode-1',
        hints: [FAKE_HINT],
        work: 'notChecked',
        excluded: false,
      },
    ],
    history: [
      {
        at: '2026-11-03T03:00:00Z',
        key: 'coordinating',
        name: '調整する力',
        from: 'needsCheck',
        to: 'confirmed',
        reason: 'talk',
        episodeId: 'episode-1',
      },
    ],
  }
}

/** 裏側が決める好みとやりたいことの問いと選択肢の代わり（本物は ProfileText.cs）。 */
export const FAKE_PREFERENCE_QUESTION = 'どんな進め方や環境が、自分に合っていると思いますか？'
export const FAKE_PREFERENCE_CHOICES = ['自分のペースで進められる', '人とやりとりしながら進められる', '決まった手順がある']
export const FAKE_WANT_QUESTION = 'これからやってみたいことや、目指したいことに近いものはありますか？'
export const FAKE_WANT_CHOICES = ['これまでの経験を活かしたい', '人の役に立つことをしたい', '新しいことを覚えたい']

/** 架空の 5 つの記録。できることは fakeAbilities と同じ力（調整する力が見えた力、優先順位をつける力が確かめ中）。 */
export function fakeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    canDo: {
      seen: [
        {
          key: 'coordinating',
          name: '調整する力',
          quotes: [
            { text: '班の 2 家族の都合を聞きました', fromChoice: false, linkedText: null },
            { text: '私から声をかけた', fromChoice: true, linkedText: '前の晩に、グループのメッセージで声をかけました' },
            // 3 つ目の核となる行動（代わりの案を出す）。見えた力は 3 つの行動がそろった力なので、見本もそろえる
            { text: '片方の家族には、集合を 30 分遅らせる案を出しました', fromChoice: false, linkedText: null },
          ],
          episodeId: 'episode-1',
        },
      ],
      checking: [
        {
          key: 'prioritizing',
          name: '優先順位をつける力',
          quotes: [{ text: '先に書類を仕上げました', fromChoice: false, linkedText: null }],
          episodeId: 'episode-1',
        },
      ],
      hasExcluded: false,
    },
    preferences: [],
    wants: [],
    conditions: null,
    agency: null,
    asked: { preferences: false, wants: false, agency: false },
    questions: {
      preferences: { question: FAKE_PREFERENCE_QUESTION, choices: FAKE_PREFERENCE_CHOICES },
      wants: { question: FAKE_WANT_QUESTION, choices: FAKE_WANT_CHOICES },
    },
    conditionOptions: { hoursPerWeek: [1, 3, 5, 10, 15, 20, 30, 40], monthlyIncome: [1, 3, 5, 8, 10, 15, 20] },
    ...overrides,
  }
}

/** 架空の出典（本物は jobs.json の source）。 */
export const FAKE_SOURCE = {
  text: '架空の出典の文（テスト用）',
  url: 'https://shigoto.mhlw.go.jp/User/download',
}

/** 架空の 3 枚のカード。中身はすべて架空。力と根拠の言葉は fakeProfile と同じ。 */
export function fakeOptionCards(overrides: Partial<OptionCards> = {}): OptionCards {
  const coordinating = {
    key: 'coordinating' as const,
    name: '調整する力',
    state: 'confirmed' as const,
    quotes: [
      { text: '班の 2 家族の都合を聞きました', fromChoice: false, linkedText: null },
      { text: '私から声をかけた', fromChoice: true, linkedText: '前の晩に、グループのメッセージで声をかけました' },
    ],
  }
  const schedule = {
    id: 'online-secretary-schedule',
    occupationName: 'オンライン秘書',
    name: '日程の調整',
    detail: '関わる人と連絡を取り合って、会う日時を決める',
    ability: 'coordinating' as const,
    timeSlots: ['daytime' as const],
    place: 'home' as const,
  }
  return {
    generatedAt: '2026-11-03T06:00:00Z',
    stale: false,
    retryPaused: false,
    choose: {
      occupationName: 'オンライン秘書',
      summary: '連絡や予定の段取りを、オンラインで手伝う仕事',
      tasks: [schedule],
      range: { minHours: 3, maxHours: 10, minMonthlyYen: 15000, maxMonthlyYen: 80000 },
      reason: '班の家族の都合を聞いて集合を決めた動きは、日程の調整に生かせそうです。',
      ability: coordinating,
    },
    combine: {
      roleName: '小さな事務所の段取り係',
      tasks: [
        schedule,
        {
          id: 'recruiting-interview-schedule',
          occupationName: '採用事務',
          name: '面接の日程の連絡',
          detail: '応募した人と面接する人の都合を聞いて、日時を伝える',
          ability: 'coordinating',
          timeSlots: ['daytime'],
          place: 'home',
        },
      ],
      range: { minHours: 6, maxHours: 10, minMonthlyYen: 31000, maxMonthlyYen: 76000 },
      reason: '何人かの都合を聞いて案を出した動きは、二つの連絡の業務に生かせそうです。',
      ability: coordinating,
    },
    create: {
      title: '習い事の送り迎えの調整の手伝い',
      who: '共働きで、子どもの習い事の送り迎えに困っている家族',
      trouble: '家族どうしの送り迎えの当番が決まらない',
      summary: '近所の家族の都合を聞き、送り迎えの当番表の案を作って伝える',
      hoursPerWeek: 3,
      place: 'home',
      timeSlots: ['daytime'],
      reason: '班の家族の都合を聞いて案を出した動きを、当番決めに生かせそうです。',
      ability: coordinating,
    },
    missing: [],
    ...overrides,
  }
}

/** 架空の仕事の選択肢。進める条件がそろっていて、カードはまだ作っていない。 */
export function fakeOptions(overrides: Partial<Options> = {}): Options {
  return {
    readiness: 'ready',
    cards: null,
    ownJobs: [],
    choice: null,
    monthlyIncome: 5,
    source: FAKE_SOURCE,
    ...overrides,
  }
}

/** 架空の根拠の言葉（fakeProfile の見えた力と同じ）。 */
const FAKE_COORDINATING_QUOTES = [
  { text: '班の 2 家族の都合を聞きました', fromChoice: false, linkedText: null },
  { text: '私から声をかけた', fromChoice: true, linkedText: '前の晩に、グループのメッセージで声をかけました' },
  { text: '片方の家族には、集合を 30 分遅らせる案を出しました', fromChoice: false, linkedText: null },
]

/** 力の名前（本物は AbilityText.cs）。 */
const FAKE_ABILITY_NAMES: Record<AbilityKey, string> = {
  noticing: '見立てる力',
  coordinating: '調整する力',
  prioritizing: '優先順位をつける力',
}

/** 架空の問いの選択肢。どれもありうる考え方にする。 */
export const FAKE_DEEPEN_CHOICES = ['先に全員の都合を聞いてから決める', '決まっている予定を軸に、案を一つ出す', '依頼した人に、どれを優先するか確かめる']

/** 架空の深めた中身。「選ぶ」のオンライン秘書を深めたもの。中身はすべて架空。 */
export function fakeDeepenContent(overrides: Partial<DeepenContent> = {}): DeepenContent {
  return {
    generatedAt: '2026-11-03T08:00:00Z',
    stale: false,
    retryPaused: false,
    tasks: [
      {
        id: 'online-secretary-schedule',
        name: '日程の調整',
        detail: '関わる人と連絡を取り合って、会う日時を決める',
        ability: 'coordinating',
        abilityName: '調整する力',
        usable: { state: 'confirmed', quotes: FAKE_COORDINATING_QUOTES },
        knowledge: ['表計算'],
        drafted: false,
      },
      {
        id: 'online-secretary-travel',
        name: '出張や会食の手配',
        detail: '行き先と予算を聞いて、移動と店の候補をまとめる',
        ability: 'noticing',
        abilityName: '見立てる力',
        usable: null,
        knowledge: [],
        drafted: false,
      },
    ],
    tasksRejected: false,
    questions: [
      {
        id: 'q1',
        situation: '3 人の会議の日程を決めてほしいと頼まれましたが、1 人から返事が来ません。',
        abilityName: '調整する力',
        choices: FAKE_DEEPEN_CHOICES,
        answer: null,
      },
    ],
    steps: [
      { id: 's1', text: 'オンライン秘書の体験談を 2 つ読む', hours: 1, place: 'home', demandCheck: false, fits: true, chosen: false },
      { id: 's2', text: '自分の予定表を 1 週間分、色分けして整える', hours: 2, place: 'home', demandCheck: false, fits: true, chosen: false },
      { id: 's3', text: '募集を 3 つ読み、業務と時間の条件を書き出す', hours: 1, place: 'home', demandCheck: false, fits: true, chosen: false },
    ],
    stepsFallback: false,
    stepsReplaced: false,
    ownSteps: [],
    ...overrides,
  }
}

/** 架空の「選んだ案を深める」。「選ぶ」のオンライン秘書を選んでいて、まだ深めていない。 */
export function fakeDeepen(overrides: Partial<Deepen> = {}): Deepen {
  return {
    readiness: 'ready',
    target: { kind: 'choose', title: 'オンライン秘書', outsideConditions: false },
    content: null,
    retryPaused: false,
    ...overrides,
  }
}

/** 架空のレポートの中身。fakeProfile・fakeOptionCards・fakeDeepenContent と同じ記録で、「選ぶ」のオンライン秘書を選んで深めたもの。 */
export function fakeReportContent(overrides: Partial<ReportContent> = {}): ReportContent {
  const coordinating = { key: 'coordinating' as const, name: '調整する力', state: 'confirmed' as const, quotes: FAKE_COORDINATING_QUOTES }
  return {
    abilities: [
      coordinating,
      {
        key: 'prioritizing',
        name: '優先順位をつける力',
        state: 'needsCheck',
        quotes: [{ text: '先に書類を仕上げました', fromChoice: false, linkedText: null }],
      },
    ],
    notYet: {
      notHeard: ['見立てる力'],
      checking: ['優先順位をつける力'],
      taskGaps: [
        { taskName: '日程の調整', abilityName: null, knowledge: ['表計算'] },
        { taskName: '出張や会食の手配', abilityName: '見立てる力', knowledge: [] },
      ],
      hasExcluded: false,
    },
    abilitiesExcluded: false,
    records: {
      preferences: [{ text: '自分のペースで進められる', source: 'chosen' }],
      wants: [],
      conditions: { timeSlots: ['daytime'], hoursPerWeek: 10, place: 'homeOnly', monthlyIncome: 5 },
      agency: '家族の予定を先に決めてから動きたい',
    },
    choice: {
      kind: 'card',
      card: 'choose',
      title: 'オンライン秘書',
      summary: '連絡や予定の段取りを、オンラインで手伝う仕事',
      tasks: ['日程の調整', '出張や会食の手配'],
      reason: '班の家族の都合を聞いて集合を決めた動きは、日程の調整に生かせそうです。',
      ability: coordinating,
      problem: null,
      outsideConditions: false,
      demandNotChecked: false,
      cardsStale: false,
    },
    thinking: [
      { situation: '3 人の会議の日程を決めてほしいと頼まれましたが、1 人から返事が来ません。', answer: FAKE_DEEPEN_CHOICES[0], fromChoice: true },
    ],
    steps: [
      { text: 'オンライン秘書の体験談を 2 つ読む', own: false, fits: true },
      { text: '近所の図書館で本を借りる', own: true, fits: true },
    ],
    ...overrides,
  }
}

/** 版の写し（裏側の ReportSnapshotDto と同じく、根拠の言葉、選んだ案の理由、力の状態を表すものを除く）。 */
export function fakeReportSnapshot(content: ReportContent): ReportSnapshot {
  const c = content.choice
  return {
    abilities: content.abilities.map((a) => ({ key: a.key, name: a.name })),
    notYet: {
      taskGaps: content.notYet.taskGaps
        .filter((g) => g.knowledge.length > 0)
        .map((g) => ({ taskName: g.taskName, knowledge: g.knowledge })),
      hasExcluded: content.notYet.hasExcluded,
    },
    records: content.records,
    choice: {
      kind: c.kind,
      card: c.card,
      title: c.title,
      summary: c.summary,
      tasks: c.tasks,
      outsideConditions: c.outsideConditions,
      demandNotChecked: c.demandNotChecked,
      cardsStale: c.cardsStale,
    },
    thinking: content.thinking,
    steps: content.steps,
  }
}

/** 架空の可能性レポート。開ける状態で、第 1 版だけがある。 */
export function fakeReport(overrides: Partial<Report> = {}): Report {
  const content = fakeReportContent()
  return {
    ready: true,
    content,
    current: { number: 1, at: '2026-11-03T09:00:00Z', changed: [], snapshot: fakeReportSnapshot(content) },
    previous: [],
    ...overrides,
  }
}

/** 見立ての業務（「創る」と本人が書いた仕事のとき）。使える力は、fakeProfile の見えた力（調整する力）だけ。 */
export function fakeDraftedTask(id: string, task: DeepenTaskRequest): DeepenTask {
  return {
    id,
    name: task.name,
    detail: task.detail,
    ability: task.ability,
    abilityName: FAKE_ABILITY_NAMES[task.ability],
    usable: task.ability === 'coordinating' ? { state: 'confirmed', quotes: FAKE_COORDINATING_QUOTES } : null,
    knowledge: task.knowledge === '' ? [] : [task.knowledge],
    drafted: true,
  }
}

/** ふつうの返事（本文 2 かけら → 選択肢 → 終わり）。 */
export function replyEvents(body: [string, string], choices: string[], status: 'talking' | 'finished' = 'talking'): FakeEvent[] {
  return [
    { event: 'delta', data: { text: body[0] } },
    { event: 'delta', data: { text: body[1] } },
    ...(status === 'talking' ? [{ event: 'choices', data: { choices } }] : []),
    { event: 'done', data: { userTurnCount: 1, status, move: status === 'talking' ? 'askWhatYouDid' : 'close' } },
  ]
}

/** つらい状態のサインへの応え。 */
export function distressEvents(): FakeEvent[] {
  return [
    {
      event: 'notice',
      data: {
        kind: 'distress',
        text: FAKE_DISTRESS_TEXT,
        linkUrl: FAKE_SUPPORT_URL,
        linkLabel: FAKE_SUPPORT_LABEL,
        actions: FAKE_DISTRESS_ACTIONS,
      },
    },
    { event: 'done', data: { userTurnCount: 1, status: 'talking', move: 'distress' } },
  ]
}

function toSse(event: FakeEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}

/** テストが少しずつ送れる流れ。 */
export type FakeStream = { send: (event: string, data: unknown) => void; close: () => void }

/** 裏側の API の代わり。ログインと了解の状態とエピソードを持ち、呼ばれた順に記録する。 */
export function installFakeApi(initial: {
  loggedIn: boolean
  consented: boolean
  episodes?: Episode[]
  profile?: Profile
  options?: Options
  deepen?: Deepen
  report?: Report
  nextStep?: NextStep | { status: number; body: unknown }
}) {
  const state = {
    loggedIn: initial.loggedIn,
    consented: initial.consented,
    episodes: [...(initial.episodes ?? [])],
    /** 次に答えを送ったときの応答。イベントの並びか、流れを始める前に断る応答。 */
    reply: replyEvents(['受け止めました。', 'そのとき何をしましたか？'], ['段取りを考えた', '人に頼んだ', '手を動かした']) as
      | FakeEvent[]
      | { status: number; body: unknown },
    /** true なら、答えを送ったときの流れをテストが streams から少しずつ送る。 */
    manualStream: false,
    /**
     * 飛ばしたときに、ほかの画面で始まっていた場面の id。入れると、飛ばした場面を消したうえで、
     * 新しい場面を作らずに 409（その場面の id 付き）を返す。
     */
    skipFindsInProgress: null as string | null,
    /** 区切ったときに場面に入れる「見えたこと」。 */
    finishInsights: fakeInsights() as EpisodeInsights | null,
    /** 訂正を送ったときの応答。見えたことか、断る応答。 */
    correction: fakeInsights({ seen: [] }) as EpisodeInsights | { status: number; body: unknown },
    /** true なら、訂正の中につらい状態のサインがあったとして、決まった言葉と窓口を返す（見えたことは出さない）。 */
    correctionDistress: false,
    /** 続きを話すときに、ほかの画面で始まっていた場面の id。入れると 409（その場面の id 付き）を返す。 */
    resumeFindsInProgress: null as string | null,
    abilities: fakeAbilities(),
    profile: initial.profile ?? fakeProfile(),
    /** true なら、5 つの記録の保存（PUT）を 500 で断る。 */
    profileSaveFails: false,
    options: initial.options ?? fakeOptions(),
    /** カードを作ったとき（POST /api/options）の応答。作るカードか、断る応答。 */
    generate: fakeOptionCards() as OptionCards | { status: number; body: unknown },
    /** 入れると、カードを作る応答をこの約束が済むまで待たせる（待っているあいだの表示を見るため）。 */
    generateGate: null as Promise<void> | null,
    /** true なら、仕事の選択肢の選ぶ・書く（/api/options/ の下の API）を 500 で断る。 */
    optionsSaveFails: false,
    deepen: initial.deepen ?? fakeDeepen({ readiness: 'noChoice', target: null }),
    /** 深めたとき（POST /api/deepen）の応答。作る中身か、断る応答。 */
    deepenGenerate: fakeDeepenContent() as DeepenContent | { status: number; body: unknown },
    /** 入れると、深める応答をこの約束が済むまで待たせる（待っているあいだの表示を見るため）。 */
    deepenGate: null as Promise<void> | null,
    /** true なら、深めた中身の書き換え（/api/deepen/ の下の API）を 500 で断る。 */
    deepenSaveFails: false,
    /** 可能性レポート。保留と一歩の保存は、裏側と同じく、次に開いたときの中身に映す（版は増やさない）。 */
    report: initial.report ?? fakeReport({ ready: false, content: null, current: null }),
    /** true なら、可能性レポート（GET /api/report）を 500 で断る。 */
    reportFails: false,
    /**
     * 次にできること（GET /api/next-step）。null なら、裏側と同じ順で、いまの場面と記録から決める。
     * 入れると、その値を返すか、断る応答を返す。
     */
    nextStep: (initial.nextStep ?? null) as NextStep | { status: number; body: unknown } | null,
  }
  const calls: FakeCall[] = []
  const streams: FakeStream[] = []
  const currentVersion = '2026-11-02'
  let nextId = 100

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

  const newEpisode = (text: string): Episode =>
    fakeEpisode({
      id: `episode-${nextId++}`,
      turns: [{ role: 'assistant', text, choices: FAKE_OPENING_CHOICES, move: 'opening', at: '2026-11-03T02:00:00Z' }],
    })

  const summary = (e: Episode): EpisodeSummary => ({
    id: e.id,
    status: e.status,
    startedAt: e.startedAt,
    userTurnCount: e.turns.filter((t) => t.role === 'user').length,
    preview: e.turns.find((t) => t.role === 'user')?.text.slice(0, 30) ?? '',
    canResume: e.status === 'finished' && (e.insights?.canResume ?? false),
  })

  const sseResponse = (events: FakeEvent[]) =>
    new Response(events.map(toSse).join(''), { headers: { 'Content-Type': 'text/event-stream' } })

  const manualResponse = () => {
    const encoder = new TextEncoder()
    let controller!: ReadableStreamDefaultController<Uint8Array>
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        controller = c
      },
    })
    streams.push({
      send: (event, data) => controller.enqueue(encoder.encode(toSse({ event, data }))),
      close: () => controller.close(),
    })
    return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
  }

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined
    calls.push({ method, url, body })

    if (!state.loggedIn) {
      return json(401, { type: '/problems/login-required', status: 401 })
    }
    if (url === '/api/me' && method === 'GET') {
      return json(200, {
        consented: state.consented,
        consentVersion: state.consented ? currentVersion : null,
        currentVersion,
      })
    }
    if (url === '/api/consent' && method === 'POST') {
      state.consented = true
      return new Response(null, { status: 204 })
    }
    if (url === '/api/me' && method === 'DELETE') {
      state.consented = false
      state.episodes = []
      state.profile = fakeProfile()
      state.options = fakeOptions()
      state.deepen = fakeDeepen({ readiness: 'noChoice', target: null })
      state.report = fakeReport({ ready: false, content: null, current: null })
      return new Response(null, { status: 204 })
    }

    if (url === '/api/next-step' && method === 'GET') {
      if (state.nextStep === null) return json(200, deriveNextStep())
      if ('status' in state.nextStep) return json(state.nextStep.status, state.nextStep.body)
      return json(200, state.nextStep)
    }
    if (url === '/api/report' && method === 'GET') {
      if (state.reportFails) return json(500, { status: 500 })
      return json(200, state.report)
    }

    if (url === '/api/deepen' && method === 'GET') {
      return json(200, state.deepen)
    }
    if (url === '/api/deepen' && method === 'POST') {
      if (state.deepenGate) await state.deepenGate
      if (state.deepen.readiness !== 'ready') {
        return json(409, { type: '/problems/deepen-not-ready', status: 409, readiness: state.deepen.readiness })
      }
      const current = state.deepen.content
      if (current && !current.stale) return json(200, state.deepen)
      if ('status' in state.deepenGenerate) return json(state.deepenGenerate.status, state.deepenGenerate.body)
      state.deepen = { ...state.deepen, content: { ...state.deepenGenerate, stale: false, retryPaused: false } }
      return json(200, state.deepen)
    }
    if (url.startsWith('/api/deepen/')) {
      if (state.deepenSaveFails) return json(500, { status: 500 })
      const content = state.deepen.content
      // 裏側と同じく、見ていた中身（作った日時）がいまの中身でなければ断る
      const seen = (body as { generatedAt?: string } | undefined)?.generatedAt
      if (!seen) return json(400, { type: '/problems/invalid-deepen', status: 400 })
      if (state.deepen.readiness !== 'ready' || !content || content.stale || content.generatedAt !== seen) {
        return json(409, { type: '/problems/deepen-changed', status: 409 })
      }
      if (url === '/api/deepen/tasks' && method === 'PUT') {
        // 業務を直せるのは、「創る」と本人が書いた仕事のときだけ（業務が空でも直せる）
        if (state.deepen.target?.kind !== 'create' && state.deepen.target?.kind !== 'own') {
          return json(409, { type: '/problems/deepen-changed', status: 409 })
        }
        const tasks = (body as { tasks: DeepenTaskRequest[] }).tasks
        if (tasks.length > 5) return json(400, { type: '/problems/invalid-deepen', status: 400 })
        state.deepen = {
          ...state.deepen,
          content: { ...content, tasks: tasks.map((t, i) => fakeDraftedTask(`u${i + 1}`, t)), tasksRejected: false },
        }
        return json(200, state.deepen)
      }
      const answerMatch = /^\/api\/deepen\/answers\/([^/]+)$/.exec(url)
      if (answerMatch && method === 'PUT') {
        const id = decodeURIComponent(answerMatch[1])
        const question = content.questions.find((q) => q.id === id)
        if (!question) return json(404, { type: '/problems/not-found', status: 404 })
        const answer = body as { text: string; fromChoice: boolean }
        if (answer.fromChoice && !question.choices.includes(answer.text)) {
          return json(400, { type: '/problems/invalid-deepen', status: 400 })
        }
        state.deepen = {
          ...state.deepen,
          content: {
            ...content,
            questions: content.questions.map((q) => (q.id === id ? { ...q, answer: { text: answer.text.trim(), fromChoice: answer.fromChoice } } : q)),
          },
        }
        return json(200, state.deepen)
      }
      if (url === '/api/deepen/steps' && method === 'PUT') {
        const request = body as { chosen: string[]; own: string[] }
        if (request.chosen.some((id) => !content.steps.some((s) => s.id === id)) || request.own.length > 3) {
          return json(400, { type: '/problems/invalid-deepen', status: 400 })
        }
        state.deepen = {
          ...state.deepen,
          content: {
            ...content,
            steps: content.steps.map((s) => ({ ...s, chosen: request.chosen.includes(s.id) })),
            ownSteps: request.own,
          },
        }
        const report = state.report.content
        if (report) {
          const chosen = content.steps.filter((s) => request.chosen.includes(s.id)).map((s) => ({ text: s.text, own: false, fits: s.fits }))
          const own = request.own.map((text) => ({ text, own: true, fits: true }))
          state.report = { ...state.report, content: { ...report, steps: [...chosen, ...own] } }
        }
        return json(200, state.deepen)
      }
    }

    if (url === '/api/options' && method === 'GET') {
      return json(200, state.options)
    }
    if (url === '/api/options' && method === 'POST') {
      if (state.generateGate) await state.generateGate
      if (state.options.readiness !== 'ready') {
        return json(409, { type: '/problems/options-not-ready', status: 409, readiness: state.options.readiness })
      }
      if ('status' in state.generate) return json(state.generate.status, state.generate.body)
      state.options = { ...state.options, cards: { ...state.generate, stale: false } }
      return json(200, state.options)
    }
    if (url.startsWith('/api/options/') && state.optionsSaveFails) {
      return json(500, { status: 500 })
    }
    if (url === '/api/options/choice' && method === 'PUT') {
      const choice = body as ChoiceRequest
      const at = '2026-11-03T07:00:00Z'
      if (choice.kind === 'card') {
        const cards = state.options.cards
        const card = cards?.[choice.card]
        if (!cards || !card || cards.generatedAt !== choice.generatedAt) {
          return json(409, { type: '/problems/options-changed', status: 409 })
        }
        state.options = {
          ...state.options,
          choice: {
            kind: 'card',
            at,
            card: {
              kind: choice.card,
              choose: choice.card === 'choose' ? cards.choose : null,
              combine: choice.card === 'combine' ? cards.combine : null,
              create: choice.card === 'create' ? cards.create : null,
              abilityExcluded: false,
              abilityChanged: false,
              outsideConditions: false,
            },
            ownJob: null,
          },
        }
      } else if (choice.kind === 'own') {
        const own = state.options.ownJobs.find((j) => j.id === choice.ownJobId)
        if (!own) return json(404, { type: '/problems/not-found', status: 404 })
        state.options = { ...state.options, choice: { kind: 'own', at, card: null, ownJob: own } }
      } else {
        state.options = { ...state.options, choice: { kind: 'hold', at, card: null, ownJob: null } }
        const report = state.report.content
        if (report) {
          state.report = {
            ...state.report,
            content: {
              ...report,
              choice: { ...report.choice, kind: 'hold', card: null, title: null, summary: null, tasks: [], reason: null, ability: null, problem: null, outsideConditions: false, demandNotChecked: false },
              notYet: { ...report.notYet, taskGaps: [] },
              thinking: null,
              steps: null,
            },
          }
        }
      }
      return json(200, state.options)
    }
    if (url === '/api/options/choice' && method === 'DELETE') {
      state.options = { ...state.options, choice: null }
      return json(200, state.options)
    }
    if (url === '/api/options/own' && method === 'POST') {
      const job = body as { title: string; note: string }
      if (state.options.ownJobs.length >= 3) return json(400, { type: '/problems/invalid-option', status: 400 })
      const note = job.note.trim()
      state.options = {
        ...state.options,
        ownJobs: [...state.options.ownJobs, { id: `own-${nextId++}`, title: job.title.trim(), note: note === '' ? null : note }],
      }
      return json(200, state.options)
    }
    const ownMatch = /^\/api\/options\/own\/([^/]+)$/.exec(url)
    if (ownMatch) {
      const id = decodeURIComponent(ownMatch[1])
      const own = state.options.ownJobs.find((j) => j.id === id)
      if (!own) return json(404, { type: '/problems/not-found', status: 404 })
      const choice = state.options.choice
      const chosen = choice?.kind === 'own' && choice.ownJob?.id === id
      if (method === 'PUT') {
        const job = body as { title: string; note: string }
        const note = job.note.trim()
        const changed = { id, title: job.title.trim(), note: note === '' ? null : note }
        state.options = {
          ...state.options,
          ownJobs: state.options.ownJobs.map((j) => (j.id === id ? changed : j)),
          choice: chosen && choice ? { ...choice, ownJob: changed } : choice,
        }
        return json(200, state.options)
      }
      if (method === 'DELETE') {
        state.options = {
          ...state.options,
          ownJobs: state.options.ownJobs.filter((j) => j.id !== id),
          choice: chosen ? null : choice,
        }
        return json(200, state.options)
      }
    }

    if (url === '/api/profile' && method === 'GET') {
      return json(200, state.profile)
    }
    const profileMatch = /^\/api\/profile\/(preferences|wants|conditions|agency)$/.exec(url)
    if (profileMatch && method === 'PUT') {
      if (state.profileSaveFails) return json(500, { status: 500 })
      const p = state.profile
      switch (profileMatch[1]) {
        case 'preferences':
          state.profile = { ...p, preferences: (body as { entries: ProfileEntry[] }).entries, asked: { ...p.asked, preferences: true } }
          break
        case 'wants':
          state.profile = { ...p, wants: (body as { entries: ProfileEntry[] }).entries, asked: { ...p.asked, wants: true } }
          break
        case 'conditions':
          state.profile = { ...p, conditions: body as ProfileConditions }
          break
        case 'agency': {
          const text = (body as { text: string }).text.trim()
          state.profile = { ...p, agency: text === '' ? null : text, asked: { ...p.asked, agency: true } }
          break
        }
      }
      return json(200, state.profile)
    }

    if (url === '/api/episodes' && method === 'GET') {
      const sorted = [...state.episodes].sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      return json(200, sorted.map(summary))
    }
    if (url === '/api/episodes' && method === 'POST') {
      const talking = state.episodes.find((e) => e.status === 'talking')
      if (talking) {
        return json(409, { type: '/problems/episode-in-progress', status: 409, episodeId: talking.id })
      }
      const created = newEpisode(FAKE_OPENING)
      state.episodes.push(created)
      return json(201, created)
    }

    if (url === '/api/abilities' && method === 'GET') {
      return json(200, state.abilities)
    }
    const abilityMatch = /^\/api\/abilities\/([^/]+)\/(exclude|restore)$/.exec(url)
    if (abilityMatch && method === 'POST') {
      const ability = state.abilities.abilities.find((a) => a.key === abilityMatch[1])
      if (!ability) return json(404, { type: '/problems/not-found', status: 404 })
      const excluded = abilityMatch[2] === 'exclude'
      state.abilities = {
        abilities: state.abilities.abilities.map((a) => (a.key === ability.key ? { ...a, excluded } : a)),
        history: [
          {
            at: '2026-11-03T05:00:00Z',
            key: ability.key,
            name: ability.name,
            from: ability.life,
            to: ability.life,
            reason: excluded ? 'exclude' : 'restore',
            episodeId: null,
          },
          ...state.abilities.history,
        ],
      }
      return json(200, state.abilities)
    }

    const match = /^\/api\/episodes\/([^/]+)(?:\/(finish|skip|messages|corrections|resume))?$/.exec(url)
    const episode = match ? state.episodes.find((e) => e.id === decodeURIComponent(match[1])) : undefined
    if (match && !episode) {
      return json(404, { type: '/problems/not-found', status: 404 })
    }
    if (match && episode) {
      const action = match[2]
      if (!action && method === 'GET') return json(200, episode)
      if (action === 'finish' && method === 'POST') {
        episode.status = 'finished'
        episode.insights = state.finishInsights
        return json(200, episode)
      }
      if (action === 'corrections' && method === 'POST') {
        if ('status' in state.correction) return json(state.correction.status, state.correction.body)
        const text = (body as { text: string }).text
        const turn: Turn = { role: 'user', text, answerKind: 'correction', at: '2026-11-03T04:00:00Z' }
        if (state.correctionDistress) {
          episode.turns = [
            ...episode.turns,
            turn,
            { role: 'assistant', text: FAKE_DISTRESS_TEXT, move: 'distress', at: '2026-11-03T04:00:01Z' },
          ]
          episode.insights = null
          episode.notice = {
            kind: 'distress',
            text: FAKE_DISTRESS_TEXT,
            linkUrl: FAKE_SUPPORT_URL,
            linkLabel: FAKE_SUPPORT_LABEL,
            actions: FAKE_DISTRESS_ACTIONS,
          }
          return json(200, episode)
        }
        episode.turns = [...episode.turns, turn]
        episode.insights = state.correction
        return json(200, episode)
      }
      if (action === 'resume' && method === 'POST') {
        if (state.resumeFindsInProgress) {
          return json(409, { type: '/problems/episode-in-progress', status: 409, episodeId: state.resumeFindsInProgress })
        }
        if (episode.status !== 'finished' || !episode.insights?.canResume) {
          return json(409, { type: '/problems/episode-finished', status: 409 })
        }
        episode.status = 'talking'
        episode.finishedAt = null
        episode.insights = null
        episode.turns = [
          ...episode.turns,
          { role: 'assistant', text: FAKE_RESUME_QUESTION, choices: FAKE_RESUME_CHOICES, move: 'resume', at: '2026-11-03T04:30:00Z' },
        ]
        return json(200, episode)
      }
      if (action === 'skip' && method === 'POST') {
        state.episodes = state.episodes.filter((e) => e.id !== episode.id)
        if (state.skipFindsInProgress) {
          return json(409, { type: '/problems/episode-in-progress', status: 409, episodeId: state.skipFindsInProgress })
        }
        const next = newEpisode(FAKE_AFTER_SKIP)
        state.episodes.push(next)
        return json(201, next)
      }
      if (action === 'messages' && method === 'POST') {
        if (!Array.isArray(state.reply)) return json(state.reply.status, state.reply.body)
        if (state.manualStream) return manualResponse()
        recordRound(episode, body as { text: string; kind: 'free' | 'choice' }, state.reply)
        return sseResponse(state.reply)
      }
    }
    return json(404, { status: 404 })
  })

  /** 裏側（NextStep.cs）と同じ順で、次にできることを決める。 */
  function deriveNextStep(): NextStep {
    const talking = state.episodes.find((e) => e.status === 'talking')
    if (talking) return { step: 'continue', episodeId: talking.id }
    const of = (step: NextStep['step']): NextStep => ({ step, episodeId: null })
    if (!state.episodes.some((e) => e.status === 'finished')) return of('talk')
    if (state.profile.conditions === null) return of('conditions')
    if (state.options.readiness === 'needsAbility') return of('talk')
    if (state.options.readiness === 'onlyExcluded') return of('abilities')
    const choice = state.options.choice
    if (!choice) return of('options')
    if (choice.kind === 'hold') return of('report')
    if (!state.deepen.content || state.deepen.content.stale) return of('deepen')
    return of('report')
  }

  /** 裏側と同じく、返事を最後まで返せた 1 往復を場面に残す（開き直したときや、話し終えて読み直したときに使う）。 */
  function recordRound(episode: Episode, answer: { text: string; kind: 'free' | 'choice' }, events: FakeEvent[]) {
    const done = events.find((e) => e.event === 'done')?.data as { status: 'talking' | 'finished'; move: string } | undefined
    if (!done) return
    const notice = events.find((e) => e.event === 'notice')?.data as Episode['notice'] | undefined
    const distress = notice?.kind === 'distress' ? notice : null
    const text = events
      .filter((e) => e.event === 'delta')
      .map((e) => (e.data as { text: string }).text)
      .join('')
    const choices = (events.find((e) => e.event === 'choices')?.data as { choices: string[] } | undefined)?.choices ?? null
    episode.turns = [
      ...episode.turns,
      { role: 'user', text: answer.text, answerKind: answer.kind, at: '2026-11-03T01:05:00Z' },
      { role: 'assistant', text: distress ? distress.text : text, choices, move: done.move, at: '2026-11-03T01:05:01Z' },
    ]
    episode.status = done.status
    episode.notice = distress
  }

  vi.stubGlobal('fetch', fetchMock)
  return { state, calls, streams, currentVersion, fetchMock }
}
