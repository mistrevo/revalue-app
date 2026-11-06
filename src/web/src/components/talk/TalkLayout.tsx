import { MessageCircle } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { copy } from '@/copy'
import { MenuBoard } from './MenuBoard'

/** PC に切り替える幅（Tailwind の lg）。 */
const WIDE_QUERY = '(min-width: 1024px)'

/** 幅が PC の目安を超えているか。端末の設定を読めない（matchMedia がない）ときはスマホの形にする。 */
function useWide(): boolean {
  const [wide, setWide] = useState(() => {
    try {
      return window.matchMedia?.(WIDE_QUERY).matches ?? false
    } catch {
      return false
    }
  })
  useEffect(() => {
    let query: MediaQueryList | undefined
    try {
      query = window.matchMedia?.(WIDE_QUERY)
    } catch {
      return
    }
    if (!query) return
    const update = () => setWide(query.matches)
    query.addEventListener?.('change', update)
    return () => query.removeEventListener?.('change', update)
  }, [])
  return wide
}

/**
 * 話す画面の形。画面の高さいっぱいの 3 段（上の帯、やりとり、下の帯）で、やりとりだけが上下に動く。
 * 上の帯は、ほかの画面の左上の「RE:VALUE」の代わりになる。下の帯には footer（入力の帯）とメニュー板を重ねて置く。
 * PC（幅 1024px 以上）では、トークの列を中央に置き、メニュー板を右の列にいつも開いて出す。
 * menuHidden のあいだ（入力欄に文字を打っているあいだ）は、スマホのメニュー板を隠す。
 */
export function TalkLayout({ children, footer, menuHidden = false }: { children: ReactNode; footer?: ReactNode; menuHidden?: boolean }) {
  const wide = useWide()
  return (
    <div className="flex h-svh justify-center gap-6 bg-ground text-foreground lg:px-6">
      <div className="flex h-full min-w-0 flex-1 flex-col lg:max-w-[640px] lg:border-x lg:border-border">
        <header className="flex shrink-0 items-center gap-3 border-b border-border bg-surface px-4 py-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-tint">
            <MessageCircle aria-hidden className="size-[22px] text-primary" />
          </span>
          <div className="min-w-0 flex-1 leading-snug">
            <p className="text-[17px] font-bold">{copy.talk.listener}</p>
            <h1 className="text-[13px] text-muted-foreground">{copy.talk.title}</h1>
          </div>
        </header>
        {/* relative: 読み上げ用の見えない文字（sr-only は absolute）を、この中に収める。ないと、ページ全体が縦に伸びて動く */}
        <div className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">{children}</div>
        {footer !== undefined && <div className="shrink-0 border-t border-border bg-surface px-3 pt-2 pb-2.5">{footer}</div>}
        {!wide && <MenuBoard variant="bottom" hidden={menuHidden} />}
      </div>
      {wide && (
        <aside className="w-60 shrink-0 py-6">
          <MenuBoard variant="side" />
        </aside>
      )}
    </div>
  )
}
