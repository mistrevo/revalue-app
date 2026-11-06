import { useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { deleteMe } from '@/api'
import { LogoutLink } from '@/components/LogoutLink'
import { clearAllDrafts } from '@/lib/drafts'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { PALETTES, PALETTE_KEYS, choosePalette, currentPalette, type PaletteKey } from '@/lib/palette'
import { copy } from '@/copy'

/**
 * 設定。全部消すと、ログアウト。全部消すときは、ブラウザの確認ダイアログを使わず画面の中で確かめる。
 * 全部消したときと、ログアウトするときは、その端末に残した書きかけもすべて消す。
 */
/** 色の選び方。丸い色見本を並べ、矢印キーで動かせる（radiogroup）。選ぶとすぐ変わり、この端末にだけ残す。 */
function ColorPicker() {
  const [selected, setSelected] = useState<PaletteKey>(currentPalette)
  const refs = useRef<Record<string, HTMLButtonElement | null>>({})
  const titleId = 'settings-color-title'

  function choose(key: PaletteKey) {
    choosePalette(key)
    setSelected(key)
  }

  function onKeyDown(event: React.KeyboardEvent, index: number) {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0
    if (step === 0) return
    event.preventDefault()
    const next = PALETTE_KEYS[(index + step + PALETTE_KEYS.length) % PALETTE_KEYS.length]
    choose(next)
    refs.current[next]?.focus()
  }

  return (
    <section aria-labelledby={titleId} className="mt-6 rounded-2xl border bg-surface px-4 py-4">
      <h2 id={titleId} className="text-base font-semibold">
        {copy.settings.colorTitle}
      </h2>
      <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.settings.colorLead}</p>
      <div role="radiogroup" aria-labelledby={titleId} className="mt-4 grid grid-cols-3 gap-2 sm:grid-cols-6">
        {PALETTE_KEYS.map((key, index) => {
          const checked = key === selected
          return (
            <button
              key={key}
              ref={(el) => {
                refs.current[key] = el
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={checked ? 0 : -1}
              onClick={() => choose(key)}
              onKeyDown={(event) => onKeyDown(event, index)}
              className={`flex min-h-11 flex-col items-center justify-center gap-1 rounded-[14px] border-2 px-2 py-2 text-sm font-bold outline-none focus-visible:ring-3 focus-visible:ring-ring/50 ${checked ? 'border-primary bg-tint text-on-tint' : 'border-border bg-surface text-foreground'}`}
            >
              <span
                aria-hidden="true"
                className="size-6 rounded-full border border-border"
                style={{ backgroundColor: PALETTES[key].light.accent }}
              />
              {PALETTES[key].name}
            </button>
          )
        })}
      </div>
    </section>
  )
}

export function Settings() {
  const navigate = useNavigate()
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [failed, setFailed] = useState(false)

  async function deleteAll() {
    setDeleting(true)
    setFailed(false)
    try {
      await deleteMe()
      clearAllDrafts()
      // はじめにの画面で、消し終えたことを一度だけ伝える
      navigate('/start', { replace: true, state: { deleted: true } })
    } catch {
      setFailed(true)
      setDeleting(false)
    }
  }

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.settings.title}</h1>

      <ColorPicker />

      <section className="mt-6 rounded-2xl border bg-surface px-4 py-4">
        <h2 className="text-base font-semibold">{copy.settings.deleteTitle}</h2>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{copy.settings.deleteBody}</p>

        {confirming ? (
          <div className="mt-4 rounded-lg bg-muted/50 px-4 py-4">
            <p className="text-sm font-medium">{copy.settings.confirmQuestion}</p>
            <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
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

      <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:flex-wrap">
        {/* ログアウトは組み込み認証へページごと移動し、その端末の書きかけも消す */}
        <Button asChild variant="ghost" className="w-full sm:w-auto">
          <LogoutLink>{copy.settings.logout}</LogoutLink>
        </Button>
      </div>
    </Page>
  )
}
