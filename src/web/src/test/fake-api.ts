import { vi } from 'vitest'
import type { Abilities, Episode, EpisodeInsights, EpisodeSummary, Profile, ProfileConditions, ProfileEntry, Turn } from '@/api'

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
export const FAKE_WANT_CHOICES = ['家にいながらできることを始めたい', '人の役に立つことをしたい', '新しいことを覚えたい']

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
    conditionOptions: { hoursPerWeek: [3, 5, 10, 15, 20, 30, 40], monthlyIncome: [1, 3, 5, 8, 10, 15, 20] },
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
export function installFakeApi(initial: { loggedIn: boolean; consented: boolean; episodes?: Episode[]; profile?: Profile }) {
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
      return new Response(null, { status: 204 })
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
