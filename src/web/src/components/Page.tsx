import { useContext, type ReactNode } from 'react'
import { ArrowLeft } from 'lucide-react'
import { Link, useLocation } from 'react-router'
import { copy } from '@/copy'
import { MeContext } from './me-context'

/**
 * どの画面にも共通の枠。スマホを先に考え、PC でも読みやすい幅に収める。
 * 上の帯は、ログインして了解した人のトーク以外の画面では「← トークに戻る」（/talk）。
 * 案内、はじめに、読み込み中、トークの中では「RE:VALUE」（トークの中ではトーク、ほかでは案内）。
 */
export function Page({ children }: { children: ReactNode }) {
  const me = useContext(MeContext)
  const { pathname } = useLocation()
  const inTalk = pathname === '/talk' || pathname.startsWith('/talk/')
  const backToTalk = Boolean(me?.consented) && !inTalk
  return (
    <div className="min-h-svh bg-ground">
      <header className="border-b border-border bg-surface">
        <div className="mx-auto flex min-h-14 max-w-xl items-center px-4">
          {backToTalk ? (
            <Link to="/talk" className="inline-flex min-h-11 items-center gap-2 text-base font-bold text-foreground">
              <ArrowLeft aria-hidden="true" className="size-5" />
              {copy.nav.backToTalk}
            </Link>
          ) : (
            <Link
              to={me?.consented ? '/talk' : '/'}
              className="inline-flex min-h-11 items-center text-base font-bold tracking-wide text-foreground"
            >
              {copy.nav.appName}
            </Link>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 pt-6 pb-12">{children}</main>
    </div>
  )
}
