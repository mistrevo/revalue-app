import { describe, expect, it } from 'vitest'
import forbiddenWords from '../../shared/forbidden-words.json'
import { copy } from './copy'

/** 文言の木をたどって、文字列をすべて取り出す。 */
function flatten(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(flatten)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(flatten)
  return []
}

describe('copy', () => {
  it('common-1（使わない言葉を出さない）: copy.ts に使わない言葉がない', () => {
    const texts = flatten(copy)
    expect(texts.length).toBeGreaterThan(0)
    expect(forbiddenWords.length).toBeGreaterThan(0)

    const found = forbiddenWords.flatMap((word) =>
      texts.filter((text) => text.includes(word)).map((text) => `${word}: ${text}`),
    )
    expect(found).toEqual([])
  })

  it('common-1（使わない言葉を出さない）: 照らし合わせは使わない言葉を見つけられる', () => {
    const texts = flatten({ a: ['あなたの診断結果'] })
    expect(forbiddenWords.some((word) => texts.some((text) => text.includes(word)))).toBe(true)
  })
})
