import { describe, expect, it } from 'vitest'
import { hasVisibleText } from './text'

describe('hasVisibleText', () => {
  it('profile-4（本人が直せる）: 空白、幅のない空白、制御文字、結合文字、埋め字だけの言葉には、見える文字がない', () => {
    for (const invisible of ['', ' ', '\u3000', '\u200B', ' \u200B\u3000', '\u200C\u200D\u2060', '\uFEFF', '\u0001', '\u0301', '\u3164', '\u2800', '\u115F\u1160\uFFA0']) {
      expect(hasVisibleText(invisible)).toBe(false)
    }
  })

  it('profile-4（本人が直せる）: 文字、数字、句読点、記号が一つでもあれば、見える文字がある', () => {
    for (const visible of ['朝', 'a', '3', '！', '〜', '😀', '家族で👨\u200D👩\u200D👧', '\u200B朝\u200B', 'か\u3099']) {
      expect(hasVisibleText(visible)).toBe(true)
    }
  })
})
