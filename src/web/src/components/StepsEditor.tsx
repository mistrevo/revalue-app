import { useState } from 'react'
import type { DeepenContent, DeepenStep } from '@/api'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { hasVisibleText } from '@/lib/text'
import { FIELD_CLASS } from '@/components/field'

const MAX_OWN_STEPS = 3
// 入力欄の maxLength は UTF-16 の長さで数えるので、見た目の文字で数える裏側の上限より手前で止まることがある（深める画面と同じ）
const MAX_STEP = 100

/**
 * 最初の一歩を選ぶ・書く欄（deepen-3（最初の一歩は小さく）、deepen-4（創るの一歩には需要の確かめを入れる））。
 * 深める画面と可能性レポートの両方で使う。見出しは置かず、置く側の欄に入れる。
 * 候補を選んでも、自分で書いても、決めずにおいてもよい。裏側は、いまの条件で出す候補だけを返す。
 */
export function StepsEditor({
  content,
  busy,
  notice,
  onSave,
}: {
  content: DeepenContent
  busy: boolean
  notice: string | null
  onSave: (steps: { chosen: string[]; own: string[] }) => Promise<boolean>
}) {
  const { steps } = content
  const [chosen, setChosen] = useState<string[]>(() => steps.filter((s) => s.chosen).map((s) => s.id))
  const [own, setOwn] = useState<string[]>(() =>
    Array.from({ length: MAX_OWN_STEPS }, (_, i) => content.ownSteps[i] ?? ''),
  )
  const [saved, setSaved] = useState(false)
  // 書いた欄の次に、空の欄を 1 つだけ出す（3 つまで）
  const lastWritten = own.reduce((last, text, i) => (text.trim() !== '' ? i : last), -1)
  const visibleOwn = Math.min(MAX_OWN_STEPS, Math.max(1, lastWritten + 2))
  // 条件が変わって、収まらない候補をコードの候補で入れ替えたかは、裏側が返す
  const replaced = content.stepsReplaced

  function toggle(step: DeepenStep, checked: boolean) {
    setSaved(false)
    setChosen((current) =>
      checked ? steps.filter((s) => s.id === step.id || current.includes(s.id)).map((s) => s.id) : current.filter((id) => id !== step.id),
    )
  }

  return (
    <>
      <p className="-mt-1 text-sm leading-relaxed text-muted-foreground">{copy.deepen.stepsLead}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          setSaved(false)
          const written = own.map((text) => text.trim()).filter((text) => hasVisibleText(text))
          if (await onSave({ chosen, own: written })) setSaved(true)
        }}
      >
        <ul className="flex flex-col gap-2">
          {steps.map((step) => (
            <li key={step.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-relaxed">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  checked={chosen.includes(step.id)}
                  // 収まらない候補は、選んでいたものだけが来る。外したあとは選び直せない（裏側も断る）
                  disabled={busy || (!step.fits && !step.chosen)}
                  onChange={(event) => toggle(step, event.target.checked)}
                />
                <span className="min-w-0 break-words">{step.text}</span>
              </label>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-7 text-muted-foreground">
                <span>{`${copy.deepen.stepHours.replace('{n}', String(step.hours))}、${copy.deepen.placeValues[step.place]}`}</span>
                {step.demandCheck && (
                  <span className="rounded-full bg-tint px-2 py-0.5 text-xs text-on-tint">{copy.deepen.demandCheck}</span>
                )}
                {!step.fits && <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{copy.deepen.stepOutside}</span>}
              </p>
            </li>
          ))}
        </ul>
        {replaced && <p className="text-sm leading-relaxed text-muted-foreground">{copy.deepen.stepsReplaced}</p>}

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="text-sm font-medium">{copy.deepen.ownStepsTitle}</legend>
          {own.slice(0, visibleOwn).map((text, i) => {
            const label = copy.deepen.ownStepLabel.replace('{n}', String(i + 1))
            return (
              <input
                key={i}
                aria-label={label}
                value={text}
                maxLength={MAX_STEP}
                onChange={(event) => {
                  setSaved(false)
                  setOwn((current) => current.map((t, j) => (j === i ? event.target.value : t)))
                }}
                className={FIELD_CLASS}
              />
            )
          })}
        </fieldset>

        <Button type="submit" className="w-full sm:w-auto sm:self-start" disabled={busy}>
          {copy.deepen.stepsSave}
        </Button>
        {saved && (
          <p role="status" className="text-sm leading-relaxed">
            {copy.deepen.stepsSaved}
          </p>
        )}
        {notice && (
          <p role="alert" className="text-sm leading-relaxed">
            {notice}
          </p>
        )}
      </form>
    </>
  )
}
