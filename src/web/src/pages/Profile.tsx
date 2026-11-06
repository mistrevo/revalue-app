import { useEffect, useId, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import {
  getProfile,
  putAgency,
  putConditions,
  putPreferences,
  putWants,
  type CanDoAbility,
  type Place,
  type Profile as ProfileData,
  type ProfileConditions,
  type ProfileEntry,
  type ProfileQuestion,
  type TimeSlot,
} from '@/api'
import { QuoteList } from '@/components/Insights'
import { NextStepLink } from '@/components/NextStepLink'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { hasVisibleText } from '@/lib/text'

type State = { kind: 'loading' } | { kind: 'ready'; data: ProfileData } | { kind: 'error' }

/** 本人が答えて直す 4 つの記録。できることは見えた力の画面とその話から直す。 */
type RecordKey = 'preferences' | 'wants' | 'conditions' | 'agency'

/** 失敗を出す場所。next は「いま聞きたいこと」。 */
type Where = 'next' | RecordKey

/**
 * 何から保存したか。input は入力欄（書いた言葉、条件、主体性）、button は選択肢、「消す」、「いまは決めない」「いまは書かない」。
 * 失敗したときに、入れた内容を残したと伝えるのは input のときだけ。
 */
type SavedFrom = 'input' | 'button'

type Failure = { where: Where; from: SavedFrom }

/** ack は、保存できたら「いま聞きたいこと」に出す受け止めの一文。 */
type Save = (where: Where, from: SavedFrom, run: () => Promise<ProfileData>, ack?: string) => Promise<void>

function fromEntry(entry: ProfileEntry): SavedFrom {
  return entry.source === 'written' ? 'input' : 'button'
}

const TIME_SLOTS: TimeSlot[] = ['morning', 'daytime', 'evening', 'night']
const PLACES: Place[] = ['homeOnly', 'canGoOut']
const MAX_ENTRIES = 5
const MAX_ENTRY_LENGTH = 100
const MAX_AGENCY_LENGTH = 500

const FIELD_CLASS =
  'w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-base leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'
const WRAP_BUTTON = 'h-auto w-full justify-start py-2 text-left whitespace-normal'

/**
 * 「いま聞きたいこと」に出す問い（04-profile.md の「聞く順番」）。好み、やりたいこと、条件、主体性の順で、まだ済んでいない最初の一つ。
 * 条件を入れる入口（`?ask=conditions`）から来たときは、条件が入っていなければ条件を先に聞く。どれも済んでいれば null。
 */
function nextQuestion(profile: ProfileData, conditionsFirst = false): RecordKey | null {
  if (conditionsFirst && profile.conditions === null) return 'conditions'
  if (!profile.asked.preferences) return 'preferences'
  if (!profile.asked.wants) return 'wants'
  if (profile.conditions === null) return 'conditions'
  if (!profile.asked.agency) return 'agency'
  return null
}

/**
 * 5 つの記録（04-profile.md）。上に「いま聞きたいこと」を一つだけ出し、その下に、できること、好み、やりたいこと、条件、主体性を
 * 別々の欄で並べる。どの欄も本人が直せる。状態の呼び名、点数、順位は出さない。
 */
export function Profile() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<Failure | null>(null)
  const [editing, setEditing] = useState<RecordKey | null>(null)
  const [ack, setAck] = useState<string | null>(null)
  const [searchParams] = useSearchParams()
  const conditionsFirst = searchParams.get('ask') === 'conditions'

  useEffect(() => {
    let active = true
    getProfile()
      .then((data) => active && setState({ kind: 'ready', data }))
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  /**
   * 保存する。失敗したら、その場所に穏やかな言葉を出し、入れた内容は入力欄に残したままにする。
   * できたら、保存した欄の入力だけを閉じる。ほかの欄の書きかけは残す（Claude の判断）。
   */
  const save: Save = async (where, from, run, nextAck) => {
    setBusy(true)
    setFailure(null)
    setAck(null)
    try {
      const data = await run()
      setState({ kind: 'ready', data })
      setEditing((current) => (current === where ? null : current))
      setAck(nextAck ?? null)
    } catch {
      setFailure({ where, from })
    } finally {
      setBusy(false)
    }
  }

  function failedAt(where: Where): SavedFrom | null {
    return failure?.where === where ? failure.from : null
  }

  function startEditing(record: RecordKey) {
    setFailure(null)
    setEditing(record)
  }

  function stopEditing() {
    setFailure(null)
    setEditing(null)
  }

  // 「いま聞きたいこと」に出している記録。その欄には入れる入口を出さず、同じ入力欄を 2 つ並べない（Claude の判断）
  const asking = state.kind === 'ready' ? nextQuestion(state.data, conditionsFirst) : null

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.profile.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.profile.lead}</p>

      {state.kind === 'loading' && <p className="mt-6 text-sm text-muted-foreground">{copy.loading}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="mt-6 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}
      {state.kind === 'ready' && (
        <div className="mt-6 flex flex-col gap-4">
          <NextQuestion
            profile={state.data}
            conditionsFirst={conditionsFirst}
            ack={ack}
            busy={busy}
            failed={failedAt('next')}
            save={save}
          />
          <CanDoSection canDo={state.data.canDo} />
          {(['preferences', 'wants'] as const).map((record) => (
            <EntriesSection
              key={record}
              title={record === 'preferences' ? copy.profile.preferencesTitle : copy.profile.wantsTitle}
              entries={state.data[record]}
              question={state.data.questions[record]}
              asking={asking === record}
              adding={editing === record}
              busy={busy}
              failed={failedAt(record)}
              onAdd={() => startEditing(record)}
              onCancel={stopEditing}
              onSave={(entries, from) =>
                save(record, from, () => (record === 'preferences' ? putPreferences(entries) : putWants(entries)))
              }
            />
          ))}
          <ConditionsSection
            profile={state.data}
            asking={asking === 'conditions'}
            editing={editing === 'conditions'}
            busy={busy}
            failed={failedAt('conditions')}
            onEdit={() => startEditing('conditions')}
            onCancel={stopEditing}
            onSave={(conditions) => save('conditions', 'input', () => putConditions(conditions))}
          />
          <AgencySection
            agency={state.data.agency}
            asking={asking === 'agency'}
            editing={editing === 'agency'}
            busy={busy}
            failed={failedAt('agency')}
            onEdit={() => startEditing('agency')}
            onCancel={stopEditing}
            onSave={(text) => save('agency', 'input', () => putAgency(text))}
          />
        </div>
      )}
      {state.kind === 'ready' && <NextStepLink refreshKey={state.data} />}

      <div className="mt-6">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link to="/talk">{copy.nav.backToTalk}</Link>
        </Button>
      </div>
    </Page>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3 rounded-xl border px-4 py-4">
      <h2 id={id} className="text-base font-bold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/** 保存に失敗したときの言葉。入力欄から保存したときだけ、入れた内容を残していると伝える。 */
function SaveFailed({ from }: { from: SavedFrom | null }) {
  if (from === null) return null
  return (
    <p role="alert" className="text-sm leading-relaxed">
      {from === 'input' ? copy.profile.saveFailed : copy.profile.saveFailedRetry}
    </p>
  )
}

/**
 * 「いま聞きたいこと」。答えたら、次の問いの上に受け止めの一文を出す。答えは本人の言葉のまま映し返し、褒め言葉は足さない
 * （04-profile.md の「聞く順番」。Claude の判断）。問いがすべて済んだら、受け止めの一文だけを出す。
 */
function NextQuestion({
  profile,
  conditionsFirst,
  ack,
  busy,
  failed,
  save,
}: {
  profile: ProfileData
  conditionsFirst: boolean
  ack: string | null
  busy: boolean
  failed: SavedFrom | null
  save: Save
}) {
  const next = nextQuestion(profile, conditionsFirst)
  const ackLine = ack && (
    <p role="status" className="text-sm leading-relaxed break-words">
      {ack}
    </p>
  )
  if (next === null) return ackLine || null

  let body: ReactNode
  if (next === 'preferences' || next === 'wants') {
    const entries = profile[next]
    const put = next === 'preferences' ? putPreferences : putWants
    const record = next === 'preferences' ? copy.profile.preferencesTitle : copy.profile.wantsTitle
    body = (
      <EntryPicker
        key={next}
        question={profile.questions[next]}
        taken={entries}
        busy={busy}
        onPick={(entry) =>
          save(
            'next',
            fromEntry(entry),
            () => put([...entries, entry]),
            copy.profile.ackPicked.replace('{text}', entry.text).replace('{record}', record),
          )
        }
        extra={
          <Button
            type="button"
            variant="ghost"
            className={WRAP_BUTTON}
            disabled={busy}
            onClick={() => save('next', 'button', () => put(entries), copy.profile.ackSkipped.replace('{record}', record))}
          >
            {copy.profile.notNow}
          </Button>
        }
      />
    )
  } else if (next === 'conditions') {
    // 条件には、あとにする道を置かない（仕事の選択肢に要るため）
    body = (
      <ConditionsForm
        initial={null}
        options={profile.conditionOptions}
        busy={busy}
        onSave={(conditions) => save('next', 'input', () => putConditions(conditions), copy.profile.ackConditions)}
      />
    )
  } else {
    body = (
      <AgencyForm
        initial=""
        busy={busy}
        onSave={(text) =>
          save(
            'next',
            'input',
            () => putAgency(text),
            hasVisibleText(text) ? copy.profile.ackAgency : copy.profile.ackAgencySkipped,
          )
        }
        extra={
          <Button
            type="button"
            variant="ghost"
            className="w-full sm:w-auto"
            disabled={busy}
            onClick={() => save('next', 'button', () => putAgency(''), copy.profile.ackAgencySkipped)}
          >
            {copy.profile.notNowAgency}
          </Button>
        }
      />
    )
  }

  return (
    <Section title={copy.profile.nextTitle}>
      {ackLine}
      {body}
      <SaveFailed from={failed} />
    </Section>
  )
}

/**
 * 問いと、選択肢、「自分で書く」。もう入っている選択肢は出さない。書いた言葉は、保存に失敗しても欄に残す。
 * 見える文字がない言葉（空白や幅のない空白だけ）は、空の項目になるので保存しない（裏側も断る）。
 */
function EntryPicker({
  question,
  taken,
  busy,
  onPick,
  extra,
}: {
  question: ProfileQuestion
  taken: ProfileEntry[]
  busy: boolean
  onPick: (entry: ProfileEntry) => void
  extra: ReactNode
}) {
  const inputId = useId()
  const [writing, setWriting] = useState(false)
  const [text, setText] = useState('')
  const written = text.trim()
  const canSave = hasVisibleText(written)
  const choices = question.choices.filter((choice) => !taken.some((entry) => entry.text === choice))

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <p className="text-sm leading-relaxed font-medium">{question.question}</p>
      {choices.map((choice) => (
        <Button
          key={choice}
          variant="outline"
          className={WRAP_BUTTON}
          disabled={busy}
          onClick={() => onPick({ text: choice, source: 'chosen' })}
        >
          {choice}
        </Button>
      ))}
      {writing ? (
        <form
          className="flex min-w-0 flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (canSave) onPick({ text: written, source: 'written' })
          }}
        >
          <label htmlFor={inputId} className="text-sm font-medium">
            {copy.profile.writeOwn}
          </label>
          <input
            id={inputId}
            type="text"
            value={text}
            onChange={(event) => setText(event.target.value)}
            maxLength={MAX_ENTRY_LENGTH}
            className={FIELD_CLASS}
          />
          <Button type="submit" className="w-full sm:w-auto sm:self-start" disabled={busy || !canSave}>
            {copy.profile.save}
          </Button>
        </form>
      ) : (
        <Button type="button" variant="outline" className={WRAP_BUTTON} disabled={busy} onClick={() => setWriting(true)}>
          {copy.profile.writeOwn}
        </Button>
      )}
      {extra}
    </div>
  )
}

/**
 * できること。見えた力も確かめ中の力も外した力もないときは、「ない」とは言わずに何が入るかを伝え、直す道の代わりに
 * トークへの道を置く。外した力しかないときは、外した注記と、戻せる見えた力の画面への道だけを出す（Claude の判断）。
 */
function CanDoSection({ canDo }: { canDo: ProfileData['canDo'] }) {
  const empty = canDo.seen.length === 0 && canDo.checking.length === 0 && !canDo.hasExcluded
  const linkClass = 'text-sm font-medium text-primary underline underline-offset-4'
  return (
    <Section title={copy.profile.canDoTitle}>
      {canDo.seen.length > 0 && <CanDoGroup title={copy.profile.seenTitle} abilities={canDo.seen} paired />}
      {canDo.checking.length > 0 && <CanDoGroup title={copy.profile.checkingTitle} abilities={canDo.checking} />}
      {empty && <p className="text-sm leading-relaxed text-muted-foreground">{copy.profile.canDoEmpty}</p>}
      {canDo.hasExcluded && <p className="text-sm leading-relaxed text-muted-foreground">{copy.profile.excludedNote}</p>}
      {empty ? (
        <Link to="/talk" className={linkClass}>
          {copy.profile.canDoTalk}
        </Link>
      ) : (
        <Link to="/abilities" className={linkClass}>
          {copy.profile.openAbilities}
        </Link>
      )}
    </Section>
  )
}

function CanDoGroup({ title, abilities, paired = false }: { title: string; abilities: CanDoAbility[]; paired?: boolean }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h3 id={id} className="text-sm font-semibold text-muted-foreground">
        {title}
      </h3>
      {abilities.map((ability) => (
        <div key={ability.key} className="min-w-0">
          <h4 className="text-sm font-semibold">{ability.name}</h4>
          <QuoteList quotes={ability.quotes} paired={paired} />
          {ability.episodeId && (
            <Link
              to={`/talk/${ability.episodeId}`}
              className="mt-2 inline-block text-sm font-medium text-primary underline underline-offset-4"
            >
              {copy.profile.openEpisode}
            </Link>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * 好みかやりたいことの欄。項目ごとに消せ、問いの選択肢を選ぶか書いて足せる。
 * asking（「いま聞きたいこと」にこの問いを出している）のあいだは、「足す」を出さない。
 */
function EntriesSection({
  title,
  entries,
  question,
  asking,
  adding,
  busy,
  failed,
  onAdd,
  onCancel,
  onSave,
}: {
  title: string
  entries: ProfileEntry[]
  question: ProfileQuestion
  asking: boolean
  adding: boolean
  busy: boolean
  failed: SavedFrom | null
  onAdd: () => void
  onCancel: () => void
  onSave: (entries: ProfileEntry[], from: SavedFrom) => void
}) {
  return (
    <Section title={title}>
      {entries.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.text} className="flex min-w-0 items-start justify-between gap-2 text-sm leading-relaxed">
              <span className="min-w-0 break-words">
                {entry.text}
                {entry.source === 'chosen' && <span className="text-muted-foreground">{copy.profile.chosen}</span>}
              </span>
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                aria-label={copy.profile.removeLabel.replace('{text}', entry.text)}
                onClick={() => onSave(entries.filter((other) => other !== entry), 'button')}
              >
                {copy.profile.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.profile.notDecided}</p>
      )}
      {asking ? null : adding ? (
        <EntryPicker
          question={question}
          taken={entries}
          busy={busy}
          onPick={(entry) => onSave([...entries, entry], fromEntry(entry))}
          extra={
            <Button type="button" variant="ghost" className={WRAP_BUTTON} disabled={busy} onClick={onCancel}>
              {copy.profile.cancel}
            </Button>
          }
        />
      ) : (
        entries.length < MAX_ENTRIES && (
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={onAdd}>
            {copy.profile.add}
          </Button>
        )
      )}
      <SaveFailed from={failed} />
    </Section>
  )
}

function hoursText(hours: number) {
  return copy.profile.hoursValue.replace('{n}', String(hours))
}

function incomeText(income: number | null) {
  return income === null ? copy.profile.incomeUndecided : copy.profile.incomeValue.replace('{n}', String(income))
}

/** 条件の欄。いつでも書き直せる。asking（「いま聞きたいこと」に条件を出している）のあいだは、「入れる」を出さない。 */
function ConditionsSection({
  profile,
  asking,
  editing,
  busy,
  failed,
  onEdit,
  onCancel,
  onSave,
}: {
  profile: ProfileData
  asking: boolean
  editing: boolean
  busy: boolean
  failed: SavedFrom | null
  onEdit: () => void
  onCancel: () => void
  onSave: (conditions: ProfileConditions) => void
}) {
  const conditions = profile.conditions
  return (
    <Section title={copy.profile.conditionsTitle}>
      {editing && !asking ? (
        <ConditionsForm
          initial={conditions}
          options={profile.conditionOptions}
          busy={busy}
          onSave={onSave}
          extra={
            <Button type="button" variant="ghost" className="w-full sm:w-auto" disabled={busy} onClick={onCancel}>
              {copy.profile.cancel}
            </Button>
          }
        />
      ) : (
        <>
          {conditions ? (
            <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-sm leading-relaxed sm:grid-cols-[auto_1fr]">
              <dt className="text-muted-foreground">{copy.profile.timeSlotsLabel}</dt>
              <dd className="min-w-0 break-words">{conditions.timeSlots.map((slot) => copy.profile.timeSlotValues[slot]).join('、')}</dd>
              <dt className="text-muted-foreground">{copy.profile.hoursPerWeek}</dt>
              <dd>{hoursText(conditions.hoursPerWeek)}</dd>
              <dt className="text-muted-foreground">{copy.profile.place}</dt>
              <dd>{copy.profile.placeValues[conditions.place]}</dd>
              <dt className="text-muted-foreground">{copy.profile.monthlyIncome}</dt>
              <dd>{incomeText(conditions.monthlyIncome)}</dd>
            </dl>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.profile.notDecided}</p>
          )}
          {!asking && (
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={onEdit}>
              {conditions ? copy.profile.edit : copy.profile.enter}
            </Button>
          )}
        </>
      )}
      <SaveFailed from={failed} />
    </Section>
  )
}

/**
 * 条件の入力。何のために聞くかを一文で添える。時間帯はいくつでも、ほかは一つずつ選ぶ。
 * 収入の目安は「まだ決めていない」から始め、比べて示すためだけに使うと添える（Claude の判断）。
 */
function ConditionsForm({
  initial,
  options,
  busy,
  onSave,
  extra,
}: {
  initial: ProfileConditions | null
  options: ProfileData['conditionOptions']
  busy: boolean
  onSave: (conditions: ProfileConditions) => void
  extra?: ReactNode
}) {
  const name = useId()
  const [slots, setSlots] = useState<TimeSlot[]>(initial?.timeSlots ?? [])
  const [hours, setHours] = useState<number | null>(initial?.hoursPerWeek ?? null)
  const [place, setPlace] = useState<Place | null>(initial?.place ?? null)
  const [income, setIncome] = useState<number | null>(initial?.monthlyIncome ?? null)
  const ready = slots.length > 0 && hours !== null && place !== null

  function toggleSlot(slot: TimeSlot, checked: boolean) {
    setSlots((current) => TIME_SLOTS.filter((s) => (s === slot ? checked : current.includes(s))))
  }

  return (
    <form
      className="flex min-w-0 flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (slots.length > 0 && hours !== null && place !== null) onSave({ timeSlots: slots, hoursPerWeek: hours, place, monthlyIncome: income })
      }}
    >
      <p className="text-sm leading-relaxed font-medium">{copy.profile.conditionsQuestion}</p>
      <Fieldset legend={copy.profile.timeSlots}>
        {TIME_SLOTS.map((slot) => (
          <Choice key={slot} label={copy.profile.timeSlotValues[slot]}>
            <input
              type="checkbox"
              checked={slots.includes(slot)}
              onChange={(event) => toggleSlot(slot, event.target.checked)}
              className="size-4 shrink-0 accent-primary"
            />
          </Choice>
        ))}
      </Fieldset>
      <Fieldset legend={copy.profile.hoursPerWeek}>
        {options.hoursPerWeek.map((n) => (
          <Choice key={n} label={hoursText(n)}>
            <input
              type="radio"
              name={`${name}-hours`}
              checked={hours === n}
              onChange={() => setHours(n)}
              className="size-4 shrink-0 accent-primary"
            />
          </Choice>
        ))}
      </Fieldset>
      <Fieldset legend={copy.profile.place}>
        {PLACES.map((p) => (
          <Choice key={p} label={copy.profile.placeValues[p]}>
            <input
              type="radio"
              name={`${name}-place`}
              checked={place === p}
              onChange={() => setPlace(p)}
              className="size-4 shrink-0 accent-primary"
            />
          </Choice>
        ))}
      </Fieldset>
      <Fieldset legend={copy.profile.monthlyIncome} note={copy.profile.incomeNote}>
        {[...options.monthlyIncome, null].map((n) => (
          <Choice key={n ?? 'undecided'} label={incomeText(n)}>
            <input
              type="radio"
              name={`${name}-income`}
              checked={income === n}
              onChange={() => setIncome(n)}
              className="size-4 shrink-0 accent-primary"
            />
          </Choice>
        ))}
      </Fieldset>
      {!ready && <p className="text-sm leading-relaxed text-muted-foreground">{copy.profile.conditionsNeed}</p>}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" className="w-full sm:w-auto" disabled={busy || !ready}>
          {copy.profile.save}
        </Button>
        {extra}
      </div>
    </form>
  )
}

function Fieldset({ legend, note, children }: { legend: string; note?: string; children: ReactNode }) {
  const noteId = useId()
  return (
    <fieldset className="min-w-0" aria-describedby={note ? noteId : undefined}>
      <legend className="text-sm font-medium">{legend}</legend>
      {note && (
        <p id={noteId} className="mt-1 text-sm leading-relaxed text-muted-foreground">
          {note}
        </p>
      )}
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1">{children}</div>
    </fieldset>
  )
}

function Choice({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex min-h-9 items-center gap-2 text-sm">
      {children}
      <span>{label}</span>
    </label>
  )
}

/** 主体性の欄。いつでも書き直せる。asking（「いま聞きたいこと」に主体性を出している）のあいだは、「書く」を出さない。 */
function AgencySection({
  agency,
  asking,
  editing,
  busy,
  failed,
  onEdit,
  onCancel,
  onSave,
}: {
  agency: string | null
  asking: boolean
  editing: boolean
  busy: boolean
  failed: SavedFrom | null
  onEdit: () => void
  onCancel: () => void
  onSave: (text: string) => void
}) {
  return (
    <Section title={copy.profile.agencyTitle}>
      {editing && !asking ? (
        <AgencyForm
          initial={agency ?? ''}
          busy={busy}
          onSave={onSave}
          extra={
            <Button type="button" variant="ghost" className="w-full sm:w-auto" disabled={busy} onClick={onCancel}>
              {copy.profile.cancel}
            </Button>
          }
        />
      ) : (
        <>
          {agency ? (
            <p className="text-sm leading-relaxed break-words whitespace-pre-wrap">{agency}</p>
          ) : (
            <p className="text-sm text-muted-foreground">{copy.profile.notWritten}</p>
          )}
          {!asking && (
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={onEdit}>
              {agency ? copy.profile.edit : copy.profile.write}
            </Button>
          )}
        </>
      )}
      <SaveFailed from={failed} />
    </Section>
  )
}

/**
 * 主体性の欄。本人が書く。中身の例は入れない（profile-6（主体性は本人が書く））。
 * 見出しの名詞句だけでは手が止まりやすいので、一つの答えに誘わない問いの一文を添える（Claude の判断）。
 */
function AgencyForm({
  initial,
  busy,
  onSave,
  extra,
}: {
  initial: string
  busy: boolean
  onSave: (text: string) => void
  extra: ReactNode
}) {
  const id = useId()
  const questionId = useId()
  const [text, setText] = useState(initial)
  return (
    <form
      className="flex min-w-0 flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSave(text)
      }}
    >
      <label htmlFor={id} className="text-sm font-medium">
        {copy.profile.agencyTitle}
      </label>
      <p id={questionId} className="text-sm leading-relaxed">
        {copy.profile.agencyQuestion}
      </p>
      <textarea
        id={id}
        aria-describedby={questionId}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={copy.profile.agencyPlaceholder}
        maxLength={MAX_AGENCY_LENGTH}
        rows={3}
        className={FIELD_CLASS}
      />
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {copy.profile.save}
        </Button>
        {extra}
      </div>
    </form>
  )
}
