import { useEffect, useId, useState } from 'react'
import { Link, useLocation } from 'react-router'
import { getNextStep, type NextStep } from '@/api'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { nextStepPath } from '@/lib/next-step'
import { useStartEpisode } from '@/lib/use-start-episode'

/** 長い言葉でも折り返してボタンの中に収める。 */
const BUTTON = 'mt-3 h-auto min-h-9 w-full py-2 whitespace-normal sm:w-auto'

/**
 * 画面の下に出す、次にできることへの道一つ（00-common.md の「次にできること」。common-3（次にできることを一つ示す））。
 * talk は、その場で新しい場面を始める（ボタンの言葉どおりに進む）。continue はその場面へ。
 * いまいる画面と同じ行き先なら出さない。読めなかったとき、none（つらい状態のサインに応えた直後）のときも何も出さない
 * （ほかの道は画面に残っている）。
 * refreshKey が変わったら読み直す（条件を保存したときなど、記録が変わったとき）。
 */
export function NextStepLink({ refreshKey }: { refreshKey?: unknown }) {
  const location = useLocation()
  const titleId = useId()
  const [next, setNext] = useState<NextStep | null>(null)
  const { start, starting, failed } = useStartEpisode()

  useEffect(() => {
    let active = true
    getNextStep()
      .then((value) => active && setNext(value))
      .catch(() => active && setNext(null))
    return () => {
      active = false
    }
  }, [refreshKey])

  if (next === null || next.step === 'none') return null
  const to = nextStepPath({ ...next, step: next.step })
  if (to !== null && to.split('?')[0] === location.pathname) return null

  return (
    <section aria-labelledby={titleId} className="mt-6 rounded-lg border border-border p-4">
      <h2 id={titleId} className="text-base font-bold">
        {copy.home.next.title}
      </h2>
      {to === null ? (
        <Button className={BUTTON} onClick={start} disabled={starting}>
          {copy.home.next.talk}
        </Button>
      ) : (
        <Button asChild className={BUTTON}>
          <Link to={to}>{copy.home.next[next.step]}</Link>
        </Button>
      )}
      {failed && (
        <p role="alert" className="mt-3 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}
      <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.home.next.anywhere}</p>
    </section>
  )
}
