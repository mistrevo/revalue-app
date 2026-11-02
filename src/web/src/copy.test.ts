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

  it('discover-7（返答が少しずつ流れる）: AI が断ったときの言葉は、答えや書き方のせいにせず、飛ばす道も示す', () => {
    // 断られるのは、話しにくいことを打ち明けたときに起こりやすい。打ち明けた言葉を突き返さない
    expect(copy.talk.refusal).not.toMatch(/この答え|言い方|書き方/)
    expect(copy.talk.refusal).toContain('そのまま残しています')
    expect(copy.talk.refusal).toContain(`「${copy.talk.skip}」`)
  })

  it('discover-5（つらい話は飛ばせる）: 飛ばす前の確かめに「消す」を使わない', () => {
    // つらい状態のサインのあとにも出る確かめなので、「消えたい」と書いた人に「消して」を重ねない
    expect(copy.talk.skipQuestion).not.toContain('消')
    expect(copy.talk.skipYes).not.toContain('消')
  })

  it('validate-6（否定の言葉を使わない）: copy.ts に状態の呼び名（根拠あり、要確認、未確認）がない', () => {
    const texts = flatten(copy)
    const found = ['根拠あり', '要確認', '未確認'].flatMap((word) =>
      texts.filter((text) => text.includes(word)).map((text) => `${word}: ${text}`),
    )
    expect(found).toEqual([])
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 見えたことの前置きは、直す道としてボタンの言葉をそのまま示す', () => {
    expect(copy.insights.lead).toContain(`「${copy.insights.correct}」`)
  })

  it('common-1（使わない言葉を出さない）: 照らし合わせは使わない言葉を見つけられる', () => {
    const texts = flatten({ a: ['あなたの診断結果'] })
    expect(forbiddenWords.some((word) => texts.some((text) => text.includes(word)))).toBe(true)
  })
})
