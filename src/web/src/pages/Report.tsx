import { useCallback, useEffect, useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  ApiError,
  getDeepen,
  getReport,
  putDeepenSteps,
  putOptionChoice,
  type DeepenContent,
  type ProfileEntry,
  type Report as ReportData,
  type ReportAbility,
  type ReportChoice,
  type ReportNotYet,
  type ReportRecords,
  type ReportSection,
  type ReportSnapshot,
  type ReportSnapshotNotYet,
  type ReportStep,
  type ReportThought,
  type ReportVersion,
} from '@/api'
import { QuoteList } from '@/components/Insights'
import { Page } from '@/components/Page'
import { StepsEditor } from '@/components/StepsEditor'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { formatDateTime } from '@/lib/jst'

type State = { kind: 'loading' } | { kind: 'ready'; data: ReportData } | { kind: 'error' }

const SECTIONS: ReportSection[] = ['abilities', 'notYet', 'records', 'choice', 'thinking', 'steps']
const CARD_CLASS = 'flex min-w-0 flex-col gap-3 rounded-xl border px-4 py-4'
const LINK_BUTTON = 'w-full sm:w-auto sm:self-start'

function versionTitle(version: ReportVersion) {
  return copy.report.version.replace('{n}', String(version.number)).replace('{at}', formatDateTime(version.at))
}

function changedText(changed: ReportSection[]) {
  const names = SECTIONS.filter((s) => changed.includes(s)).map((s) => copy.report.sections[s])
  return copy.report.changed.replace('{sections}', names.join('、'))
}

/** いまの選んだ案で深めた中身（古くないもの）。なければ null。 */
function currentDeepen(content: DeepenContent | null | undefined): DeepenContent | null {
  return content && !content.stale ? content : null
}

/**
 * 可能性レポート（07-report.md）。確かめた力と根拠、まだ確かめていないこと、5 つの記録、選んだ案、考え方、最初の一歩を、
 * 裏側が組み立てた順に並べる。欄ごとに直す画面への道を出し、保留と一歩の選び直しはここからもできる。
 * 状態の呼び名、点数、順位は出さない。前の版は、根拠の言葉と力の状態なしで見せる。
 */
export function Report() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [deepen, setDeepen] = useState<DeepenContent | null>(null)
  const [busy, setBusy] = useState(false)
  const [holdFailed, setHoldFailed] = useState(false)

  const reload = useCallback(async () => {
    const data = await getReport()
    setState({ kind: 'ready', data })
    return data
  }, [])

  const loadDeepen = useCallback(async (data: ReportData) => {
    // 一歩を選び直せるのは、いまの案で深めた中身があるときだけ
    if (!data.ready || !data.content || data.content.steps === null) {
      setDeepen(null)
      return
    }
    try {
      const fresh = await getDeepen()
      setDeepen(fresh.readiness === 'ready' ? currentDeepen(fresh.content) : null)
    } catch {
      setDeepen(null)
    }
  }, [])

  useEffect(() => {
    let active = true
    getReport()
      .then((data) => {
        if (!active) return
        setState({ kind: 'ready', data })
        void loadDeepen(data)
      })
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [loadDeepen])

  async function hold() {
    setBusy(true)
    setHoldFailed(false)
    try {
      await putOptionChoice({ kind: 'hold' })
      const data = await reload()
      await loadDeepen(data)
    } catch {
      setHoldFailed(true)
    } finally {
      setBusy(false)
    }
  }

  const data = state.kind === 'ready' ? state.data : null

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.report.title}</h1>

      {state.kind === 'loading' && <p className="mt-6 text-sm text-muted-foreground">{copy.loading}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="mt-6 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}

      {data && !data.ready && (
        <div className="mt-6 flex flex-col gap-3 rounded-xl border px-4 py-4">
          <p className="text-sm leading-relaxed">{copy.report.notReady}</p>
          <Button asChild className={LINK_BUTTON}>
            <Link to="/home">{copy.report.toTalk}</Link>
          </Button>
        </div>
      )}

      {data?.ready && data.content && (
        <>
          <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.report.lead}</p>
          {data.current && (
            <div className="mt-4 text-sm leading-relaxed">
              <p className="font-medium">{versionTitle(data.current)}</p>
              {data.current.changed.length > 0 && <p className="text-muted-foreground">{changedText(data.current.changed)}</p>}
            </div>
          )}

          <div className="mt-6 flex flex-col gap-4">
            <AbilitiesSection abilities={data.content.abilities} />
            <NotYetSection notYet={data.content.notYet} />
            <RecordsSection records={data.content.records} />
            <ChoiceSection choice={data.content.choice} busy={busy} failed={holdFailed} onHold={hold} />
            <ThinkingSection thinking={data.content.thinking} />
            <StepsSection
              steps={data.content.steps}
              deepen={deepen}
              onSaved={async (fresh) => {
                setDeepen(currentDeepen(fresh))
                await reload().catch(() => undefined)
              }}
              onChanged={async () => {
                const next = await reload().catch(() => null)
                if (next) await loadDeepen(next)
              }}
            />
            {data.previous.length > 0 && <PreviousVersions versions={data.previous} />}
          </div>
        </>
      )}

      {data?.ready && (
        <div className="mt-6">
          <Button asChild variant="outline" className="w-full sm:w-auto">
            <Link to="/home">{copy.report.backHome}</Link>
          </Button>
        </div>
      )}
    </Page>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={CARD_CLASS}>
      <h2 id={id} className="text-base font-bold">
        {title}
      </h2>
      {children}
    </section>
  )
}

function EditLink({ to, label }: { to: string; label: string }) {
  return (
    <Button asChild variant="outline" size="sm" className={LINK_BUTTON}>
      <Link to={to}>{label}</Link>
    </Button>
  )
}

function Note({ children }: { children: ReactNode }) {
  return <p className="text-sm leading-relaxed text-muted-foreground">{children}</p>
}

/**
 * 確かめた力 1 つ。名前と根拠の本人の言葉。showState のときは状態の言葉（呼び名は出さない）も添える。
 * できることの欄では、まとまりの見出しが状態を伝えるので添えない。
 */
function AbilityCard({ ability, showState }: { ability: ReportAbility; showState: boolean }) {
  const id = useId()
  return (
    <article aria-labelledby={id} className="min-w-0 rounded-lg bg-muted/40 px-3 py-3 text-sm leading-relaxed">
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span id={id} className="font-semibold">
          {ability.name}
        </span>
        {showState && <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{copy.report.abilityStates[ability.state]}</span>}
      </p>
      <QuoteList quotes={ability.quotes} />
    </article>
  )
}

/** できることの中の一つのまとまり（見えた力か、確かめ中の力）。 */
function AbilityGroup({ title, abilities }: { title: string; abilities: ReportAbility[] }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h3 id={id} className="text-sm font-semibold text-muted-foreground">
        {title}
      </h3>
      {abilities.map((ability) => (
        <AbilityCard key={ability.key} ability={ability} showState={false} />
      ))}
    </div>
  )
}

/**
 * できること。確かめ中の力も並ぶので、欄の見出しは根拠ありの呼び名にせず、5 つの記録の画面と同じく
 * 「あなたの話から見えた力」と「確かめ中」のまとまりに分ける（芯 1）。
 */
function AbilitiesSection({ abilities }: { abilities: ReportAbility[] }) {
  const seen = abilities.filter((a) => a.state === 'confirmed')
  const checking = abilities.filter((a) => a.state === 'needsCheck')
  return (
    <Section title={copy.report.sections.abilities}>
      {abilities.length === 0 && <p className="text-sm leading-relaxed">{copy.report.noAbilities}</p>}
      {seen.length > 0 && <AbilityGroup title={copy.report.seenTitle} abilities={seen} />}
      {checking.length > 0 && <AbilityGroup title={copy.report.checkingTitle} abilities={checking} />}
      <EditLink to="/abilities" label={copy.report.edit.abilities} />
    </Section>
  )
}

/** まだ確かめていないことの中身（いまの版）。 */
function NotYetBody({ notYet }: { notYet: ReportNotYet }) {
  const items = [
    ...(notYet.notHeard.length > 0 ? [copy.report.notHeard.replace('{names}', notYet.notHeard.join('、'))] : []),
    ...(notYet.checking.length > 0 ? [copy.report.checking.replace('{names}', notYet.checking.join('、'))] : []),
    ...notYet.taskGaps.flatMap((gap) => [
      ...(gap.abilityName ? [copy.report.taskAbility.replace('{task}', gap.taskName).replace('{name}', gap.abilityName)] : []),
      ...(gap.knowledge.length > 0
        ? [copy.report.taskKnowledge.replace('{task}', gap.taskName).replace('{items}', gap.knowledge.join('、'))]
        : []),
    ]),
  ]
  return (
    <>
      {items.length > 0 && (
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          {items.map((text) => (
            <li key={text} className="break-words">
              {text}
            </li>
          ))}
        </ul>
      )}
      {notYet.hasExcluded && <Note>{copy.profile.excludedNote}</Note>}
      {(notYet.notHeard.length > 0 || notYet.checking.length > 0) && <Note>{copy.insights.notYetNote}</Note>}
      <Note>{copy.deepen.workNote}</Note>
    </>
  )
}

/** 前の版のまだ確かめていないこと。力の状態を表す行は来ないので、業務に要る知識や道具だけを出す。 */
function SnapshotNotYet({ notYet }: { notYet: ReportSnapshotNotYet }) {
  const items = notYet.taskGaps.map((gap) =>
    copy.report.taskKnowledge.replace('{task}', gap.taskName).replace('{items}', gap.knowledge.join('、')),
  )
  return (
    <>
      {items.length > 0 && (
        <ul className="list-disc pl-5 text-sm leading-relaxed">
          {items.map((text) => (
            <li key={text} className="break-words">
              {text}
            </li>
          ))}
        </ul>
      )}
      {notYet.hasExcluded && <Note>{copy.profile.excludedNote}</Note>}
      <Note>{copy.deepen.workNote}</Note>
    </>
  )
}

function NotYetSection({ notYet }: { notYet: ReportNotYet }) {
  return (
    <Section title={copy.report.sections.notYet}>
      <NotYetBody notYet={notYet} />
      <EditLink to="/abilities" label={copy.report.edit.notYet} />
    </Section>
  )
}

function Entries({ entries }: { entries: ProfileEntry[] }) {
  if (entries.length === 0) return <p className="text-sm text-muted-foreground">{copy.profile.notDecided}</p>
  return (
    <ul className="flex flex-col gap-1 text-sm leading-relaxed">
      {entries.map((entry) => (
        <li key={entry.text} className="break-words">
          {entry.text}
          {entry.source === 'chosen' && <span className="text-muted-foreground">{copy.profile.chosen}</span>}
        </li>
      ))}
    </ul>
  )
}

/** 5 つの記録の中身（いまの版と前の版で同じ）。できることは、力の欄を指す（canDoNote は版ごとに指す見出しが違う）。 */
function RecordsBody({ records, Heading, canDoNote }: { records: ReportRecords; Heading: 'h3' | 'h5'; canDoNote: string }) {
  const { conditions } = records
  const head = 'text-sm font-semibold'
  return (
    <div className="flex flex-col gap-3">
      <div>
        <Heading className={head}>{copy.report.canDoTitle}</Heading>
        <p className="text-sm leading-relaxed">{canDoNote}</p>
      </div>
      <div>
        <Heading className={head}>{copy.profile.preferencesTitle}</Heading>
        <Entries entries={records.preferences} />
      </div>
      <div>
        <Heading className={head}>{copy.profile.wantsTitle}</Heading>
        <Entries entries={records.wants} />
      </div>
      <div>
        <Heading className={head}>{copy.profile.conditionsTitle}</Heading>
        {conditions ? (
          <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm leading-relaxed sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{copy.profile.timeSlotsLabel}</dt>
            <dd className="min-w-0 break-words">{conditions.timeSlots.map((slot) => copy.profile.timeSlotValues[slot]).join('、')}</dd>
            <dt className="text-muted-foreground">{copy.profile.hoursPerWeek}</dt>
            <dd>{copy.profile.hoursValue.replace('{n}', String(conditions.hoursPerWeek))}</dd>
            <dt className="text-muted-foreground">{copy.profile.place}</dt>
            <dd>{copy.profile.placeValues[conditions.place]}</dd>
            <dt className="text-muted-foreground">{copy.profile.monthlyIncome}</dt>
            <dd>
              {conditions.monthlyIncome === null
                ? copy.profile.incomeUndecided
                : copy.profile.incomeValue.replace('{n}', String(conditions.monthlyIncome))}
            </dd>
          </dl>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.profile.notDecided}</p>
        )}
      </div>
      <div>
        <Heading className={head}>{copy.profile.agencyTitle}</Heading>
        {records.agency ? (
          <p className="text-sm leading-relaxed break-words">{records.agency}</p>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.profile.notWritten}</p>
        )}
      </div>
    </div>
  )
}

function RecordsSection({ records }: { records: ReportRecords }) {
  return (
    <Section title={copy.report.sections.records}>
      <RecordsBody
        records={records}
        Heading="h3"
        canDoNote={copy.report.canDoNote.replace('{title}', copy.report.sections.abilities)}
      />
      <EditLink to="/profile" label={copy.report.edit.records} />
    </Section>
  )
}

function chosen(choice: Pick<ReportChoice, 'kind'>) {
  return choice.kind === 'card' || choice.kind === 'own'
}

/** 選んだ案の中身（いまの版と前の版で同じ）。理由と力は、いまの版だけが ChoiceSection で足す。 */
function ChoiceBody({ choice }: { choice: Omit<ReportChoice, 'reason' | 'ability'> }) {
  if (choice.kind === null) return <p className="text-sm leading-relaxed">{copy.report.noChoice}</p>
  if (choice.kind === 'hold') return <p className="text-sm leading-relaxed">{copy.report.holding}</p>
  const kind = choice.kind === 'own' || choice.card === null ? copy.report.ownKind : copy.options.kinds[choice.card].label
  return (
    <>
      <div>
        <p className="text-sm text-muted-foreground">{kind}</p>
        <p className="text-lg font-bold break-words">{choice.title}</p>
        {choice.summary && <p className="text-sm leading-relaxed break-words">{choice.summary}</p>}
      </div>
      {choice.tasks.length > 0 && (
        <div>
          <p className="text-sm text-muted-foreground">{copy.options.tasksTitle}</p>
          <ul className="mt-1 list-disc pl-5 text-sm leading-relaxed">
            {choice.tasks.map((task) => (
              <li key={task} className="break-words">
                {task}
              </li>
            ))}
          </ul>
        </div>
      )}
      {choice.demandNotChecked && <p className="text-sm leading-relaxed font-medium">{copy.options.createNotice}</p>}
      {choice.outsideConditions && <Note>{copy.options.chosenOutside}</Note>}
    </>
  )
}

function ChoiceSection({
  choice,
  busy,
  failed,
  onHold,
}: {
  choice: ReportChoice
  busy: boolean
  failed: boolean
  onHold: () => void
}) {
  return (
    <Section title={copy.report.sections.choice}>
      <ChoiceBody choice={choice} />
      {chosen(choice) && choice.reason && choice.ability && (
        <>
          <div>
            <p className="text-sm text-muted-foreground">{copy.options.reasonTitle}</p>
            <p className="text-sm leading-relaxed break-words">{choice.reason}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{copy.options.abilityTitle}</p>
            <AbilityCard ability={choice.ability} showState />
          </div>
        </>
      )}
      {chosen(choice) && choice.problem && (
        <Note>{choice.problem === 'excluded' ? copy.options.chosenExcluded : copy.options.chosenChanged}</Note>
      )}
      {choice.cardsStale && <Note>{copy.report.cardsStale}</Note>}
      <div className="flex flex-col gap-2 sm:flex-row">
        {chosen(choice) ? (
          <>
            <EditLink to="/options" label={copy.report.edit.choice} />
            <Button variant="outline" size="sm" className={LINK_BUTTON} disabled={busy} onClick={onHold}>
              {copy.options.hold}
            </Button>
          </>
        ) : (
          <EditLink to="/options" label={copy.report.toOptions} />
        )}
      </div>
      {failed && (
        <p role="alert" className="text-sm leading-relaxed">
          {copy.report.holdFailed}
        </p>
      )}
    </Section>
  )
}

function Thoughts({ thinking }: { thinking: ReportThought[] }) {
  if (thinking.length === 0) return <p className="text-sm leading-relaxed">{copy.report.noThoughts}</p>
  return (
    <ul className="flex flex-col gap-3">
      {thinking.map((thought) => (
        <li key={thought.situation} className="rounded-lg bg-muted/40 px-3 py-3 text-sm leading-relaxed">
          <p className="break-words">{thought.situation}</p>
          <p className="mt-1 font-medium break-words">{copy.deepen.yourAnswer.replace('{text}', thought.answer)}</p>
        </li>
      ))}
    </ul>
  )
}

function ThinkingSection({ thinking }: { thinking: ReportThought[] | null }) {
  return (
    <Section title={copy.report.sections.thinking}>
      {thinking === null ? (
        <>
          <p className="text-sm leading-relaxed">{copy.report.thinkingNotDeepened}</p>
          <EditLink to="/deepen" label={copy.report.toDeepen} />
        </>
      ) : (
        <>
          <Thoughts thinking={thinking} />
          {thinking.length > 0 && <Note>{copy.report.thinkingNote}</Note>}
          <EditLink to="/deepen" label={copy.report.edit.thinking} />
        </>
      )}
    </Section>
  )
}

function Steps({ steps }: { steps: ReportStep[] }) {
  if (steps.length === 0) return <p className="text-sm leading-relaxed">{copy.report.noSteps}</p>
  return (
    <ul className="flex flex-col gap-2">
      {steps.map((step, i) => (
        <li key={`${step.own}-${i}`} className="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-relaxed break-words">
          {step.text}
          {step.own && <span className="text-muted-foreground">{copy.report.ownStep}</span>}
          {!step.fits && <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs">{copy.deepen.stepOutside}</span>}
        </li>
      ))}
    </ul>
  )
}

/**
 * 最初の一歩。いまの案で深めた中身があれば「一歩を選び直す・書く」で、深める画面と同じ欄を開く。
 * 保存は、深める画面と同じく、見ていた中身の作った日時を添えて送る。
 */
function StepsSection({
  steps,
  deepen,
  onSaved,
  onChanged,
}: {
  steps: ReportStep[] | null
  deepen: DeepenContent | null
  onSaved: (fresh: DeepenContent | null) => Promise<void>
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  if (steps === null) {
    return (
      <Section title={copy.report.sections.steps}>
        <p className="text-sm leading-relaxed">{copy.report.stepsNotDeepened}</p>
        <EditLink to="/deepen" label={copy.report.toDeepen} />
      </Section>
    )
  }

  async function save(next: { chosen: string[]; own: string[] }): Promise<boolean> {
    if (deepen === null) return false
    setBusy(true)
    setNotice(null)
    try {
      const fresh = await putDeepenSteps(deepen.generatedAt, next)
      await onSaved(fresh.readiness === 'ready' ? fresh.content : null)
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 選んだ案か深めた中身か条件が変わっていた。読み直して、選ぶ欄を閉じる
        setOpen(false)
        setNotice(copy.report.stepsChanged)
        await onChanged()
      } else {
        setNotice(copy.deepen.saveFailed)
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  return (
    <Section title={copy.report.sections.steps}>
      <Steps steps={steps} />
      {deepen !== null &&
        (open ? (
          <>
            <StepsEditor content={deepen} busy={busy} notice={notice} onSave={save} />
            <Button variant="ghost" size="sm" className={LINK_BUTTON} onClick={() => setOpen(false)}>
              {copy.report.closeSteps}
            </Button>
          </>
        ) : (
          <Button variant="outline" size="sm" className={LINK_BUTTON} onClick={() => setOpen(true)}>
            {copy.report.editSteps}
          </Button>
        ))}
      {!open && notice && (
        <p role="alert" className="text-sm leading-relaxed">
          {notice}
        </p>
      )}
    </Section>
  )
}

/**
 * その時点の中身。力は名前だけで、状態（まだ確かめていないことの力の行も）、根拠の言葉、選んだ案の理由は出さない。
 * 力は見えた力と確かめ中の力を分けずに並ぶので、見出しは根拠ありの呼び名にせず、両方を含む言い方にする（芯 1）。
 */
function Snapshot({ snapshot }: { snapshot: ReportSnapshot }) {
  const head = 'text-sm font-semibold'
  return (
    <div className="flex flex-col gap-3">
      <div>
        <h4 className={head}>{copy.report.snapshotAbilities}</h4>
        {snapshot.abilities.length === 0 ? (
          <p className="text-sm leading-relaxed">{copy.report.noAbilities}</p>
        ) : (
          <p className="text-sm leading-relaxed">{snapshot.abilities.map((a) => a.name).join('、')}</p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h4 className={head}>{copy.report.sections.notYet}</h4>
        <SnapshotNotYet notYet={snapshot.notYet} />
      </div>
      <div>
        <h4 className={head}>{copy.report.sections.records}</h4>
        <RecordsBody records={snapshot.records} Heading="h5" canDoNote={copy.report.snapshotCanDoNote} />
      </div>
      <div className="flex flex-col gap-2">
        <h4 className={head}>{copy.report.sections.choice}</h4>
        <ChoiceBody choice={snapshot.choice} />
      </div>
      <div>
        <h4 className={head}>{copy.report.sections.thinking}</h4>
        {snapshot.thinking === null ? (
          <p className="text-sm leading-relaxed">{copy.report.thinkingNotDeepened}</p>
        ) : (
          <Thoughts thinking={snapshot.thinking} />
        )}
      </div>
      <div>
        <h4 className={head}>{copy.report.sections.steps}</h4>
        {snapshot.steps === null ? (
          <p className="text-sm leading-relaxed">{copy.report.stepsNotDeepened}</p>
        ) : (
          <Steps steps={snapshot.steps} />
        )}
      </div>
    </div>
  )
}

function VersionCard({ version }: { version: ReportVersion }) {
  const id = useId()
  return (
    <article aria-labelledby={id} className="flex min-w-0 flex-col gap-3 rounded-lg border px-3 py-3">
      <div className="text-sm leading-relaxed">
        <h3 id={id} className="font-semibold">
          {versionTitle(version)}
        </h3>
        {version.changed.length > 0 && <p className="text-muted-foreground">{changedText(version.changed)}</p>}
      </div>
      <Snapshot snapshot={version.snapshot} />
    </article>
  )
}

/** 前の版。「前の版を見る」で開く。見るだけで、戻すことはしない。 */
function PreviousVersions({ versions }: { versions: ReportVersion[] }) {
  const [open, setOpen] = useState(false)
  const id = useId()
  return (
    <div className="flex flex-col gap-3">
      <Button
        variant="outline"
        className={LINK_BUTTON}
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? copy.report.previousHide : copy.report.previousShow}
      </Button>
      {open && (
        <div id={id}>
          <Section title={copy.report.previousTitle}>
            {versions.map((version) => (
              <VersionCard key={version.number} version={version} />
            ))}
          </Section>
        </div>
      )}
    </div>
  )
}

