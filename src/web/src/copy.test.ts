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

  it('validate-8（訂正したら確かめ直す）: 訂正の欄の例は、足す向きを先に、取り下げる向きと並べる', () => {
    // 取り下げる向きの例だけだと、自分の手柄を減らすための欄に見え、自分を低く言う方へ誘いやすい
    const [adding, withdrawing] = copy.insights.correctPlaceholder.replace(/^例: /, '').split('／')
    expect(adding).toMatch(/私です$/)
    expect(withdrawing).toContain('私ではなく')
  })

  it('options-1（3 枚を同じ重さで示す）: 出せないカードの言葉は、本人の話や条件のせいにせず、登録している業務の少なさやアプリの側に置く', () => {
    const { missing } = copy.options
    // 照らし合わせに通らなかったのは AI の書いた中身のため。話や記録が足りなかったように読ませない
    expect(missing.rejected).not.toMatch(/話を足|記録を直/)
    // 条件に合わないときも、条件を広げるよう促さず、登録している業務の少なさを先に伝える
    expect(missing.noFit).toContain('登録している業務はまだ少ない')
    expect(missing.noFit).not.toContain('条件を直')
    expect(missing.noAbilityMatch).toContain('登録している業務はまだ少ない')
  })

  it('validate-12（本人が見立てを外せる）: 見えた力の前置きは、読み取りを直せることを、外す・戻すより先に伝える', () => {
    const lead = copy.abilities.lead
    expect(lead).toContain('直せます')
    expect(lead.indexOf('直せます')).toBeLessThan(lead.indexOf('外したり戻したり'))
  })

  it('common-1（使わない言葉を出さない）: 照らし合わせは使わない言葉を見つけられる', () => {
    const texts = flatten({ a: ['あなたの診断結果'] })
    expect(forbiddenWords.some((word) => texts.some((text) => text.includes(word)))).toBe(true)
  })
})
