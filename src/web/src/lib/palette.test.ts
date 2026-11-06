import { contrastRatio } from './contrast'
import {
  PALETTES,
  PALETTE_KEYS,
  PALETTE_STORAGE_KEY,
  applyPalette,
  choosePalette,
  readPalette,
  startPalette,
  writePalette,
} from './palette'

/** 画面で使っている文字と地の組。部品で新しい組を使うときは、ここと 00-common.md の「見た目」に足す。 */
const TEXT_PAIRS = [
  ['text', 'ground'],
  ['text', 'surface'],
  ['text', 'field'],
  // メニュー板のタイルの言葉
  ['text', 'tile'],
  ['muted', 'ground'],
  ['muted', 'surface'],
  // 見えた力のカードの中の、行動の文と「（選んだ答え）」。入力欄の例の文字
  ['muted', 'field'],
  // 日付の札（DateChip）と、目立たせないボタンに重ねたときの地
  ['muted', 'chip'],
  ['onTint', 'tint'],
  ['onAccent', 'accent'],
  ['accent', 'surface'],
  // 案内の名前「RE:VALUE」
  ['accent', 'ground'],
] as const
const UI_PAIRS = [
  ['fieldBorder', 'field'],
  ['fieldBorder', 'surface'],
  ['accent', 'tint'],
  ['accent', 'tile'],
] as const

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

describe.each(PALETTE_KEYS)('%s', (key) => {
  it.each(['light', 'dark'] as const)(
    'common-5（どの色でも読める）: %s の文字は 4.5 以上、入力欄の枠とアイコンは 3 以上',
    (scheme) => {
      const t = PALETTES[key][scheme]
      for (const [a, b] of TEXT_PAIRS) expect(contrastRatio(t[a], t[b]), `${a}/${b}`).toBeGreaterThanOrEqual(4.5)
      for (const [a, b] of UI_PAIRS) expect(contrastRatio(t[a], t[b]), `${a}/${b}`).toBeGreaterThanOrEqual(3)
    },
  )
})

describe('palette', () => {
  it('common-5（どの色でも読める）: 明るい画面のあおみどりはモックの値', () => {
    expect(PALETTES.teal.light).toMatchObject({ ground: '#F2F4F1', accent: '#1F7A6E', tint: '#DCEFEA', tile: '#EEF5F2' })
    expect(PALETTES.teal.name).toBe('あおみどり')
  })

  it('common-5（どの色でも読める）: 保存できないブラウザでも、いつもの色で出る', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(readPalette()).toBe('teal')
    expect(() => writePalette('rose')).not.toThrow()
  })

  it('common-5（どの色でも読める）: 知らない値が残っていたら、いつもの色', () => {
    localStorage.setItem(PALETTE_STORAGE_KEY, 'gold')
    expect(readPalette()).toBe('teal')
  })

  it('common-5（どの色でも読める）: 選んだ色は書いて読み直せる', () => {
    writePalette('purple')
    expect(readPalette()).toBe('purple')
  })

  it('common-5（どの色でも読める）: 当てた色と暗さが、画面の変数と印に出る', () => {
    applyPalette('rose', true)
    const root = document.documentElement
    expect(root.dataset.palette).toBe('rose')
    expect(root.dataset.scheme).toBe('dark')
    expect(root.style.getPropertyValue('--rv-accent')).toBe(PALETTES.rose.dark.accent)
  })

  it('common-5（どの色でも読める）: 端末の設定を読めない（matchMedia がない）ときは明るい画面', () => {
    vi.stubGlobal('matchMedia', undefined)
    const stop = startPalette()
    expect(document.documentElement.dataset.scheme).toBe('light')
    stop()
  })

  it('common-5（どの色でも読める）: 端末の設定が暗いと暗い画面になり、変わると当て直す', () => {
    let listener: (() => void) | null = null
    const mql = {
      matches: true,
      addEventListener: (_: string, l: () => void) => {
        listener = l
      },
      removeEventListener: () => {
        listener = null
      },
    }
    vi.stubGlobal('matchMedia', () => mql)
    const stop = startPalette()
    expect(document.documentElement.dataset.scheme).toBe('dark')
    mql.matches = false
    listener!()
    expect(document.documentElement.dataset.scheme).toBe('light')
    stop()
    expect(listener).toBeNull()
  })
})

describe('choosePalette', () => {
  it('common-5（どの色でも読める）: 選んだ色は、端末を暗い画面に切り替えても選んだ色の暗い値になる', () => {
    let listener: ((e: { matches: boolean }) => void) | null = null
    const mql = {
      matches: false,
      addEventListener: (_: string, l: typeof listener) => {
        listener = l
      },
      removeEventListener: () => {},
    }
    vi.stubGlobal('matchMedia', () => mql)
    const stop = startPalette()
    choosePalette('blue')
    listener!({ matches: true })
    expect(document.documentElement.style.getPropertyValue('--rv-accent')).toBe(PALETTES.blue.dark.accent)
    stop()
  })

  it('common-5（どの色でも読める）: 選んだ色はこの端末に残り、開き直すと選んだ色で出る', () => {
    choosePalette('rose')
    expect(readPalette()).toBe('rose')
    const stop = startPalette()
    expect(document.documentElement.dataset.palette).toBe('rose')
    stop()
  })

  it('common-5（どの色でも読める）: 保存できないブラウザでも、選んだ色にその場で変わる', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => choosePalette('purple')).not.toThrow()
    expect(document.documentElement.dataset.palette).toBe('purple')
    spy.mockRestore()
  })
})
