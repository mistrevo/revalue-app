import { useEffect, useState } from 'react'
import { Link } from 'react-router'
import { listEpisodes, type EpisodeSummary } from '@/api'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { formatDay } from '@/lib/jst'

type State = { kind: 'loading' } | { kind: 'ready'; episodes: EpisodeSummary[] } | { kind: 'error' }

/** 話した場面の一覧（新しい順。話している途中の場面も含む）。開くと、話す画面で読み返す・続きから話す。 */
export function Episodes() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    let active = true
    listEpisodes()
      .then((episodes) => active && setState({ kind: 'ready', episodes }))
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.episodes.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.episodes.lead}</p>

      {state.kind === 'loading' && <p className="mt-6 text-sm text-muted-foreground">{copy.loading}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="mt-6 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}
      {state.kind === 'ready' && state.episodes.length === 0 && (
        <p className="mt-6 text-sm leading-relaxed">{copy.episodes.empty}</p>
      )}
      {state.kind === 'ready' && state.episodes.length > 0 && (
        <ul className="mt-6 flex flex-col gap-3">
          {state.episodes.map((episode) => (
            <li key={episode.id}>
              <Link
                to={`/talk/${episode.id}`}
                className="block rounded-xl border px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
              >
                <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span>{formatDay(episode.startedAt)}</span>
                  <span
                    className={
                      episode.status === 'talking'
                        ? 'rounded-full bg-primary/10 px-2 py-0.5 font-medium text-primary'
                        : 'rounded-full bg-muted px-2 py-0.5'
                    }
                  >
                    {episode.status === 'talking' ? copy.episodes.talking : copy.episodes.finished}
                  </span>
                  {episode.canResume && <span className="font-medium text-primary">{copy.episodes.canResume}</span>}
                </span>
                <span className="mt-1 block text-sm leading-relaxed break-words">
                  {episode.preview || copy.episodes.noPreview}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-6">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link to="/talk">{copy.nav.backToTalk}</Link>
        </Button>
      </div>
    </Page>
  )
}
