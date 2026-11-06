import { useContext, type ReactNode } from 'react'
import { Link } from 'react-router'
import { copy } from '@/copy'
import { MeContext } from './me-context'

/**
 * どの画面にも共通の枠。スマホを先に考え、PC でも読みやすい幅に収める。
 * 見出しの「RE:VALUE」は、ログインして了解した人の画面ではトーク（/talk）へ、ほか（案内、はじめに、読み込み中）では案内へ行く。
 */
export function Page({ children }: { children: ReactNode }) {
  const me = useContext(MeContext)
  return (
    <div className="min-h-svh bg-background">
      <header className="mx-auto flex max-w-xl items-center px-4 pt-4">
        <Link to={me?.consented ? '/talk' : '/'} className="text-sm font-semibold tracking-wide text-foreground">
          {copy.nav.appName}
        </Link>
      </header>
      <main className="mx-auto max-w-xl px-4 pt-6 pb-12">{children}</main>
    </div>
  )
}
