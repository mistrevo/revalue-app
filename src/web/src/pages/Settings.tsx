import { useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { deleteMe, LOGOUT_URL } from '@/api'
import { useMe } from '@/components/me-context'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'

/** 設定。全部消すと、ログアウト。全部消すときは、ブラウザの確認ダイアログを使わず画面の中で確かめる。 */
export function Settings() {
  const me = useMe()
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [failed, setFailed] = useState(false)

  async function deleteAll() {
    setDeleting(true)
    setFailed(false)
    try {
      await deleteMe()
      navigate('/start', { replace: true })
    } catch {
      setFailed(true)
      setDeleting(false)
    }
  }

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.settings.title}</h1>

      <section className="mt-6 rounded-xl border px-4 py-4">
        <h2 className="text-base font-semibold">{copy.settings.deleteTitle}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.settings.deleteBody}</p>

        {confirming ? (
          <div className="mt-4 rounded-lg bg-muted/50 px-4 py-4">
            <p className="text-sm font-medium">{copy.settings.confirmQuestion}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row">
              <Button variant="destructive" onClick={deleteAll} disabled={deleting} className="w-full sm:w-auto">
                {copy.settings.confirmYes}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setConfirming(false)
                  setFailed(false)
                }}
                disabled={deleting}
                className="w-full sm:w-auto"
              >
                {copy.settings.confirmNo}
              </Button>
            </div>
          </div>
        ) : (
          <Button variant="destructive" className="mt-4 w-full sm:w-auto" onClick={() => setConfirming(true)}>
            {copy.settings.deleteButton}
          </Button>
        )}

        {failed && (
          <p role="alert" className="mt-3 text-sm leading-relaxed">
            {copy.errors.generic}
          </p>
        )}
      </section>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {me.consented && (
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link to="/home">{copy.settings.backHome}</Link>
          </Button>
        )}
        {/* ログアウトは組み込み認証へページごと移動する */}
        <Button asChild variant="ghost" className="w-full sm:w-auto">
          <a href={LOGOUT_URL}>{copy.settings.logout}</a>
        </Button>
      </div>
    </Page>
  )
}
