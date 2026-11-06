import { useEffect, useRef, useState } from 'react'
import { Navigate } from 'react-router'
import { ApiError, createEpisode, getNextStep, listEpisodes } from '@/api'
import { Page } from '@/components/Page'
import { Bubble } from '@/components/talk/Bubble'
import { TalkLayout } from '@/components/talk/TalkLayout'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { chooseTalkTarget } from '@/lib/talk-target'
import { useStartEpisode } from '@/lib/use-start-episode'

type State = { kind: 'loading' } | { kind: 'go'; id: string } | { kind: 'rest' } | { kind: 'error' }

/**
 * 開いたときのトーク（/talk）。場面の一覧と次にできることから行き先を決める（discover-12（開くとトークが出る））。
 * 途中の場面か、いちばん新しく話し終えた場面へ進む。場面がなければ一つだけ作る。ほかのタブで途中の場面ができていたら（409）、
 * 新しく作らずにその場面へ進む。いちばん新しく話し終えた場面がつらい状態のサインの場面（サインに応えたところで終わったか、
 * 力の確かめに使わない印がある）なら、会話を出さず、
 * 聞き手の一言と、目立たせない「別の日のことを話す」だけを出す（discover-10（つらい状態のサインに応える））。
 * 読んでいるあいだは、トークの形（上の帯とメニュー板）だけを先に出す。
 * 読めなかった・作れなかったときは、白い画面にせず、言葉と「もう一度」を出す。
 */
export function TalkEntry() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  // 場面を二重に作らないよう、作っているあいだは次を始めない
  const creating = useRef(false)

  useEffect(() => {
    let active = true
    async function decide() {
      const [list, next] = await Promise.all([listEpisodes(), getNextStep().catch(() => null)])
      if (!active) return
      const target = chooseTalkTarget(list, next)
      if (target.kind === 'episode') {
        setState({ kind: 'go', id: target.id })
        return
      }
      if (target.kind === 'rest') {
        setState({ kind: 'rest' })
        return
      }
      if (creating.current) return
      creating.current = true
      try {
        const created = await createEpisode()
        setState({ kind: 'go', id: created.id })
      } catch (e) {
        if (e instanceof ApiError && e.status === 409 && e.episodeId) {
          setState({ kind: 'go', id: e.episodeId })
          return
        }
        throw e
      } finally {
        creating.current = false
      }
    }
    decide().catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [attempt])

  if (state.kind === 'go') {
    return <Navigate to={`/talk/${encodeURIComponent(state.id)}`} replace />
  }
  if (state.kind === 'rest') {
    return <Rest />
  }
  if (state.kind === 'error') {
    return (
      <Page>
        <p role="alert" className="leading-relaxed">
          {copy.errors.generic}
        </p>
        <Button
          size="lg"
          className="mt-4 h-11 w-full sm:w-auto sm:px-6"
          onClick={() => {
            setState({ kind: 'loading' })
            setAttempt((n) => n + 1)
          }}
        >
          {copy.talk.retry}
        </Button>
      </Page>
    )
  }
  return (
    <TalkLayout>
      <p className="text-muted-foreground">{copy.loading}</p>
    </TalkLayout>
  )
}

/**
 * つらい状態のサインに応えたところで終わったあと。会話は出さず、先へ進むことも勧めない。
 * 場面のないトークに、聞き手の側から一言と、目立たせない「別の日のことを話す」だけを置く。
 */
function Rest() {
  const { start, starting, failed } = useStartEpisode()
  return (
    <TalkLayout>
      <div className="flex flex-col gap-3">
        <Bubble role="assistant">{copy.talk.rest}</Bubble>
        <div>
          <Button variant="ghost" size="lg" className="h-auto min-h-11 py-2 whitespace-normal text-muted-foreground" onClick={start} disabled={starting}>
            {copy.talk.anotherDay}
          </Button>
        </div>
        {failed && (
          <p role="alert" className="leading-relaxed">
            {copy.errors.generic}
          </p>
        )}
      </div>
    </TalkLayout>
  )
}
