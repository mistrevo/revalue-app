import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError, createEpisode, listEpisodes } from '@/api'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'

type State = { kind: 'loading' } | { kind: 'ready'; talkingId: string | null } | { kind: 'error' }

/**
 * ホーム。「話す」の入口、話したことの一覧、見えた力、5 つの記録、仕事の選択肢、設定。
 * 話している途中の場面があれば「続きから話す」でその場面へ。なければ新しい場面を作る。
 */
export function Home() {
  const navigate = useNavigate()
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [starting, setStarting] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    listEpisodes()
      .then((episodes) => {
        if (!active) return
        const talking = episodes.find((e) => e.status === 'talking')
        setState({ kind: 'ready', talkingId: talking?.id ?? null })
      })
      .catch(() => active && setState({ kind: 'error' }))
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

  return (
    <Page>
      <h1 className="text-xl leading-relaxed font-bold">{copy.home.greeting}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.home.lead}</p>

      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        {state.kind === 'loading' && <p className="text-sm text-muted-foreground">{copy.loading}</p>}
        {state.kind === 'ready' && state.talkingId !== null && (
          <Button asChild size="lg" className="w-full sm:w-auto">
            <Link to={`/talk/${state.talkingId}`}>{copy.home.continue}</Link>
          </Button>
        )}
        {(state.kind === 'error' || (state.kind === 'ready' && state.talkingId === null)) && (
          <Button size="lg" className="w-full sm:w-auto" onClick={start} disabled={starting}>
            {copy.home.talk}
          </Button>
        )}
        <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
          <Link to="/episodes">{copy.home.episodesLink}</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
          <Link to="/abilities">{copy.home.abilities}</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
          <Link to="/profile">{copy.home.profile}</Link>
        </Button>
        <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
          <Link to="/options">{copy.home.options}</Link>
        </Button>
        <Button asChild variant="ghost" size="lg" className="w-full sm:w-auto">
          <Link to="/settings">{copy.home.settingsLink}</Link>
        </Button>
      </div>

      {failed && (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}
    </Page>
  )
}
