import { useEffect, useId, useState } from 'react'
import { Link } from 'react-router'
import { excludeAbility, getAbilities, restoreAbility, type Abilities as AbilitiesData, type AbilityChange, type AbilityView } from '@/api'
import { Hints, QuoteList } from '@/components/Insights'
import { NextStepLink } from '@/components/NextStepLink'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { formatDateTime } from '@/lib/jst'

type State = { kind: 'loading' } | { kind: 'ready'; data: AbilitiesData } | { kind: 'error' }

/**
 * 見えた力（03-validate.md の「見えた力の画面」）。API が返した見せた力ごとに、生活の中でと仕事でを分けて出し、外す・戻すを置く。
 * 下に、変わったことの履歴（新しい順）。状態の呼び名、チェック表、点数、順位は出さない。
 */
export function Abilities() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let active = true
    getAbilities()
      .then((data) => active && setState({ kind: 'ready', data }))
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  async function toggle(ability: AbilityView) {
    setBusy(true)
    setFailed(false)
    try {
      const data = ability.excluded ? await restoreAbility(ability.key) : await excludeAbility(ability.key)
      setState({ kind: 'ready', data })
    } catch {
      setFailed(true)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.abilities.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.abilities.lead}</p>

      {state.kind === 'loading' && <p className="mt-6 text-sm text-muted-foreground">{copy.loading}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="mt-6 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}
      {state.kind === 'ready' && (
        <>
          {state.data.abilities.length === 0 && (
            <p className="mt-6 text-sm leading-relaxed">{copy.abilities.noneYet}</p>
          )}
          <div className="mt-6 flex flex-col gap-4">
            {state.data.abilities.map((ability) => (
              <AbilityCard key={ability.key} ability={ability} busy={busy} onToggle={() => toggle(ability)} />
            ))}
          </div>
          {failed && (
            <p role="alert" className="mt-3 text-sm leading-relaxed">
              {copy.errors.generic}
            </p>
          )}
          {state.data.abilities.length > 0 && (
            <p className="mt-4 text-sm leading-relaxed text-muted-foreground">{copy.insights.moreNote}</p>
          )}
          <History history={state.data.history} />
          <NextStepLink refreshKey={state.data} />
        </>
      )}

      <div className="mt-6">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link to="/home">{copy.abilities.backHome}</Link>
        </Button>
      </div>
    </Page>
  )
}

function AbilityCard({ ability, busy, onToggle }: { ability: AbilityView; busy: boolean; onToggle: () => void }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="rounded-xl border px-4 py-4">
      <h2 id={id} className="text-base font-bold">
        {ability.name}
      </h2>

      <div className="mt-3">
        <h3 className="text-xs font-semibold text-muted-foreground">{copy.abilities.life}</h3>
        <p className="mt-1 text-sm font-medium">{ability.life === 'confirmed' ? copy.abilities.states.confirmed : copy.abilities.states.needsCheck}</p>
        <QuoteList quotes={ability.quotes} paired={ability.life === 'confirmed'} />
        {ability.life === 'needsCheck' && <Hints hints={ability.hints} />}
        {ability.episodeId && (
          <Link
            to={`/talk/${ability.episodeId}`}
            className="mt-2 inline-block text-sm font-medium text-primary underline underline-offset-4"
          >
            {copy.abilities.openEpisode}
          </Link>
        )}
      </div>

      <div className="mt-3">
        <h3 className="text-xs font-semibold text-muted-foreground">{copy.abilities.work}</h3>
        <p className="mt-1 text-sm">{copy.abilities.workNotChecked}</p>
      </div>

      {ability.excluded && <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.abilities.excludedNote}</p>}
      <div className="mt-3">
        <Button variant="outline" size="sm" onClick={onToggle} disabled={busy} className="w-full sm:w-auto">
          {ability.excluded ? copy.abilities.restore : copy.abilities.exclude}
        </Button>
      </div>
    </section>
  )
}

function History({ history }: { history: AbilityChange[] }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="mt-8">
      <h2 id={id} className="text-base font-bold">
        {copy.abilities.historyTitle}
      </h2>
      {history.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground">{copy.abilities.historyEmpty}</p>
      ) : (
        <ul className="mt-2 flex flex-col gap-2">
          {history.map((change, index) => (
            <li key={index} className="text-sm leading-relaxed break-words">
              <span className="mr-2 text-xs text-muted-foreground">{formatDateTime(change.at)}</span>
              <span>{describe(change)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/**
 * 履歴の 1 行。外す・戻す・確かめに使わなくなった場面は理由だけ、ほかは状態の移り変わりと理由。状態は画面の言葉にする。
 * 確かめに使わなくなった場面（つらい状態のサインが出た場面）は、打ち明けた直後に見立てが下がったと読めないよう、移り変わりを書かない。
 */
function describe(change: AbilityChange): string {
  const reason = copy.abilities.reasons[change.reason]
  if (change.reason === 'exclude' || change.reason === 'restore' || change.reason === 'setAside') {
    return `${change.name}: ${reason}`
  }
  return `${change.name}: ${copy.abilities.stateWords[change.from]} → ${copy.abilities.stateWords[change.to]}（${reason}）`
}
