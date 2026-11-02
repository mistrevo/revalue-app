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
} as const

export class ApiError extends Error {
  readonly status: number
  readonly type?: string
  readonly resetAt?: string
  /** 途中の場面があって新しく始められないとき（409）の、その場面の id。 */
  readonly episodeId?: string
  /** AI が失敗したか断ったとき（503）の、どちらだったか。 */
  readonly kind?: 'failure' | 'refusal'

  constructor(status: number, type?: string, resetAt?: string, episodeId?: string, kind?: 'failure' | 'refusal') {
    super(`API error ${status}${type ? ` (${type})` : ''}`)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.resetAt = resetAt
    this.episodeId = episodeId
    this.kind = kind
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
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object') {
      const problem = body as Record<string, unknown>
      if (typeof problem.type === 'string') type = problem.type
      if (typeof problem.resetAt === 'string') resetAt = problem.resetAt
      if (typeof problem.episodeId === 'string') episodeId = problem.episodeId
      if (problem.kind === 'failure' || problem.kind === 'refusal') kind = problem.kind
    }
  } catch {
    // 本文が JSON でなければ、状態コードだけで見分ける
  }
  return new ApiError(response.status, type, resetAt, episodeId, kind)
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
