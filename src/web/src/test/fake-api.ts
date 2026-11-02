import { vi } from 'vitest'
import type { Episode, EpisodeSummary } from '@/api'

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
    ...overrides,
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
export function installFakeApi(initial: { loggedIn: boolean; consented: boolean; episodes?: Episode[] }) {
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
      return new Response(null, { status: 204 })
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

    const match = /^\/api\/episodes\/([^/]+)(?:\/(finish|skip|messages))?$/.exec(url)
    const episode = match ? state.episodes.find((e) => e.id === decodeURIComponent(match[1])) : undefined
    if (match && !episode) {
      return json(404, { type: '/problems/not-found', status: 404 })
    }
    if (match && episode) {
      const action = match[2]
      if (!action && method === 'GET') return json(200, episode)
      if (action === 'finish' && method === 'POST') {
        episode.status = 'finished'
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
        return sseResponse(state.reply)
      }
    }
    return json(404, { status: 404 })
  })

  vi.stubGlobal('fetch', fetchMock)
  return { state, calls, streams, currentVersion, fetchMock }
}
