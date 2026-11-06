import { buttonVariants } from '@/components/ui/button'

/**
 * 画面の部品の色の書き方を、ソースから確かめる。文字と地の組は 00-common.md の「見た目」で確かめた組から選ぶ。
 * 色を薄めた地（`bg-primary/10` など）は、確かめた組にない色を作ってしまう。
 */
const sources = import.meta.glob(['../**/*.tsx', '../**/*.ts', '!../**/*.test.tsx', '!../**/*.test.ts'], {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const VARIANTS = ['default', 'outline', 'secondary', 'ghost', 'destructive', 'link'] as const

describe('色の書き方', () => {
  it('common-5（どの色でも読める）: accent を薄めた地（bg-primary/NN）を作らない。accent の文字を載せると 4.5 に届かない色がある', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(10)
    const found = Object.entries(sources).flatMap(([file, text]) =>
      [...text.matchAll(/[\w:[\]-]*bg-primary\/\d+/g)].map((m) => `${file}: ${m[0]}`),
    )
    expect(found).toEqual([])
  })

  it.each(VARIANTS)('common-5（どの色でも読める）: %s のボタンは、マウスを載せたときも、地を薄めたり混ぜたりしない', (variant) => {
    const classes = buttonVariants({ variant }).split(/\s+/)
    // ring（押す前に選んだ印）は文字の地ではないので見ない
    const grounds = classes.filter((c) => /(^|:)bg-/.test(c))
    expect(grounds.filter((c) => /bg-[\w-]+\/\d+|bg-\[/.test(c))).toEqual([])
  })

  it('common-5（どの色でも読める）: 塗りのボタンは、マウスを載せても accent の地に onAccent の文字のまま。下線で示す', () => {
    const classes = buttonVariants({ variant: 'default' }).split(/\s+/)
    expect(classes).toContain('bg-primary')
    expect(classes).toContain('text-primary-foreground')
    expect(classes.filter((c) => c.startsWith('hover:bg-'))).toEqual([])
    expect(classes).toContain('hover:underline')
  })

  it('foundation-3（いつでも全部消せる）: 全部消すボタンは、surface の地に danger の文字。マウスを載せたら danger の地に onDanger の文字', () => {
    const classes = buttonVariants({ variant: 'destructive' }).split(/\s+/)
    expect(classes).toEqual(expect.arrayContaining(['bg-surface', 'text-danger', 'hover:bg-danger', 'hover:text-on-danger']))
  })

  it('common-5（どの色でも読める）: 入力欄の見た目は 1 か所（components/field.ts）にまとめ、話す画面と同じ field の地と fieldBorder の枠にする', () => {
    const definitions = Object.entries(sources)
      .filter(([, text]) => /const FIELD_CLASS\s*=/.test(text))
      .map(([file]) => file)
    expect(definitions).toEqual(['../components/field.ts'])
    const field = sources['../components/field.ts']
    expect(field).toContain('border-field-border')
    expect(field).toContain('bg-field')
    expect(field).not.toContain('bg-background')
  })
})
