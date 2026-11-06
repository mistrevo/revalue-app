/**
 * 書きかけの答えを、場面ごとにその端末のブラウザへ残す（サーバーへは送らない）。
 * 書いた時刻を添えて残し、最後に書いてから DRAFT_MAX_AGE_DAYS 日を過ぎたものは捨てる。サーバーのデータが保存期間で消えたあとや、
 * 家族と共用する端末で、打ち明けかけた文がいつまでも残らないようにするため（Claude の判断）。
 * どれも、保存できないブラウザで例外を投げない。
 */
export const DRAFT_PREFIX = 'revalue.draft.'

/** 書きかけを残す日数。サーバーの保存期間（最後に使った日から 30 日）にそろえる（Claude の判断）。 */
export const DRAFT_MAX_AGE_DAYS = 30

const MAX_AGE_MS = DRAFT_MAX_AGE_DAYS * 24 * 60 * 60 * 1000

type Stored = { text: string; at: number }

/** 残した形を読む。書いた時刻の分からないものや、期限を過ぎたものは null。 */
function parse(raw: string | null, now: number): Stored | null {
  if (raw === null) return null
  try {
    const value = JSON.parse(raw) as unknown
    if (value === null || typeof value !== 'object') return null
    const { text, at } = value as { text?: unknown; at?: unknown }
    if (typeof text !== 'string' || typeof at !== 'number' || !Number.isFinite(at)) return null
    return now - at > MAX_AGE_MS ? null : { text, at }
  } catch {
    return null
  }
}

/** 場面の書きかけを読む。なければ空の文字。期限を過ぎたものや読めないものは、捨てて空の文字を返す。 */
export function readDraft(episodeId: string): string {
  try {
    const raw = localStorage.getItem(DRAFT_PREFIX + episodeId)
    const stored = parse(raw, Date.now())
    if (stored === null && raw !== null) clearDraft(episodeId)
    return stored?.text ?? ''
  } catch {
    return ''
  }
}

/** 書きかけを、書いた時刻と一緒に残す。空白だけなら消す。 */
export function writeDraft(episodeId: string, text: string): void {
  if (text.trim() === '') {
    clearDraft(episodeId)
    return
  }
  try {
    const stored: Stored = { text, at: Date.now() }
    localStorage.setItem(DRAFT_PREFIX + episodeId, JSON.stringify(stored))
  } catch {
    // 保存できないブラウザでは、残らないだけ
  }
}

export function clearDraft(episodeId: string): void {
  try {
    localStorage.removeItem(DRAFT_PREFIX + episodeId)
  } catch {
    // 消せなくても画面は止めない
  }
}

/** 書きかけの鍵をすべて集める。 */
function draftKeys(): string[] {
  const keys: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key?.startsWith(DRAFT_PREFIX)) keys.push(key)
  }
  return keys
}

/** 書きかけを全部消す。ほかの保存（選んだ色）は消さない。 */
export function clearAllDrafts(): void {
  try {
    for (const key of draftKeys()) localStorage.removeItem(key)
  } catch {
    // 消せなくても画面は止めない
  }
}

/**
 * 期限を過ぎた書きかけと読めない書きかけを、すべての場面から捨てる。アプリを開いたときに呼ぶ。
 * もう開かない場面（保存期間で消えた場面など）の書きかけも、端末に残し続けないため。
 */
export function pruneExpiredDrafts(): void {
  try {
    const now = Date.now()
    for (const key of draftKeys()) {
      if (parse(localStorage.getItem(key), now) === null) localStorage.removeItem(key)
    }
  } catch {
    // 捨てられなくても画面は止めない
  }
}
