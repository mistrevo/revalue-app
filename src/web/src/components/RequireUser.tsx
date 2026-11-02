import { useEffect, useState, type ReactNode } from 'react'
import { Navigate } from 'react-router'
import { getMe, type Me } from '@/api'
import { copy } from '@/copy'
import { MeContext } from './me-context'
import { Page } from './Page'

type State = { kind: 'loading' } | { kind: 'ready'; me: Me | null } | { kind: 'error' }

/**
 * ログインが要る画面を包む。ログインしていなければ案内（/）へ戻し、
 * consent が true で了解していなければ、はじめに（/start）へ進める。
 */
export function RequireUser({ consent = false, children }: { consent?: boolean; children: ReactNode }) {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    getMe()
      .then((me) => active && setState({ kind: 'ready', me }))
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  if (state.kind === 'loading') {
    return (
      <Page>
        <p className="text-sm text-muted-foreground">{copy.loading}</p>
      </Page>
    )
  }
  if (state.kind === 'error') {
    return (
      <Page>
        <p role="alert" className="text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      </Page>
    )
  }
  if (state.me === null) {
    return <Navigate to="/" replace />
  }
  if (consent && !state.me.consented) {
    return <Navigate to="/start" replace />
  }
  return <MeContext value={state.me}>{children}</MeContext>
}
