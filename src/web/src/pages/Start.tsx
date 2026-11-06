import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router'
import { postConsent } from '@/api'
import { LogoutLink } from '@/components/LogoutLink'
import { useMe } from '@/components/me-context'
import { Page } from '@/components/Page'
import { ChevronDown, ShieldCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { copy } from '@/copy'

/** 設定の画面で全部消したあとに来たか。履歴の state で受け取る。 */
function cameFromDelete(state: unknown): boolean {
  return state !== null && typeof state === 'object' && (state as { deleted?: unknown }).deleted === true
}

/**
 * はじめに。保存するもの・しないもの・使い道・保存期間・全部消せることを示し、了解をもらう。
 * 全部消したあとに来たときは、消し終えたことを一度だけ伝える。
 */
export function Start() {
  const me = useMe()
  const navigate = useNavigate()
  const location = useLocation()
  const [deleted] = useState(() => cameFromDelete(location.state))
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  // 読み込み直したときに、もう一度出さないよう、履歴の state を消しておく
  useEffect(() => {
    if (cameFromDelete(location.state)) {
      navigate(location.pathname, { replace: true, state: null })
    }
  }, [location.pathname, location.state, navigate])

  if (me.consented) {
    return <Navigate to="/talk" replace />
  }

  async function agree() {
    setSending(true)
    setFailed(false)
    try {
      await postConsent(me.currentVersion)
      navigate('/talk')
    } catch {
      setFailed(true)
      setSending(false)
    }
  }

  return (
    <Page>
      {deleted && (
        <p role="status" className="mb-6 rounded-xl border bg-muted/50 px-4 py-3 text-sm leading-relaxed">
          {copy.settings.deleted}
        </p>
      )}
      <h1 className="text-2xl font-bold tracking-tight">{copy.start.title}</h1>
      <p className="mt-3 leading-relaxed text-muted-foreground">{copy.start.lead}</p>

      <Card className="mt-5">
        <ul className="space-y-3 px-4">
          {copy.start.summary.map((line) => (
            <li key={line} className="flex items-start gap-3 leading-relaxed">
              <ShieldCheck aria-hidden="true" className="mt-1 size-5 shrink-0 text-primary" />
              <span>{line}</span>
            </li>
          ))}
        </ul>
      </Card>

      <details className="group mt-4 rounded-2xl border border-border bg-surface">
        {/* 開閉の三角は flex で消えるので、下向きの矢印を添え、開いたら向きを変える。accent の文字は surface の上（確かめた組） */}
        <summary className="flex min-h-11 cursor-pointer list-none items-center gap-1.5 px-4 text-base font-bold text-primary [&::-webkit-details-marker]:hidden">
          {copy.start.more}
          <ChevronDown aria-hidden="true" className="size-5 shrink-0 transition-transform group-open:rotate-180" />
        </summary>
        <div className="divide-y divide-border border-t border-border">
          {copy.start.items.map((item) => (
            <section key={item.title} className="px-4 py-4">
              <h2 className="text-base font-semibold">{item.title}</h2>
              <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
            </section>
          ))}
        </div>
      </details>

      {failed && (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}

      <div className="mt-8 flex flex-col gap-3">
        <Button size="lg" className="min-h-14 w-full text-base font-extrabold" onClick={agree} disabled={sending}>
          {copy.start.agree}
        </Button>
        <p className="text-center text-sm text-muted-foreground">{copy.start.afterAgree}</p>
        {/* 了解しない人の出口。ログアウトは組み込み認証へページごと移動し、その端末の書きかけも消す */}
        <Button asChild size="lg" variant="ghost" className="h-auto w-full py-2 whitespace-normal text-muted-foreground">
          <LogoutLink>{copy.start.decline}</LogoutLink>
        </Button>
      </div>
    </Page>
  )
}
