import { contrastRatio } from './contrast'
import {
  PALETTES,
  PALETTE_KEYS,
  PALETTE_STORAGE_KEY,
  applyPalette,
  readPalette,
  startPalette,
  writePalette,
} from './palette'

const TEXT_PAIRS = [
  ['text', 'ground'],
  ['text', 'surface'],
  ['text', 'field'],
  ['muted', 'ground'],
  ['muted', 'surface'],
  ['onTint', 'tint'],
  ['onAccent', 'accent'],
  ['accent', 'surface'],
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
