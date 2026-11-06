/**
 * 色の置き場所はここだけ。起動時に `document.documentElement` へ CSS 変数 `--rv-*` として書き込む。
 * 選んだ色は、その端末のブラウザにだけ残す（サーバーへは送らない）。
 */
export const PALETTE_KEYS = ['teal', 'rose', 'green', 'blue', 'orange', 'purple'] as const
export type PaletteKey = (typeof PALETTE_KEYS)[number]

export type PaletteTokens = {
  ground: string
  surface: string
  text: string
  muted: string
  border: string
  accent: string
  onAccent: string
  tint: string
  onTint: string
  tile: string
  chip: string
  field: string
  fieldBorder: string
  /** 取り消せない操作（全部消す）のボタンの文字と枠 / マウスを載せたときの、その上の文字。6 色で同じ値（Claude の判断） */
  danger: string
  onDanger: string
}

export const PALETTE_STORAGE_KEY = 'revalue.palette'
const DEFAULT_PALETTE: PaletteKey = 'teal'

/** 全部消すボタンの色。どの色を選んでも同じ赤にする（Claude の判断）。 */
const DANGER = {
  light: { danger: '#B42318', onDanger: '#FFFFFF' },
  dark: { danger: '#FFB4AB', onDanger: '#690005' },
} as const

export const PALETTES: Record<PaletteKey, { name: string; light: PaletteTokens; dark: PaletteTokens }> = {
  teal: {
    name: 'あおみどり',
    light: {
      ground: '#F2F4F1', surface: '#FFFFFF', text: '#262A2B', muted: '#5B6265', border: '#E1E5E2',
      accent: '#1F7A6E', onAccent: '#FFFFFF', tint: '#DCEFEA', onTint: '#1B3B36', tile: '#EEF5F2',
      chip: '#E4E9E6', field: '#F7F9F8', fieldBorder: '#8B9092',
      ...DANGER.light,
    },
    dark: {
      ground: '#121517', surface: '#22272A', text: '#E4E7E5', muted: '#A3ABA8', border: '#2A2F31',
      accent: '#6CCBBB', onAccent: '#0F2420', tint: '#1D3B36', onTint: '#DDEFEA', tile: '#1B2A27',
      chip: '#2B3134', field: '#1A1F21', fieldBorder: '#7D8785',
      ...DANGER.dark,
    },
  },
  rose: {
    name: 'さくら',
    light: {
      ground: '#F8F3F3', surface: '#FFFFFF', text: '#2E2627', muted: '#6A5A5D', border: '#EBDDDF',
      accent: '#B4475A', onAccent: '#FFFFFF', tint: '#FBE4E8', onTint: '#5A1F2B', tile: '#FBEEF0',
      chip: '#EFE4E5', field: '#FBF7F7', fieldBorder: '#978C8E',
      ...DANGER.light,
    },
    dark: {
      ground: '#171213', surface: '#2A2224', text: '#EBE4E5', muted: '#B3A5A8', border: '#352C2E',
      accent: '#EE8FA0', onAccent: '#2E0F16', tint: '#45222B', onTint: '#F8DDE2', tile: '#2F2022',
      chip: '#352C2E', field: '#201819', fieldBorder: '#8E7F82',
      ...DANGER.dark,
    },
  },
  green: {
    name: 'わかば',
    light: {
      ground: '#F3F6F0', surface: '#FFFFFF', text: '#262B24', muted: '#56604F', border: '#DEE6D9',
      accent: '#3A7D2C', onAccent: '#FFFFFF', tint: '#E3F1DC', onTint: '#1F3D18', tile: '#EDF4E8',
      chip: '#E3EADF', field: '#F7FAF5', fieldBorder: '#8A9186',
      ...DANGER.light,
    },
    dark: {
      ground: '#131712', surface: '#232922', text: '#E5E9E3', muted: '#A5AEA0', border: '#2D342B',
      accent: '#8FD27C', onAccent: '#14260F', tint: '#243A1F', onTint: '#E0F1DA', tile: '#1D2A1A',
      chip: '#2D342B', field: '#1B2019', fieldBorder: '#80897B',
      ...DANGER.dark,
    },
  },
  blue: {
    name: 'そら',
    light: {
      ground: '#F2F5F9', surface: '#FFFFFF', text: '#242A33', muted: '#545F6E', border: '#DCE3EC',
      accent: '#2F5D9E', onAccent: '#FFFFFF', tint: '#E1EAF7', onTint: '#1A2F52', tile: '#EAF0F9',
      chip: '#E1E7EF', field: '#F6F8FB', fieldBorder: '#878F9A',
      ...DANGER.light,
    },
    dark: {
      ground: '#12151A', surface: '#222830', text: '#E3E7EC', muted: '#A2ACB9', border: '#2B323C',
      accent: '#8DB4EE', onAccent: '#0E1B31', tint: '#1F3250', onTint: '#DDE8F8', tile: '#1B2433',
      chip: '#2B323C', field: '#191E25', fieldBorder: '#7A8493',
      ...DANGER.dark,
    },
  },
  orange: {
    name: 'みかん',
    light: {
      ground: '#FAF6F0', surface: '#FFFFFF', text: '#2E2924', muted: '#665B4E', border: '#EADFD1',
      accent: '#B05A00', onAccent: '#FFFFFF', tint: '#FCEBD5', onTint: '#5A3200', tile: '#FBF0E2',
      chip: '#EFE7DC', field: '#FBF8F4', fieldBorder: '#958E85',
      ...DANGER.light,
    },
    dark: {
      ground: '#171412', surface: '#2A2521', text: '#EDE7E1', muted: '#B5AA9D', border: '#352F29',
      accent: '#F0A55A', onAccent: '#301A00', tint: '#47301A', onTint: '#F9E6CF', tile: '#2F2519',
      chip: '#352F29', field: '#201C19', fieldBorder: '#8D8478',
      ...DANGER.dark,
    },
  },
  purple: {
    name: 'ふじ',
    light: {
      ground: '#F6F4F9', surface: '#FFFFFF', text: '#29262F', muted: '#5E5A68', border: '#E2DCEC',
      accent: '#6A4FA3', onAccent: '#FFFFFF', tint: '#ECE6F6', onTint: '#33245A', tile: '#F0ECF7',
      chip: '#E7E2EF', field: '#F9F8FB', fieldBorder: '#908D97',
      ...DANGER.light,
    },
    dark: {
      ground: '#141217', surface: '#25222B', text: '#E8E5ED', muted: '#AAA5B6', border: '#302C38',
      accent: '#B7A0EA', onAccent: '#1D1235', tint: '#33284D', onTint: '#E8DFF8', tile: '#241F30',
      chip: '#302C38', field: '#1C191F', fieldBorder: '#847F90',
      ...DANGER.dark,
    },
  },
}

function isPaletteKey(value: unknown): value is PaletteKey {
  return typeof value === 'string' && (PALETTE_KEYS as readonly string[]).includes(value)
}

/** 選んだ色を読む。読めない、知らない値なら、あおみどり。 */
export function readPalette(): PaletteKey {
  try {
    const value = localStorage.getItem(PALETTE_STORAGE_KEY)
    return isPaletteKey(value) ? value : DEFAULT_PALETTE
  } catch {
    return DEFAULT_PALETTE
  }
}

/** 選んだ色を残す。保存できなくても投げない。 */
export function writePalette(key: PaletteKey): void {
  try {
    localStorage.setItem(PALETTE_STORAGE_KEY, key)
  } catch {
    // 保存できないブラウザでは、残らないだけ
  }
}

const CSS_NAMES: Record<keyof PaletteTokens, string> = {
  ground: 'ground',
  surface: 'surface',
  text: 'text',
  muted: 'muted',
  border: 'border',
  accent: 'accent',
  onAccent: 'on-accent',
  tint: 'tint',
  onTint: 'on-tint',
  tile: 'tile',
  chip: 'chip',
  field: 'field',
  fieldBorder: 'field-border',
  danger: 'danger',
  onDanger: 'on-danger',
}

/** 画面の変数と、色・明るさの印（`data-palette`、`data-scheme`）を書く。 */
export function applyPalette(key: PaletteKey, dark: boolean): void {
  const root = document.documentElement
  const tokens = PALETTES[key][dark ? 'dark' : 'light']
  for (const name of Object.keys(CSS_NAMES) as (keyof PaletteTokens)[]) {
    root.style.setProperty(`--rv-${CSS_NAMES[name]}`, tokens[name])
  }
  root.dataset.palette = key
  root.dataset.scheme = dark ? 'dark' : 'light'
  root.style.colorScheme = dark ? 'dark' : 'light'
}

/** いま当てている色。保存できないブラウザでも、その場の選択で当て直せるように覚えておく。 */
let current: PaletteKey | null = null
let currentDark = false

/** いまの色。まだ当てていなければ、保存した色。 */
export function currentPalette(): PaletteKey {
  return current ?? readPalette()
}

/** 色を選ぶ。残したうえで、いまの端末の設定（暗いか）で当てる。保存できなくても、その場では変わる。 */
export function choosePalette(key: PaletteKey): void {
  writePalette(key)
  current = key
  applyPalette(key, currentDark)
}

/** 選んだ色を読み、端末の設定（明るい・暗い）に合わせて当てる。設定が変わったら、選んだ色で当て直す。戻り値は解除。 */
export function startPalette(): () => void {
  current = readPalette()
  const query = typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null
  if (!query) {
    currentDark = false
    applyPalette(current, false)
    return () => {}
  }
  const apply = (event?: { matches: boolean }) => {
    currentDark = event ? event.matches : query.matches
    applyPalette(current ?? readPalette(), currentDark)
  }
  apply()
  query.addEventListener('change', apply)
  return () => query.removeEventListener('change', apply)
}
