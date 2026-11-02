import { useState } from 'react'
import { Navigate, useNavigate } from 'react-router'
import { postConsent } from '@/api'
import { useMe } from '@/components/me-context'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'

/** はじめに。保存するもの・しないもの・使い道・保存期間・全部消せることを示し、了解をもらう。 */
export function Start() {
  const me = useMe()
  const navigate = useNavigate()
  const [sending, setSending] = useState(false)
  const [failed, setFailed] = useState(false)

  if (me.consented) {
    return <Navigate to="/home" replace />
  }

  async function agree() {
    setSending(true)
    setFailed(false)
    try {
      await postConsent(me.currentVersion)
      navigate('/home')
    } catch {
      setFailed(true)
      setSending(false)
    }
  }

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.start.title}</h1>
      <p className="mt-3 leading-relaxed text-muted-foreground">{copy.start.lead}</p>

      <div className="mt-6 divide-y rounded-xl border">
        {copy.start.items.map((item) => (
          <section key={item.title} className="px-4 py-4">
            <h2 className="text-base font-semibold">{item.title}</h2>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{item.body}</p>
          </section>
        ))}
      </div>

      {failed && (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}

      <Button size="lg" className="mt-6 w-full sm:w-auto sm:px-6" onClick={agree} disabled={sending}>
        {copy.start.agree}
      </Button>
    </Page>
  )
}
