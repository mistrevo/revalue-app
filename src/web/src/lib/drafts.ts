/**
 * 書きかけの答えを、場面ごとにその端末のブラウザへ残す（サーバーへは送らない）。
 * どれも、保存できないブラウザで例外を投げない。
 */
export const DRAFT_PREFIX = 'revalue.draft.'

/** 場面の書きかけを読む。なければ空の文字。 */
export function readDraft(episodeId: string): string {
  try {
    return localStorage.getItem(DRAFT_PREFIX + episodeId) ?? ''
  } catch {
    return ''
  }
}

/** 書きかけを残す。空白だけなら消す。 */
export function writeDraft(episodeId: string, text: string): void {
  if (text.trim() === '') {
    clearDraft(episodeId)
    return
  }
  try {
    localStorage.setItem(DRAFT_PREFIX + episodeId, text)
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

/** 書きかけを全部消す。ほかの保存（選んだ色）は消さない。 */
export function clearAllDrafts(): void {
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key)
    }
    for (const key of keys) localStorage.removeItem(key)
  } catch {
    // 消せなくても画面は止めない
  }
}
