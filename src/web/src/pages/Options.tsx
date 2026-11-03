import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  addOwnJob,
  ApiError,
  deleteOptionChoice,
  deleteOwnJob,
  generateOptions,
  getOptions,
  isDailyLimit,
  putOptionChoice,
  updateOwnJob,
  type CardAbility,
  type CardKind,
  type CardTask,
  type ChooseCard,
  type CombineCard,
  type CreateCard,
  type MissingReason,
  type OptionChoice,
  type Options as OptionsData,
  type OwnJob,
  type TimeSlot,
  type WorkRange,
} from '@/api'
import { DailyLimitNotice } from '@/components/DailyLimitNotice'
import { QuoteList } from '@/components/Insights'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { hasVisibleText } from '@/lib/text'

type State = { kind: 'loading' } | { kind: 'ready'; data: OptionsData } | { kind: 'error' }

/** 作っているあいだの表示。regenerating は、元の記録が変わったので作り直しているとき。 */
type Generating = 'idle' | 'generating' | 'regenerating'

/** 作れなかったとき。failed は AI が失敗したか断った、limit は 1 日の送信回数の上限。 */
type GenerateError = { kind: 'failed' } | { kind: 'limit'; resetAt: string } | null

/** 選ぶ・書くで出す言葉と、出す場所。 */
type Notice = { where: 'choice' | 'own'; text: string } | null

const KINDS: CardKind[] = ['choose', 'combine', 'create']
const MAX_OWN_JOBS = 3
const MAX_TITLE_LENGTH = 100
const MAX_NOTE_LENGTH = 500

const FIELD_CLASS =
  'w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-base leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'
/** 3 枚のカードと出せないカードの枠。どれも同じ部品と見た目にする（options-1（3 枚を同じ重さで示す））。 */
const CARD_CLASS = 'flex min-w-0 flex-col gap-3 rounded-xl border px-4 py-4'

/** 円を万円にし、小数 1 けたまで出す。末尾の .0 は書かない。 */
function man(yen: number): string {
  return String(Number((yen / 10000).toFixed(1)))
}

function hoursText(min: number, max: number): string {
  return min === max
    ? copy.options.hoursOne.replace('{n}', String(min))
    : copy.options.hoursRange.replace('{min}', String(min)).replace('{max}', String(max))
}

function slotsText(slots: TimeSlot[]): string {
  return slots.map((slot) => copy.profile.timeSlotValues[slot]).join('、')
}

/**
 * 仕事の選択肢（05-options.md）。「選ぶ」「組み合わせる」「創る」の 3 枚を、同じ見た目で決まった順に並べる。
 * 本人は、カードを選ぶ、保留する、自分で考えた仕事を書いて選ぶ、のどれでもできる。
 * 元の記録が変わっていたら、開いたときに 1 回だけ作り直す。状態の呼び名、点数、順位は出さない。
 */
export function Options() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [generating, setGenerating] = useState<Generating>('idle')
  const [generateError, setGenerateError] = useState<GenerateError>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  // 開いたときの作り直しを 1 回だけにする印。StrictMode で画面を開く処理が 2 回走っても POST は 1 回
  const autoRegenerated = useRef(false)

  const generate = useCallback(async (mode: Exclude<Generating, 'idle'>) => {
    setGenerating(mode)
    setGenerateError(null)
    setNotice(null)
    try {
      const data = await generateOptions()
      setState({ kind: 'ready', data })
    } catch (e) {
      if (isDailyLimit(e)) {
        setGenerateError({ kind: 'limit', resetAt: e.resetAt ?? '' })
      } else if (e instanceof ApiError && e.status === 409) {
        // ほかの画面で記録が変わり、いまは進めない。読み直して、足りないものを出す
        try {
          setState({ kind: 'ready', data: await getOptions() })
        } catch {
          setGenerateError({ kind: 'failed' })
        }
      } else {
        setGenerateError({ kind: 'failed' })
      }
    } finally {
      setGenerating('idle')
    }
  }, [])

  useEffect(() => {
    let active = true
    getOptions()
      .then((data) => {
        if (!active) return
        setState({ kind: 'ready', data })
        if (data.readiness === 'ready' && data.cards?.stale && !autoRegenerated.current) {
          autoRegenerated.current = true
          void generate('regenerating')
        }
      })
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [generate])

  /** 選ぶ・書くを送る。失敗したら、その場所に穏やかな言葉を出す。できたら true。 */
  async function change(where: 'choice' | 'own', run: () => Promise<OptionsData>): Promise<boolean> {
    setBusy(true)
    setNotice(null)
    try {
      setState({ kind: 'ready', data: await run() })
      return true
    } catch (e) {
      if (where === 'choice' && e instanceof ApiError && e.status === 409) {
        // 見ていたカードが作り直されていた。読み直して、新しい案から選び直してもらう
        try {
          setState({ kind: 'ready', data: await getOptions() })
        } catch {
          // 読み直せなくても、言葉は出す
        }
        setNotice({ where, text: copy.options.changed })
      } else {
        setNotice({ where, text: copy.options.saveFailed })
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const data = state.kind === 'ready' ? state.data : null
  const ready = data?.readiness === 'ready'

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.options.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.options.lead}</p>

      {state.kind === 'loading' && <p className="mt-6 text-sm text-muted-foreground">{copy.loading}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="mt-6 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}

      {data && (
        <div className="mt-6 flex flex-col gap-4">
          {!ready && <NotReady readiness={data.readiness} />}

          <ChoiceArea
            choice={data.choice}
            canHold={ready}
            busy={busy}
            notice={notice?.where === 'choice' ? notice.text : null}
            onHold={() => change('choice', () => putOptionChoice({ kind: 'hold' }))}
            onClear={() => change('choice', deleteOptionChoice)}
          />

          {ready && (
            <>
              {generating !== 'idle' && (
                <p role="status" className="rounded-xl bg-muted/50 px-4 py-3 text-sm leading-relaxed">
                  {generating === 'regenerating' ? copy.options.regenerating : copy.options.generating}
                </p>
              )}
              {generateError?.kind === 'failed' && (
                <div className="flex flex-col gap-3">
                  <p role="alert" className="text-sm leading-relaxed">
                    {copy.options.generateFailed}
                  </p>
                  {data.cards && (
                    <Button
                      className="w-full sm:w-auto sm:self-start"
                      disabled={generating !== 'idle'}
                      onClick={() => generate(data.cards?.stale ? 'regenerating' : 'generating')}
                    >
                      {copy.options.retry}
                    </Button>
                  )}
                </div>
              )}
              {generateError?.kind === 'limit' && <DailyLimitNotice resetAt={generateError.resetAt} />}

              {data.cards === null && generateError?.kind !== 'limit' && (
                <Button
                  size="lg"
                  className="w-full sm:w-auto sm:self-start"
                  disabled={generating !== 'idle'}
                  onClick={() => generate('generating')}
                >
                  {generateError?.kind === 'failed' ? copy.options.retry : copy.options.generate}
                </Button>
              )}

              {data.cards !== null && (
                <>
                  <p className="text-sm leading-relaxed text-muted-foreground">{copy.options.noOrder}</p>
                  {KINDS.map((kind) => (
                    <OptionCard
                      key={kind}
                      kind={kind}
                      cards={data.cards!}
                      monthlyIncome={data.monthlyIncome}
                      busy={busy || generating !== 'idle'}
                      onChoose={() =>
                        change('choice', () =>
                          putOptionChoice({ kind: 'card', card: kind, generatedAt: data.cards!.generatedAt }),
                        )
                      }
                    />
                  ))}
                </>
              )}
            </>
          )}

          {(ready || data.ownJobs.length > 0) && (
            <OwnJobs
              jobs={data.ownJobs}
              busy={busy}
              notice={notice?.where === 'own' ? notice.text : null}
              onAdd={(job) => change('own', () => addOwnJob(job))}
              onUpdate={(id, job) => change('own', () => updateOwnJob(id, job))}
              onRemove={(id) => change('own', () => deleteOwnJob(id))}
              onChoose={(id) => change('choice', () => putOptionChoice({ kind: 'own', ownJobId: id }))}
            />
          )}

          {ready && <SourceSection source={data.source} />}
        </div>
      )}

      <div className="mt-6">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link to="/home">{copy.options.backHome}</Link>
        </Button>
      </div>
    </Page>
  )
}

function Section({ title, children, className }: { title: string; children: ReactNode; className?: string }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className={className ?? CARD_CLASS}>
      <h2 id={id} className="text-base font-bold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** 進めないときは、何をすれば進めるかを一つだけ伝える。「力がない」とは言わない（options-7（1 場面で進める））。 */
function NotReady({ readiness }: { readiness: OptionsData['readiness'] }) {
  const { text, to, link } =
    readiness === 'needsConditions'
      ? { text: copy.options.needsConditions, to: '/profile', link: copy.options.toProfile }
      : readiness === 'needsFinishedEpisode'
        ? { text: copy.options.needsFinishedEpisode, to: '/home', link: copy.options.toTalk }
        : readiness === 'onlyExcluded'
          ? { text: copy.options.onlyExcluded, to: '/abilities', link: copy.options.toAbilities }
          : { text: copy.options.needsAbility, to: '/home', link: copy.options.toTalk }
  return (
    <div className="flex flex-col gap-3 rounded-xl border px-4 py-4">
      <p className="text-sm leading-relaxed">{text}</p>
      <Button asChild className="w-full sm:w-auto sm:self-start">
        <Link to={to}>{link}</Link>
      </Button>
    </div>
  )
}

/**
 * 選んだ案。カードか書いた仕事を選んでいれば、その中身と「選び直す」。保留していれば、そのことと「保留をやめる」。
 * どちらでもなければ「保留する」を置く。
 */
function ChoiceArea({
  choice,
  canHold,
  busy,
  notice,
  onHold,
  onClear,
}: {
  choice: OptionChoice | null
  canHold: boolean
  busy: boolean
  notice: string | null
  onHold: () => void
  onClear: () => void
}) {
  const alert = notice && (
    <p role="alert" className="text-sm leading-relaxed">
      {notice}
    </p>
  )

  if (choice?.kind === 'hold') {
    return (
      <div className="flex flex-col gap-3 rounded-xl bg-muted/50 px-4 py-4">
        <p className="text-sm leading-relaxed">{copy.options.holding}</p>
        <Button variant="outline" className="w-full sm:w-auto sm:self-start" disabled={busy} onClick={onClear}>
          {copy.options.stopHold}
        </Button>
        {alert}
      </div>
    )
  }

  const chosen = choice?.kind === 'card' ? choice.card : null
  const own = choice?.kind === 'own' ? choice.ownJob : null
  if (chosen || own) {
    return (
      <Section title={copy.options.chosenTitle} className={`${CARD_CLASS} border-primary/40 bg-primary/5`}>
        {chosen && (
          <>
            <p className="text-sm text-muted-foreground">{copy.options.kinds[chosen.kind].label}</p>
            {chosen.choose && <ChooseBody card={chosen.choose} monthlyIncome={null} />}
            {chosen.combine && <CombineBody card={chosen.combine} monthlyIncome={null} />}
            {chosen.create && <CreateBody card={chosen.create} />}
            {chosen.abilityExcluded && <p className="text-sm leading-relaxed text-muted-foreground">{copy.options.chosenExcluded}</p>}
            {!chosen.abilityExcluded && chosen.abilityChanged && (
              <p className="text-sm leading-relaxed text-muted-foreground">{copy.options.chosenChanged}</p>
            )}
          </>
        )}
        {own && (
          <>
            <p className="text-sm text-muted-foreground">{copy.options.ownTitle}</p>
            <p className="font-semibold break-words">{own.title}</p>
            {own.note && <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{own.note}</p>}
          </>
        )}
        <Button variant="outline" className="w-full sm:w-auto sm:self-start" disabled={busy} onClick={onClear}>
          {copy.options.rechoose}
        </Button>
        {alert}
      </Section>
    )
  }

  if (!canHold && !alert) return null
  return (
    <div className="flex flex-col gap-3">
      {canHold && (
        <Button variant="outline" className="w-full sm:w-auto sm:self-start" disabled={busy} onClick={onHold}>
          {copy.options.hold}
        </Button>
      )}
      {alert}
    </div>
  )
}

/** カード 1 枚。出せないカードも同じ枠で、出せない理由と次にできることを示す。 */
function OptionCard({
  kind,
  cards,
  monthlyIncome,
  busy,
  onChoose,
}: {
  kind: CardKind
  cards: NonNullable<OptionsData['cards']>
  monthlyIncome: number | null
  busy: boolean
  onChoose: () => void
}) {
  const label = copy.options.kinds[kind]
  let body: ReactNode = null
  if (kind === 'choose' && cards.choose) body = <ChooseBody card={cards.choose} monthlyIncome={monthlyIncome} />
  if (kind === 'combine' && cards.combine) body = <CombineBody card={cards.combine} monthlyIncome={monthlyIncome} />
  if (kind === 'create' && cards.create) body = <CreateBody card={cards.create} />

  return (
    <Section title={label.label}>
      <p className="-mt-2 text-sm text-muted-foreground">{label.note}</p>
      {body ? (
        <>
          {body}
          <Button className="w-full sm:w-auto sm:self-start" disabled={busy} onClick={onChoose}>
            {copy.options.chooseThis}
          </Button>
        </>
      ) : (
        <Missing reason={cards.missing.find((m) => m.kind === kind)?.reason ?? 'rejected'} />
      )}
    </Section>
  )
}

/**
 * 出せないカードの理由と、次にできること。同じ記録のまま作り直す道は置かない（05-options.md の「やらないこと」）。
 * 外した見立てのカードと、力の状態か根拠の言葉が変わったカードは、記録が変わっているので、開いたときに作り直す。
 */
function Missing({ reason }: { reason: MissingReason }) {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm leading-relaxed">{copy.options.missing[reason]}</p>
      {reason === 'noFit' && (
        <Button asChild variant="outline" className="w-full sm:w-auto sm:self-start">
          <Link to="/profile">{copy.options.toConditions}</Link>
        </Button>
      )}
      {reason === 'noAbilityMatch' && (
        <Button asChild variant="outline" className="w-full sm:w-auto sm:self-start">
          <Link to="/home">{copy.options.toTalk}</Link>
        </Button>
      )}
    </div>
  )
}

function ChooseBody({ card, monthlyIncome }: { card: ChooseCard; monthlyIncome: number | null }) {
  return (
    <>
      <div>
        <h3 className="text-lg font-bold break-words">{card.occupationName}</h3>
        <p className="mt-1 text-sm leading-relaxed break-words">{card.summary}</p>
      </div>
      <Tasks tasks={card.tasks} withOccupation={false} />
      <Range range={card.range} monthlyIncome={monthlyIncome} />
      <Reason reason={card.reason} ability={card.ability} />
    </>
  )
}

function CombineBody({ card, monthlyIncome }: { card: CombineCard; monthlyIncome: number | null }) {
  return (
    <>
      <h3 className="text-lg font-bold break-words">{card.roleName}</h3>
      <Tasks tasks={card.tasks} withOccupation />
      <Range range={card.range} monthlyIncome={monthlyIncome} />
      <Reason reason={card.reason} ability={card.ability} />
    </>
  )
}

/** 事業のアイデア。需要をまだ確かめていないことをいつも出し、収入の数字は出さない。 */
function CreateBody({ card }: { card: CreateCard }) {
  const labels = copy.options.createLabels
  const rows: [string, string][] = [
    [labels.who, card.who],
    [labels.trouble, card.trouble],
    ...(card.ability ? [[labels.ability, card.ability.name] as [string, string]] : []),
    [
      labels.conditions,
      `${hoursText(card.hoursPerWeek, card.hoursPerWeek)}、${slotsText(card.timeSlots)}、${copy.options.placeValues[card.place]}`,
    ],
  ]
  return (
    <>
      <h3 className="text-lg font-bold break-words">{card.title}</h3>
      <dl className="flex flex-col gap-2 text-sm leading-relaxed">
        {rows.map(([term, value]) => (
          <div key={term}>
            <dt className="text-muted-foreground">{term}</dt>
            <dd className="break-words">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="text-sm leading-relaxed break-words">{card.summary}</p>
      <div className="rounded-lg bg-muted/50 px-3 py-2 text-sm leading-relaxed">
        <p className="font-medium">{copy.options.createNotice}</p>
        <p className="text-muted-foreground">{copy.options.createIncome}</p>
      </div>
      <Reason reason={card.reason} ability={card.ability} />
    </>
  )
}

function Tasks({ tasks, withOccupation }: { tasks: CardTask[]; withOccupation: boolean }) {
  return (
    <div>
      <p className="text-sm text-muted-foreground">{copy.options.tasksTitle}</p>
      <ul className="mt-1 flex flex-col gap-2">
        {tasks.map((task) => (
          <li key={task.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-relaxed break-words">
            <p className="font-medium">{withOccupation ? `${task.name}（${task.occupationName}）` : task.name}</p>
            <p>{task.detail}</p>
            <p className="text-muted-foreground">{`${slotsText(task.timeSlots)}、${copy.options.placeValues[task.place]}`}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** 週あたりの時間と収入の目安。本人の目安があれば並べる。収入で絞り込みはしない（options-5（条件の範囲だけ））。 */
function Range({ range, monthlyIncome }: { range: WorkRange; monthlyIncome: number | null }) {
  return (
    <div className="text-sm leading-relaxed">
      <p>{hoursText(range.minHours, range.maxHours)}</p>
      <p>
        {copy.options.incomeRange.replace('{min}', man(range.minMonthlyYen)).replace('{max}', man(range.maxMonthlyYen))}
      </p>
      {monthlyIncome !== null && (
        <p className="text-muted-foreground">{copy.options.incomeTarget.replace('{n}', String(monthlyIncome))}</p>
      )}
    </div>
  )
}

/**
 * 理由と、使った力、その根拠の本人の言葉（options-8（理由は本人の言葉とつなぐ））。
 * 選んだ案の力を本人があとで外したときは、どちらも来ないので出さない。
 */
function Reason({ reason, ability }: { reason: string | null; ability: CardAbility | null }) {
  if (reason === null || ability === null) return null
  return (
    <div className="flex flex-col gap-2">
      <div>
        <p className="text-sm text-muted-foreground">{copy.options.reasonTitle}</p>
        <p className="mt-1 text-sm leading-relaxed break-words">{reason}</p>
      </div>
      <div>
        <p className="text-sm text-muted-foreground">{copy.options.abilityTitle}</p>
        <p className="mt-1 flex flex-wrap items-baseline gap-x-2 text-sm">
          <span className="font-semibold">{ability.name}</span>
          <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{copy.options.abilityStates[ability.state]}</span>
        </p>
        <QuoteList quotes={ability.quotes} />
      </div>
    </div>
  )
}

/** 自分で考えた仕事。3 つまで書け、どれも「選んだ案」にできる。 */
function OwnJobs({
  jobs,
  busy,
  notice,
  onAdd,
  onUpdate,
  onRemove,
  onChoose,
}: {
  jobs: OwnJob[]
  busy: boolean
  notice: string | null
  onAdd: (job: { title: string; note: string }) => Promise<boolean>
  onUpdate: (id: string, job: { title: string; note: string }) => Promise<boolean>
  onRemove: (id: string) => Promise<boolean>
  onChoose: (id: string) => Promise<boolean>
}) {
  // 'new' は書き足している、id はその仕事を直している
  const [editing, setEditing] = useState<string | null>(null)

  return (
    <Section title={copy.options.ownTitle}>
      {jobs.length > 0 && (
        <ul className="flex flex-col gap-3">
          {jobs.map((job) =>
            editing === job.id ? (
              <li key={job.id}>
                <OwnJobForm
                  initial={job}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={async (value) => {
                    if (await onUpdate(job.id, value)) setEditing(null)
                  }}
                />
              </li>
            ) : (
              <li key={job.id} className="flex flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3">
                <p className="font-semibold break-words">{job.title}</p>
                {job.note && <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{job.note}</p>}
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    disabled={busy}
                    aria-label={copy.options.chooseOwnLabel.replace('{text}', job.title)}
                    onClick={() => onChoose(job.id)}
                  >
                    {copy.options.ownChoose}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    aria-label={copy.options.editLabel.replace('{text}', job.title)}
                    onClick={() => setEditing(job.id)}
                  >
                    {copy.options.edit}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={copy.options.removeLabel.replace('{text}', job.title)}
                    onClick={() => onRemove(job.id)}
                  >
                    {copy.options.remove}
                  </Button>
                </div>
              </li>
            ),
          )}
        </ul>
      )}

      {editing === 'new' ? (
        <OwnJobForm
          initial={null}
          busy={busy}
          onCancel={() => setEditing(null)}
          onSave={async (value) => {
            if (await onAdd(value)) setEditing(null)
          }}
        />
      ) : jobs.length < MAX_OWN_JOBS ? (
        <Button variant="outline" className="w-full sm:w-auto sm:self-start" disabled={busy} onClick={() => setEditing('new')}>
          {copy.options.ownAdd}
        </Button>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.options.ownMax}</p>
      )}

      {notice && (
        <p role="alert" className="text-sm leading-relaxed">
          {notice}
        </p>
      )}
    </Section>
  )
}

/** 自分で考えた仕事の名前とメモ。見える文字のない名前は、空の項目になるので保存しない（裏側も断る）。 */
function OwnJobForm({
  initial,
  busy,
  onSave,
  onCancel,
}: {
  initial: OwnJob | null
  busy: boolean
  onSave: (job: { title: string; note: string }) => void
  onCancel: () => void
}) {
  const titleId = useId()
  const noteId = useId()
  const hintId = useId()
  const [title, setTitle] = useState(initial?.title ?? '')
  const [note, setNote] = useState(initial?.note ?? '')
  const canSave = hasVisibleText(title)

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave && !busy) onSave({ title: title.trim(), note: note.trim() })
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={titleId} className="text-sm font-medium">
          {copy.options.ownTitleLabel}
        </label>
        <input
          id={titleId}
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={MAX_TITLE_LENGTH}
          aria-describedby={canSave ? undefined : hintId}
          className={FIELD_CLASS}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={noteId} className="text-sm font-medium">
          {copy.options.ownNoteLabel}
        </label>
        <textarea
          id={noteId}
          value={note}
          onChange={(event) => setNote(event.target.value)}
          maxLength={MAX_NOTE_LENGTH}
          rows={3}
          className={FIELD_CLASS}
        />
      </div>
      {!canSave && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {copy.options.ownNeedTitle}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!canSave || busy}>
          {copy.options.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {copy.options.cancel}
        </Button>
      </div>
    </form>
  )
}

/** 職種と業務のデータの出典（job tag の利用規約の記載例どおり）。 */
function SourceSection({ source }: { source: OptionsData['source'] }) {
  return (
    <Section title={copy.options.sourceTitle} className="flex min-w-0 flex-col gap-2 px-1 py-2 text-sm">
      <p className="leading-relaxed text-muted-foreground">{copy.options.sourceLead}</p>
      <p className="leading-relaxed break-words text-muted-foreground">{source.text}</p>
      <a href={source.url} target="_blank" rel="noreferrer" className="break-words text-primary underline underline-offset-4">
        {copy.options.sourceLink}
        {copy.talk.newTab}
      </a>
    </Section>
  )
}
