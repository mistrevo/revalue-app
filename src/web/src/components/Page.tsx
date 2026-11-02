import type { ReactNode } from 'react'
import { Link } from 'react-router'
import { copy } from '@/copy'

/** どの画面にも共通の枠。スマホを先に考え、PC でも読みやすい幅に収める。 */
export function Page({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-svh bg-background">
      <header className="mx-auto flex max-w-xl items-center px-4 pt-4">
        <Link to="/" className="text-sm font-semibold tracking-wide text-foreground">
          {copy.nav.appName}
        </Link>
      </header>
      <main className="mx-auto max-w-xl px-4 pt-6 pb-12">{children}</main>
    </div>
  )
}
