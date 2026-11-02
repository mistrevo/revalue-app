import { vi } from 'vitest'

export type FakeCall = { method: string; url: string; body?: unknown }

/** 裏側の API の代わり。ログインと了解の状態を持ち、呼ばれた順に記録する。 */
export function installFakeApi(initial: { loggedIn: boolean; consented: boolean }) {
  const state = { ...initial }
  const calls: FakeCall[] = []
  const currentVersion = '2026-11-02'

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

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
      return new Response(null, { status: 204 })
    }
    return json(404, { status: 404 })
  })

  vi.stubGlobal('fetch', fetchMock)
  return { state, calls, currentVersion, fetchMock }
}
