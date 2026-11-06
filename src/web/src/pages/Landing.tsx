import { useEffect, useState } from 'react'
import { MessageCircle, Lock, Pencil } from 'lucide-react'
import { Navigate } from 'react-router'
import { getMe, LOGIN_URL, type Me } from '@/api'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { copy } from '@/copy'

const PROMISE_ICONS = [MessageCircle, Pencil, Lock]

type LoginState = { kind: 'loading' } | { kind: 'ready'; me: Me | null }

/**
 * 案内。ログインしていなくても見られる。先に「あなたの言葉が根拠」「決めるのはあなた」を伝える。
 * ログインした人は、了解していればトーク（/talk）へ、了解していなければはじめに（/start）へ送る（開いたらトークが出るように）。
 */
export function Landing() {
  const [login, setLogin] = useState<LoginState>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    getMe()
      .then((me) => active && setLogin({ kind: 'ready', me }))
      .catch(() => active && setLogin({ kind: 'ready', me: null }))
    return () => {
      active = false
    }
  }, [])

  if (login.kind === 'ready' && login.me !== null) {
    return <Navigate to={login.me.consented ? '/talk' : '/start'} replace />
  }

  return (
    <Page>
      <div className="flex min-h-[calc(100svh-9rem)] flex-col">
        <p className="text-base font-extrabold tracking-wide text-primary">
          {copy.nav.appName} <span className="text-xs font-bold text-muted-foreground">リバリュー</span>
        </p>
        <h1 className="mt-6 text-2xl leading-snug font-extrabold">{copy.landing.tagline}</h1>
        <p className="mt-3 leading-relaxed">{copy.landing.lead}</p>

        <section className="mt-6 space-y-2.5">
          {copy.landing.promises.map((promise, index) => {
            const Icon = PROMISE_ICONS[index]
            return (
              <Card key={promise.title} size="sm" className="flex-row items-center gap-3 px-3.5">
                <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-tint text-on-tint">
                  <Icon aria-hidden="true" className="size-5" />
                </span>
                <div>
                  <h2 className="text-base font-bold">{promise.title}</h2>
                  <p className="text-sm leading-relaxed text-muted-foreground">{promise.body}</p>
                </div>
              </Card>
            )
          })}
        </section>

        <div className="min-h-6 flex-1" />
        <div className="min-h-14">
          <StartAction login={login} />
        </div>
        <p className="mt-3 text-center text-sm text-muted-foreground">{copy.landing.flow.join(' → ')}</p>
      </div>
    </Page>
  )
}

function StartAction({ login }: { login: LoginState }) {
  if (login.kind === 'loading') {
    return null
  }
  // ログインは組み込み認証へページごと移動する。画面の切り替え（Link）で横取りしない
  return (
    <Button asChild size="lg" className="min-h-14 w-full text-base font-extrabold">
      <a href={LOGIN_URL}>{copy.landing.login}</a>
    </Button>
  )
}
