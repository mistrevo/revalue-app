/** 裏側の API の呼び出し。エラーは ProblemDetails（決まった形の JSON）から ApiError にする。 */

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
} as const

export class ApiError extends Error {
  readonly status: number
  readonly type?: string
  readonly resetAt?: string

  constructor(status: number, type?: string, resetAt?: string) {
    super(`API error ${status}${type ? ` (${type})` : ''}`)
    this.name = 'ApiError'
    this.status = status
    this.type = type
    this.resetAt = resetAt
  }
}

export function isDailyLimit(e: unknown): e is ApiError {
  return e instanceof ApiError && (e.type === PROBLEM_TYPES.dailyLimit || e.status === 429)
}

async function toApiError(response: Response): Promise<ApiError> {
  let type: string | undefined
  let resetAt: string | undefined
  try {
    const body: unknown = await response.json()
    if (body !== null && typeof body === 'object') {
      const problem = body as Record<string, unknown>
      if (typeof problem.type === 'string') type = problem.type
      if (typeof problem.resetAt === 'string') resetAt = problem.resetAt
    }
  } catch {
    // 本文が JSON でなければ、状態コードだけで見分ける
  }
  return new ApiError(response.status, type, resetAt)
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
