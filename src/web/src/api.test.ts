import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ApiError,
  createEpisode,
  deleteMe,
  getMe,
  isDailyLimit,
  LOGIN_URL,
  LOGOUT_URL,
  postConsent,
  sendAnswer,
} from './api'

function jsonResponse(status: number, body: unknown, contentType = 'application/json'): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': contentType } })
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(response)
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('api', () => {
  it('foundation-1（案内はログインなしで見られる）: getMe は 401 なら null を返す', async () => {
    mockFetch(
      jsonResponse(401, { type: '/problems/login-required', status: 401 }, 'application/problem+json'),
    )
    await expect(getMe()).resolves.toBeNull()
  })

  it('foundation-2（始める前に保存するものを示す）: getMe は 200 なら了解の状態を返す', async () => {
    const fetchMock = mockFetch(
      jsonResponse(200, { consented: false, consentVersion: null, currentVersion: '2026-11-02' }),
    )
    await expect(getMe()).resolves.toEqual({
      consented: false,
      consentVersion: null,
      currentVersion: '2026-11-02',
    })
    expect(fetchMock).toHaveBeenCalledWith('/api/me', expect.anything())
  })

  it('foundation-2（始める前に保存するものを示す）: postConsent は版を送る', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }))
    await postConsent('2026-11-02')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/consent')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ version: '2026-11-02' })
  })

  it('foundation-3（いつでも全部消せる）: deleteMe は DELETE /api/me を呼ぶ', async () => {
    const fetchMock = mockFetch(new Response(null, { status: 204 }))
    await deleteMe()
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/me')
    expect(init?.method).toBe('DELETE')
  })

  it('foundation-6（使いすぎを穏やかに止める）: 429 の ProblemDetails で ApiError を投げ、次の時刻が入る', async () => {
    mockFetch(
      jsonResponse(
        429,
        { type: '/problems/daily-limit', status: 429, resetAt: '2026-11-03T00:00:00+09:00' },
        'application/problem+json',
      ),
    )
    const error = await postConsent('2026-11-02').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(isDailyLimit(error)).toBe(true)
    expect((error as ApiError).status).toBe(429)
    expect((error as ApiError).resetAt).toBe('2026-11-03T00:00:00+09:00')
  })

  it('foundation-6（使いすぎを穏やかに止める）: 上限以外のエラーは上限と見なさない', async () => {
    mockFetch(jsonResponse(500, { status: 500 }, 'application/problem+json'))
    const error = await deleteMe().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect(isDailyLimit(error)).toBe(false)
    expect(isDailyLimit(new Error('x'))).toBe(false)
  })

  it('foundation-1（案内はログインなしで見られる）: ログインとログアウトは組み込み認証の URL', () => {
    expect(LOGIN_URL).toBe('/.auth/login/google?post_login_redirect_uri=/start')
    expect(LOGOUT_URL).toBe('/.auth/logout?post_logout_redirect_uri=/')
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面があって始められないとき、その場面の id が分かる', async () => {
    mockFetch(
      jsonResponse(
        409,
        { type: '/problems/episode-in-progress', status: 409, episodeId: 'episode-abc' },
        'application/problem+json',
      ),
    )
    const error = await createEpisode().catch((e: unknown) => e)
    expect(error).toBeInstanceOf(ApiError)
    expect((error as ApiError).status).toBe(409)
    expect((error as ApiError).episodeId).toBe('episode-abc')
  })

  it('discover-7（返答が少しずつ流れる）: sendAnswer は答えを送り、届いた順にイベントを渡す', async () => {
    const sse = [
      'event: delta\ndata: {"text":"受け止め"}\n\n',
      'event: delta\ndata: {"text":"ました"}\n\n',
      'event: choices\ndata: {"choices":["a","b","c"]}\n\n',
      'event: done\ndata: {"userTurnCount":1,"status":"talking","move":"askWhatYouDid"}\n\n',
    ].join('')
    const fetchMock = mockFetch(new Response(sse, { headers: { 'Content-Type': 'text/event-stream' } }))
    const seen: string[] = []

    await sendAnswer('episode-1', { text: '昨日のこと', kind: 'choice' }, {
      onDelta: (text) => seen.push(`delta:${text}`),
      onChoices: (choices) => seen.push(`choices:${choices.join(',')}`),
      onNotice: () => seen.push('notice'),
      onDone: (done) => seen.push(`done:${done.status}:${done.move}`),
      onError: (kind) => seen.push(`error:${kind}`),
    })

    expect(seen).toEqual(['delta:受け止め', 'delta:ました', 'choices:a,b,c', 'done:talking:askWhatYouDid'])
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/episodes/episode-1/messages')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ text: '昨日のこと', kind: 'choice' })
  })

  it('discover-7（返答が少しずつ流れる）: 終わりの知らせがないまま流れが切れたら、失敗として知らせる', async () => {
    mockFetch(
      new Response('event: delta\ndata: {"text":"途中"}\n\n', { headers: { 'Content-Type': 'text/event-stream' } }),
    )
    const errors: string[] = []
    await sendAnswer('episode-1', { text: 'x', kind: 'free' }, {
      onDelta: () => {},
      onChoices: () => {},
      onNotice: () => {},
      onDone: () => {},
      onError: (kind) => errors.push(kind),
    })
    expect(errors).toEqual(['failure'])
  })

  it('foundation-6（使いすぎを穏やかに止める）: sendAnswer は 429 で上限の ApiError を投げる', async () => {
    mockFetch(
      jsonResponse(
        429,
        { type: '/problems/daily-limit', status: 429, resetAt: '2026-11-04T00:00:00+09:00' },
        'application/problem+json',
      ),
    )
    const noop = () => {}
    const error = await sendAnswer('episode-1', { text: 'x', kind: 'free' }, {
      onDelta: noop,
      onChoices: noop,
      onNotice: noop,
      onDone: noop,
      onError: noop,
    }).catch((e: unknown) => e)
    expect(isDailyLimit(error)).toBe(true)
  })
})
