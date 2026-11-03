import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, createEpisode, getNextStep, listEpisodes, type NextStep } from '@/api'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { nextStepPath } from '@/lib/next-step'

type Episodes = { kind: 'loading' } | { kind: 'ready'; talkingId: string | null; hasFinished: boolean } | { kind: 'error' }
type Next = { kind: 'loading' } | { kind: 'ready'; next: NextStep } | { kind: 'error' }

/** 各画面への道。どの幅でも折り返して収まるよう、格子に並べる。 */
const LINKS = [
  { to: '/episodes', label: copy.home.episodesLink },
  { to: '/abilities', label: copy.home.abilities },
  { to: '/profile', label: copy.home.profile },
  { to: '/options', label: copy.home.options },
  { to: '/deepen', label: copy.home.deepen },
  { to: '/report', label: copy.home.report },
] as const

/** 長い言葉でも折り返してボタンの中に収める。 */
const WRAP = 'h-auto min-h-9 w-full py-2 whitespace-normal'

/**
 * ホーム。先頭に「次にできること」を一つだけ目立たせて出し、その下に各画面への道と設定を並べる（common-3（次にできることを一つ示す））。
 * 次にできることが talk なら新しい場面を作り、continue なら話している途中の場面へ。読めなかったときは、いままでどおり
 * 「話す」（途中の場面があれば「続きから話す」）を出す（行き止まりを作らない）。
 */
export function Home() {
  const navigate = useNavigate()
  const [episodes, setEpisodes] = useState<Episodes>({ kind: 'loading' })
  const [next, setNext] = useState<Next>({ kind: 'loading' })
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    listEpisodes()
      .then((list) => {
        if (!active) return
        const talking = list.find((e) => e.status === 'talking')
        setEpisodes({ kind: 'ready', talkingId: talking?.id ?? null, hasFinished: list.some((e) => e.status === 'finished') })
      })
      .catch(() => active && setEpisodes({ kind: 'error' }))
    getNextStep()
      .then((value) => active && setNext({ kind: 'ready', next: value }))
      .catch(() => active && setNext({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  async function start() {
    setStarting(true)
    setFailed(false)
    try {
      const episode = await createEpisode()
      navigate(`/talk/${episode.id}`)
    } catch (e) {
      // ほかのタブなどで途中の場面ができていたら、新しく作らずにその場面へ
      if (e instanceof ApiError && e.status === 409 && e.episodeId) {
        navigate(`/talk/${e.episodeId}`)
        return
      }
      setFailed(true)
      setStarting(false)
    }
  }

  const fallbackTalkingId = episodes.kind === 'ready' ? episodes.talkingId : null
  const fallbackReady = episodes.kind !== 'loading'

  return (
    <Page>
      <h1 className="text-xl leading-relaxed font-bold">
        {episodes.kind === 'ready' && episodes.hasFinished ? copy.home.greetingAgain : copy.home.greeting}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.home.lead}</p>

      {next.kind === 'loading' && <p className="mt-6 text-sm text-muted-foreground">{copy.loading}</p>}

      {next.kind === 'ready' && (
        <section aria-labelledby="home-next-title" className="mt-6 rounded-lg border border-border p-4">
          <h2 id="home-next-title" className="text-base font-bold">
            {copy.home.next.title}
          </h2>
          <div className="mt-3">
            {next.next.step === 'talk' ? (
              <Button size="lg" className={WRAP} onClick={start} disabled={starting}>
                {copy.home.next.talk}
              </Button>
            ) : (
              <Button asChild size="lg" className={WRAP}>
                <Link to={nextStepPath(next.next)}>{copy.home.next[next.next.step]}</Link>
              </Button>
            )}
          </div>
          <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.home.next.anywhere}</p>
        </section>
      )}

      {next.kind === 'error' && fallbackReady && (
        <div className="mt-6">
          {fallbackTalkingId !== null ? (
            <Button asChild size="lg" className={WRAP}>
              <Link to={`/talk/${fallbackTalkingId}`}>{copy.home.continue}</Link>
            </Button>
          ) : (
            <Button size="lg" className={WRAP} onClick={start} disabled={starting}>
              {copy.home.talk}
            </Button>
          )}
        </div>
      )}

      {failed && (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}

      <nav aria-labelledby="home-others-title" className="mt-8">
        <h2 id="home-others-title" className="text-sm font-bold text-muted-foreground">
          {copy.home.othersTitle}
        </h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {LINKS.map((link) => (
            <Button key={link.to} asChild variant="outline" size="lg" className={WRAP}>
              <Link to={link.to}>{link.label}</Link>
            </Button>
          ))}
          <Button asChild variant="ghost" size="lg" className={WRAP}>
            <Link to="/settings">{copy.home.settingsLink}</Link>
          </Button>
        </div>
      </nav>
    </Page>
  )
}
