import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { getMe, LOGIN_URL, type Me } from '@/api'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader } from '@/components/ui/card'
import { copy } from '@/copy'

type LoginState = { kind: 'loading' } | { kind: 'ready'; me: Me | null }

/** 案内。ログインしていなくても見られる。先に「あなたの言葉が根拠」「決めるのはあなた」を伝える。 */
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

  return (
    <Page>
      <section className="space-y-4">
        <h1 className="text-2xl font-bold tracking-tight">{copy.landing.title}</h1>
        <p className="text-lg leading-relaxed font-medium">{copy.landing.tagline}</p>
        <p className="leading-relaxed text-muted-foreground">{copy.landing.lead}</p>
      </section>

      <div className="mt-6 min-h-11">
        <StartAction login={login} />
      </div>

      <section className="mt-8 space-y-3">
        {copy.landing.promises.map((promise) => (
          <Card key={promise.title} size="sm">
            <CardHeader>
              <h2 className="text-base font-semibold">{promise.title}</h2>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed text-muted-foreground">{promise.body}</p>
            </CardContent>
          </Card>
        ))}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">{copy.landing.flowTitle}</h2>
        <ol className="mt-3 space-y-2">
          {copy.landing.flow.map((step, index) => (
            <li key={step} className="flex items-baseline gap-3 text-sm leading-relaxed">
              <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-semibold">
                {index + 1}
              </span>
              <span>{step}</span>
            </li>
          ))}
        </ol>
      </section>
    </Page>
  )
}

function StartAction({ login }: { login: LoginState }) {
  if (login.kind === 'loading') {
    return null
  }
  if (login.me === null) {
    // ログインは組み込み認証へページごと移動する。画面の切り替え（Link）で横取りしない
    return (
      <Button asChild size="lg" className="w-full sm:w-auto sm:px-6">
        <a href={LOGIN_URL}>{copy.landing.login}</a>
      </Button>
    )
  }
  return (
    <Button asChild size="lg" className="w-full sm:w-auto sm:px-6">
      <Link to={login.me.consented ? '/home' : '/start'}>{copy.landing.continue}</Link>
    </Button>
  )
}
