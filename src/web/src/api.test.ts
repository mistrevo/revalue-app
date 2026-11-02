import { afterEach, describe, expect, it, vi } from 'vitest'
import { ApiError, deleteMe, getMe, isDailyLimit, LOGIN_URL, LOGOUT_URL, postConsent } from './api'

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
})
