/** 裏側の API の呼び出し。エラーは ProblemDetails（決まった形の JSON）から ApiError にする。 */

import { readSse } from '@/lib/sse'

export type Me = {
  consented: boolean
  consentVersion: string | null
  currentVersion: string
}

/** ログインとログアウトは組み込み認証へ、ページごと移動して行う。画面の切り替えで横取りしない。 */
export const LOGIN_URL = '/.auth/login/google?post_login_redirect_uri=/start'
export const LOGOUT_URL = '/.auth/logout?post_logout_redirect_uri=/'

export const PROBLEM_TYPES = {
  loginRequired: '/problems/login-required',
  consentRequired: '/problems/consent-required',
  dailyLimit: '/problems/daily-limit',
  episodeInProgress: '/problems/episode-in-progress',
  episodeFinished: '/problems/episode-finished',
  deepenChanged: '/problems/deepen-changed',
} as const

export class ApiError extends Error {
  readonly status: number
  readonly type?: string
  readonly resetAt?: string
  /** 途中の場面があって新しく始められないとき（409）の、その場面の id。 */
  readonly episodeId?: string
  /** AI が失敗したか断ったとき（503）の、どちらだったか。 */
  readonly kind?: 'failure' | 'refusal'
  /** AI が失敗したか断ったとき（503）に、念のため添える相談窓口。 */
  readonly notice?: SupportNotice

  constructor(
    status: number,
    type?: string,
    resetAt?: string,
    episodeId?: string,
    kind?: 'failure' | 'refusal',
    notice?: SupportNotice,
  ) {
    super(`API error ${status}${type ? ` (${type})` : ''}`)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.resetAt = resetAt
    this.episodeId = episodeId
    this.kind = kind
    this.notice = notice
  }
}

export function isDailyLimit(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.type === PROBLEM_TYPES.dailyLimit || e.status === 429)
}

async function toApiError(response: Response): Promise<ApiError> {
  let type: string | undefined
  let resetAt: string | undefined
  let episodeId: string | undefined
  let kind: 'failure' | 'refusal' | undefined
  let notice: SupportNotice | undefined
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object') {
      const problem = body as Record<string, unknown>
      if (typeof problem.type === 'string') type = problem.type
      if (typeof problem.resetAt === 'string') resetAt = problem.resetAt
      if (typeof problem.episodeId === 'string') episodeId = problem.episodeId
      if (problem.kind === 'failure' || problem.kind === 'refusal') kind = problem.kind
      if (isSupportNotice(problem.notice)) notice = problem.notice
    }
  } catch {
    // 本文が JSON でなければ、状態コードだけで見分ける
  }
  return new ApiError(response.status, type, resetAt, episodeId, kind, notice)
}

function isSupportNotice(value: unknown): value is SupportNotice {
  if (value === null || typeof value !== 'object') return false
  const notice = value as Record<string, unknown>
  return typeof notice.text === 'string' && typeof notice.linkUrl === 'string' && typeof notice.linkLabel === 'string'
}

async function request(path: string, init: RequestInit = {}): Promise<Response> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...init,
    headers: { Accept: 'application/json', ...init.headers },
  })
  if (!response.ok) {
    throw await toApiError(response)
  }
  return response
}

/** ログインしていなければ null。 */
export async function getMe(): Promise<Me | null> {
  try {
    const response = await request('/api/me')
    return (await response.json()) as Me
  } catch (e) {
    if (e instanceof ApiError && e.status === 401) return null
    throw e
  }
}

export async function postConsent(version: string): Promise<void> {
  await request('/api/consent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ version }),
  })
}

export async function deleteMe(): Promise<void> {
  await request('/api/me', { method: 'DELETE' })
}

// ---- エピソード（話した一つの場面） ----

export type EpisodeStatus = 'talking' | 'finished'
export type AnswerKind = 'free' | 'choice'
/** 保存されたターンの答え方。correction は、話し終えた場面の読み取りを本人が直した言葉。 */
export type TurnAnswerKind = AnswerKind | 'correction'

/** やりとりの 1 ターン。assistant は問いや返事、user は利用者の答え。 */
export type Turn = {
  role: 'assistant' | 'user'
  text: string
  choices?: string[] | null
  answerKind?: TurnAnswerKind | null
  /** assistant のターンで、どの一手として出した言葉か（"distress" はつらい状態のサインへの応え）。 */
  move?: string | null
  at: string
}

/** 相談窓口の知らせ。distress はつらい状態のサインへの応え、support は読み取りに失敗したときに添えるもの。 */
export type SupportNotice = {
  kind: 'distress' | 'support'
  text: string
  linkUrl: string
  linkLabel: string
  actions?: string[] | null
}

export type Episode = {
  id: string
  status: EpisodeStatus
  startedAt: string
  finishedAt?: string | null
  turns: Turn[]
  /** 最後の返事がつらい状態のサインへの応えのときだけ付く。 */
  notice?: SupportNotice | null
  /** 話し終えた場面から見えたこと。話し終えた場面で、力の確かめに使う場面のときだけ付く。 */
  insights?: EpisodeInsights | null
}

// ---- 力の確かめ ----

/** 根拠の本人の言葉。fromChoice なら選んだ答えで、linkedText に結びついた本人の言葉が入る。 */
export type Quote = { text: string; fromChoice: boolean; linkedText?: string | null }

export type AbilityKey = 'noticing' | 'coordinating' | 'prioritizing'

/** 力の状態。画面には呼び名を出さず、copy の言葉にして出す。 */
export type AbilityState = 'notYet' | 'needsCheck' | 'confirmed'

/** 話し終えた場面から見えたこと。力の名前と手がかりは裏側が決めた言葉。 */
export type EpisodeInsights = {
  seen: { key: AbilityKey; name: string; quotes: Quote[] }[]
  moreToHear: { key: AbilityKey; name: string; quotes: Quote[]; hints: string[] }[]
  notYet: { key: AbilityKey; name: string }[]
  canResume: boolean
}

/** 見えた力の 1 つ。life は生活の中での状態、work は仕事での状態（いまはいつも notChecked）。 */
export type AbilityView = {
  key: AbilityKey
  name: string
  life: AbilityState
  quotes: Quote[]
  episodeId?: string | null
  hints: string[]
  work: string
  excluded: boolean
}

export type ChangeReason = 'talk' | 'correction' | 'skip' | 'exclude' | 'restore' | 'setAside'

export type AbilityChange = {
  at: string
  key: AbilityKey
  name: string
  from: AbilityState
  to: AbilityState
  reason: ChangeReason
  episodeId?: string | null
}

/** 見えた力の API が返すもの。履歴は新しい順。 */
export type Abilities = { abilities: AbilityView[]; history: AbilityChange[] }

export type EpisodeSummary = {
  id: string
  status: EpisodeStatus
  startedAt: string
  userTurnCount: number
  preview: string
  /** 続きを話せる場面か（話し終えていて、もう少し聞かせてほしいことがある）。 */
  canResume: boolean
}

export type TalkDone = { userTurnCount: number; status: EpisodeStatus; move: string }
/** refusal: AI が断った。failure: うまくいかなかった。closed: 場面がほかの画面で飛ばされた・区切られた・消された。 */
export type TalkErrorKind = 'refusal' | 'failure' | 'closed'

export type TalkHandlers = {
  onDelta: (text: string) => void
  onChoices: (choices: string[]) => void
  onNotice: (notice: SupportNotice) => void
  onDone: (done: TalkDone) => void
  onError: (kind: TalkErrorKind) => void
}

export async function listEpisodes(): Promise<EpisodeSummary[]> {
  const response = await request('/api/episodes')
  return (await response.json()) as EpisodeSummary[]
}

/** 新しい場面を作る。途中の場面があれば 409 の ApiError（episodeId 付き）。 */
export async function createEpisode(): Promise<Episode> {
  const response = await request('/api/episodes', { method: 'POST' })
  return (await response.json()) as Episode
}

export async function getEpisode(id: string): Promise<Episode> {
  const response = await request(`/api/episodes/${encodeURIComponent(id)}`)
  return (await response.json()) as Episode
}

export async function finishEpisode(id: string): Promise<Episode> {
  const response = await request(`/api/episodes/${encodeURIComponent(id)}/finish`, { method: 'POST' })
  return (await response.json()) as Episode
}

/** 場面を消し、飛ばしたあと用の問いで始まる新しい場面を返す。 */
export async function skipEpisode(id: string): Promise<Episode> {
  const response = await request(`/api/episodes/${encodeURIComponent(id)}/skip`, { method: 'POST' })
  return (await response.json()) as Episode
}

/**
 * 答えを送り、返事を SSE で受けて、届いた順に handlers へ渡す。
 * 流れを始める前に断られたとき（400、404、409、429 など）は ApiError を投げる。
 * 流れが途中で切れたとき、終わりの知らせもエラーもなく終わったときは、onError('failure') を呼ぶ。
 */
export async function sendAnswer(
  id: string,
  answer: { text: string; kind: AnswerKind },
  handlers: TalkHandlers,
): Promise<void> {
  const response = await request(`/api/episodes/${encodeURIComponent(id)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify(answer),
  })

  let finished = false
  try {
    for await (const { event, data } of readSse(response)) {
      const body = (data ?? {}) as Record<string, unknown>
      switch (event) {
        case 'delta':
          if (typeof body.text === 'string') handlers.onDelta(body.text)
          break
        case 'choices':
          if (Array.isArray(body.choices)) handlers.onChoices(body.choices.filter((c) => typeof c === 'string'))
          break
        case 'notice':
          handlers.onNotice(data as SupportNotice)
          break
        case 'done':
          finished = true
          handlers.onDone(data as TalkDone)
          break
        case 'error':
          finished = true
          handlers.onError(body.kind === 'refusal' || body.kind === 'closed' ? body.kind : 'failure')
          break
      }
    }
  } catch {
    // 流れの途中で切れた。下で失敗として知らせる
  }
  if (!finished) handlers.onError('failure')
}

/** 話し終えた場面の読み取りを直す。AI が失敗・拒否したときは 503 の ApiError（kind 付き）。 */
export async function sendCorrection(id: string, text: string): Promise<Episode> {
  const response = await request(`/api/episodes/${encodeURIComponent(id)}/corrections`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  })
  return (await response.json()) as Episode
}

/** 話し終えた場面の続きを話す。ほかに途中の場面があれば 409 の ApiError（episodeId 付き）。 */
export async function resumeEpisode(id: string): Promise<Episode> {
  const response = await request(`/api/episodes/${encodeURIComponent(id)}/resume`, { method: 'POST' })
  return (await response.json()) as Episode
}

export async function getAbilities(): Promise<Abilities> {
  const response = await request('/api/abilities')
  return (await response.json()) as Abilities
}

/** 力の見立てを外す。 */
export async function excludeAbility(key: AbilityKey): Promise<Abilities> {
  const response = await request(`/api/abilities/${encodeURIComponent(key)}/exclude`, { method: 'POST' })
  return (await response.json()) as Abilities
}

/** 外した見立てを戻す。 */
export async function restoreAbility(key: AbilityKey): Promise<Abilities> {
  const response = await request(`/api/abilities/${encodeURIComponent(key)}/restore`, { method: 'POST' })
  return (await response.json()) as Abilities
}

// ---- 5 つの記録 ----

/** 好みとやりたいことの項目。chosen は問いの選択肢から選んだ言葉、written は本人が書いた言葉。 */
export type ProfileEntry = { text: string; source: 'chosen' | 'written' }

export type TimeSlot = 'morning' | 'daytime' | 'evening' | 'night'
export type Place = 'homeOnly' | 'canGoOut'

/** 条件。monthlyIncome は万円で、null は「まだ決めていない」。 */
export type ProfileConditions = { timeSlots: TimeSlot[]; hoursPerWeek: number; place: Place; monthlyIncome: number | null }

/** できることの 1 つ。根拠の本人の言葉と、その話の id。 */
export type CanDoAbility = { key: AbilityKey; name: string; quotes: Quote[]; episodeId?: string | null }

/** 裏側が決めた問いと選択肢。 */
export type ProfileQuestion = { question: string; choices: string[] }

/** 5 つの記録の API が返すもの。できることは、そのときの力の状態から裏側が作る。 */
export type Profile = {
  /** seen は見えた力、checking は確かめ中の力。hasExcluded は本人が外した力があるか（外した力そのものは入らない）。 */
  canDo: { seen: CanDoAbility[]; checking: CanDoAbility[]; hasExcluded: boolean }
  preferences: ProfileEntry[]
  wants: ProfileEntry[]
  conditions: ProfileConditions | null
  agency: string | null
  /** どの問いに答えたか（「いまは決めない」「いまは書かない」も答えたことにする）。 */
  asked: { preferences: boolean; wants: boolean; agency: boolean }
  questions: { preferences: ProfileQuestion; wants: ProfileQuestion }
  conditionOptions: { hoursPerWeek: number[]; monthlyIncome: number[] }
}

export async function getProfile(): Promise<Profile> {
  const response = await request('/api/profile')
  return (await response.json()) as Profile
}

async function putProfile(path: string, body: unknown): Promise<Profile> {
  const response = await request(`/api/profile/${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await response.json()) as Profile
}

/** 好みを、送った並びに置き換える。 */
export function putPreferences(entries: ProfileEntry[]): Promise<Profile> {
  return putProfile('preferences', { entries })
}

/** やりたいことを、送った並びに置き換える。 */
export function putWants(entries: ProfileEntry[]): Promise<Profile> {
  return putProfile('wants', { entries })
}

export function putConditions(conditions: ProfileConditions): Promise<Profile> {
  return putProfile('conditions', conditions)
}

/** 主体性を置き換える。空なら書いていないことになる。 */
export function putAgency(text: string): Promise<Profile> {
  return putProfile('agency', { text })
}

// ---- 仕事の選択肢 ----

/** 仕事の選択肢を出せるか。出せないときは、最初に足りないもの。onlyExcluded は、使える力をどれも本人が外している。 */
export type Readiness = 'ready' | 'needsConditions' | 'needsFinishedEpisode' | 'needsAbility' | 'onlyExcluded'
export type CardKind = 'choose' | 'combine' | 'create'
/**
 * カードを出せない理由。noFit は条件に収まる登録の業務がない、noAbilityMatch は条件に収まる業務はあるが使える力を使う業務がない、
 * rejected は AI が作らなかったか照らし合わせに通らなかった、excluded は本人が外した力を使っていた、
 * changed は力の状態か根拠の言葉が、いまの記録と合わなくなった（訂正で場面を読み直したときなど）。
 */
export type MissingReason = 'noFit' | 'noAbilityMatch' | 'rejected' | 'excluded' | 'changed'
export type TaskPlace = 'home' | 'out'

/** カードの業務。ability は使う力の key。timeSlots は本人の時間帯に入るもの。 */
export type CardTask = {
  id: string
  occupationName: string
  name: string
  detail: string
  ability: AbilityKey
  timeSlots: TimeSlot[]
  place: TaskPlace
}

/** 週あたりの時間の幅と、収入の目安（円、1 か月を 4 週として）。 */
export type WorkRange = { minHours: number; maxHours: number; minMonthlyYen: number; maxMonthlyYen: number }

/** カードの理由に使った力と、その根拠の本人の言葉。state は画面では copy の言葉にして出す。 */
export type CardAbility = { key: AbilityKey; name: string; state: 'confirmed' | 'needsCheck'; quotes: Quote[] }

// カードの reason と ability は、選んだ案の力を本人があとで外したか、力の状態か根拠の言葉がいまの記録と合わなくなったときだけ null になる
// （OptionChoice の abilityExcluded と abilityChanged）

export type ChooseCard = {
  occupationName: string
  summary: string
  tasks: CardTask[]
  range: WorkRange
  reason: string | null
  ability: CardAbility | null
}

export type CombineCard = { roleName: string; tasks: CardTask[]; range: WorkRange; reason: string | null; ability: CardAbility | null }

export type CreateCard = {
  title: string
  who: string
  trouble: string
  summary: string
  hoursPerWeek: number
  place: TaskPlace
  timeSlots: TimeSlot[]
  reason: string | null
  ability: CardAbility | null
}

/**
 * いまの記録で見せられるカード。stale は、作ったあとに元の記録が変わったか。retryPaused は、いまの記録で作り直そうとして
 * AI が失敗したか断ったか（開いたときに自動で作り直さず、「もう一度作る」を出す）。
 */
export type OptionCards = {
  generatedAt: string
  stale: boolean
  retryPaused: boolean
  choose: ChooseCard | null
  combine: CombineCard | null
  create: CreateCard | null
  missing: { kind: CardKind; reason: MissingReason }[]
}

export type OwnJob = { id: string; title: string; note: string | null }

/**
 * 選んだ案。カードは選んだときの中身の写し。abilityExcluded は、カードの力を本人があとで外したか。
 * abilityChanged は、外してはいないが、力の状態か根拠の言葉がいまの記録と合わなくなったか。どちらかなら、理由と力は来ない。
 * outsideConditions は、選んだあとで条件が変わり、いまの条件に収まらなくなったか（中身は選んだときのまま）。
 */
export type OptionChoice = {
  kind: 'card' | 'own' | 'hold'
  at: string
  card: {
    kind: CardKind
    choose: ChooseCard | null
    combine: CombineCard | null
    create: CreateCard | null
    abilityExcluded: boolean
    abilityChanged: boolean
    outsideConditions: boolean
  } | null
  ownJob: OwnJob | null
}

/** 仕事の選択肢の API が返すもの。monthlyIncome は本人の目安（万円）で、null は「まだ決めていない」。 */
export type Options = {
  readiness: Readiness
  cards: OptionCards | null
  ownJobs: OwnJob[]
  choice: OptionChoice | null
  monthlyIncome: number | null
  source: { text: string; url: string }
}

/** 選んだ案。カードは、見ていたカードを作った日時と一緒に送る。 */
export type ChoiceRequest =
  | { kind: 'card'; card: CardKind; generatedAt: string }
  | { kind: 'own'; ownJobId: string }
  | { kind: 'hold' }

async function optionsRequest(path: string, method: string, body?: unknown): Promise<Options> {
  const response = await request(`/api/options${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return (await response.json()) as Options
}

export function getOptions(): Promise<Options> {
  return optionsRequest('', 'GET')
}

/** カードを作る（作り直す）。進めないときは 409、AI が失敗・断ったときは 503（kind 付き）、上限なら 429 の ApiError。 */
export function generateOptions(): Promise<Options> {
  return optionsRequest('', 'POST')
}

/** 選んだ案を置き換える。見ていたカードが作り直されていたら 409 の ApiError。 */
export function putOptionChoice(choice: ChoiceRequest): Promise<Options> {
  return optionsRequest('/choice', 'PUT', choice)
}

/** 選んだ案と保留を外す。 */
export function deleteOptionChoice(): Promise<Options> {
  return optionsRequest('/choice', 'DELETE')
}

export function addOwnJob(job: { title: string; note: string }): Promise<Options> {
  return optionsRequest('/own', 'POST', job)
}

export function updateOwnJob(id: string, job: { title: string; note: string }): Promise<Options> {
  return optionsRequest(`/own/${encodeURIComponent(id)}`, 'PUT', job)
}

export function deleteOwnJob(id: string): Promise<Options> {
  return optionsRequest(`/own/${encodeURIComponent(id)}`, 'DELETE')
}

// ---- 選んだ案を深める ----

/** 深められるか。noChoice は選んだ案がない、hold は保留している、needsConditions は条件が入っていない。 */
export type DeepenReadiness = 'ready' | 'noChoice' | 'hold' | 'needsConditions'
/** 選んだ案の種類。own は本人が書いた仕事。 */
export type TargetKind = CardKind | 'own'

/** 選んだ案。outsideConditions は、選んだカードがいまの条件に収まらなくなったか（本人が書いた仕事はいつも false）。 */
export type DeepenTarget = { kind: TargetKind; title: string; outsideConditions: boolean }

/** 業務 1 つの照らし合わせ。usable がなければ、その業務で使う力はまだ確かめていない。drafted は AI の見立て（本人が直せる）。 */
export type DeepenTask = {
  id: string | null
  name: string
  detail: string
  ability: AbilityKey
  abilityName: string
  usable: { state: 'confirmed' | 'needsCheck'; quotes: Quote[] } | null
  knowledge: string[]
  drafted: boolean
}

export type DeepenAnswer = { text: string; fromChoice: boolean }

/** 仮の場面の問い。答えは考え方として残し、力の確かめには使わない。 */
export type DeepenQuestion = { id: string; situation: string; abilityName: string; choices: string[]; answer: DeepenAnswer | null }

/** 一歩の候補。fits が false のものは、選んだあとで条件が変わって収まらなくなった候補（選んでいたものだけが来る）。 */
export type DeepenStep = { id: string; text: string; hours: number; place: TaskPlace; demandCheck: boolean; fits: boolean; chosen: boolean }

/**
 * 深めた中身。stale は選んだ案が変わって古くなったか（古いときは中身の一覧が空で来る）。
 * retryPaused は、いまの選んだ案で AI が失敗したか断ったか（開いたときに自動で作り直さず、「もう一度作る」を出す）。
 */
export type DeepenContent = {
  generatedAt: string
  stale: boolean
  retryPaused: boolean
  tasks: DeepenTask[]
  tasksRejected: boolean
  questions: DeepenQuestion[]
  steps: DeepenStep[]
  stepsFallback: boolean
  ownSteps: string[]
}

/** 深める API が返すもの。進めないときは target と content が null。まだ深めていなければ content が null。 */
export type Deepen = { readiness: DeepenReadiness; target: DeepenTarget | null; content: DeepenContent | null }

/** 本人が直した業務。knowledge は要る知識や道具（なくてもよい）。 */
export type DeepenTaskRequest = { name: string; detail: string; ability: AbilityKey; knowledge: string }

async function deepenRequest(path: string, method: string, body?: unknown): Promise<Deepen> {
  const response = await request(`/api/deepen${path}`, {
    method,
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  })
  return (await response.json()) as Deepen
}

export function getDeepen(): Promise<Deepen> {
  return deepenRequest('', 'GET')
}

/** 選んだ案を深める（作り直す）。進めないときは 409、AI が失敗・断ったときは 503（kind 付き）、上限なら 429 の ApiError。 */
export function generateDeepen(): Promise<Deepen> {
  return deepenRequest('', 'POST')
}

// 深めた中身の書き換えは、どれも見ていた中身の作った日時（generatedAt）と一緒に送る。
// 選んだ案が変わっていたか、同じ案でも作り直されていたら 409 の ApiError（仕事の選択肢の PUT /api/options/choice と同じやり方）。

/** 業務の見立てを、送った並びに置き換える。 */
export function putDeepenTasks(generatedAt: string, tasks: DeepenTaskRequest[]): Promise<Deepen> {
  return deepenRequest('/tasks', 'PUT', { tasks, generatedAt })
}

/** 問いの答えを置き換える。 */
export function putDeepenAnswer(generatedAt: string, questionId: string, answer: DeepenAnswer): Promise<Deepen> {
  return deepenRequest(`/answers/${encodeURIComponent(questionId)}`, 'PUT', { ...answer, generatedAt })
}

/** 選んだ候補と、書いた一歩を置き換える（どちらも空でよい）。 */
export function putDeepenSteps(generatedAt: string, steps: { chosen: string[]; own: string[] }): Promise<Deepen> {
  return deepenRequest('/steps', 'PUT', { ...steps, generatedAt })
}
