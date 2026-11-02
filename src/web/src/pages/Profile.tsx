import { useEffect, useId, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
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
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'

type State = { kind: 'loading' } | { kind: 'ready'; data: ProfileData } | { kind: 'error' }

/** 本人が答えて直す 4 つの記録。できることは見えた力の画面とその話から直す。 */
type RecordKey = 'preferences' | 'wants' | 'conditions' | 'agency'

/** 失敗を出す場所。next は「いま聞きたいこと」。 */
type Where = 'next' | RecordKey

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
 * どれも済んでいれば null。
 */
function nextQuestion(profile: ProfileData): RecordKey | null {
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
  const [failedAt, setFailedAt] = useState<Where | null>(null)
  const [editing, setEditing] = useState<RecordKey | null>(null)

  useEffect(() => {
    let active = true
    getProfile()
      .then((data) => active && setState({ kind: 'ready', data }))
      .catch(() => active && setState({ kind: 'error' }))
    return () => {
      active = false
    }
  }, [])

  /** 保存する。失敗したら、その場所に穏やかな言葉を出し、入れた内容は入力欄に残したままにする。 */
  async function save(where: Where, run: () => Promise<ProfileData>) {
    setBusy(true)
    setFailedAt(null)
    try {
      const data = await run()
      setState({ kind: 'ready', data })
      setEditing(null)
    } catch {
      setFailedAt(where)
    } finally {
      setBusy(false)
    }
  }

  function startEditing(record: RecordKey) {
    setFailedAt(null)
    setEditing(record)
  }

  function stopEditing() {
    setFailedAt(null)
    setEditing(null)
  }

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
          <NextQuestion profile={state.data} busy={busy} failed={failedAt === 'next'} save={save} />
          <CanDoSection canDo={state.data.canDo} />
          {(['preferences', 'wants'] as const).map((record) => (
            <EntriesSection
              key={record}
              title={record === 'preferences' ? copy.profile.preferencesTitle : copy.profile.wantsTitle}
              entries={state.data[record]}
              question={state.data.questions[record]}
              adding={editing === record}
              busy={busy}
              failed={failedAt === record}
              onAdd={() => startEditing(record)}
              onCancel={stopEditing}
              onSave={(entries) => save(record, () => (record === 'preferences' ? putPreferences(entries) : putWants(entries)))}
            />
          ))}
          <ConditionsSection
            profile={state.data}
            editing={editing === 'conditions'}
            busy={busy}
            failed={failedAt === 'conditions'}
            onEdit={() => startEditing('conditions')}
            onCancel={stopEditing}
            onSave={(conditions) => save('conditions', () => putConditions(conditions))}
          />
          <AgencySection
            agency={state.data.agency}
            editing={editing === 'agency'}
            busy={busy}
            failed={failedAt === 'agency'}
            onEdit={() => startEditing('agency')}
            onCancel={stopEditing}
            onSave={(text) => save('agency', () => putAgency(text))}
          />
        </div>
      )}

      <div className="mt-6">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link to="/home">{copy.profile.backHome}</Link>
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

function SaveFailed({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <p role="alert" className="text-sm leading-relaxed">
      {copy.profile.saveFailed}
    </p>
  )
}

function NextQuestion({
  profile,
  busy,
  failed,
  save,
}: {
  profile: ProfileData
  busy: boolean
  failed: boolean
  save: (where: Where, run: () => Promise<ProfileData>) => Promise<void>
}) {
  const next = nextQuestion(profile)
  if (next === null) return null

  let body: ReactNode
  if (next === 'preferences' || next === 'wants') {
    const entries = profile[next]
    const put = next === 'preferences' ? putPreferences : putWants
    body = (
      <EntryPicker
        key={next}
        question={profile.questions[next]}
        taken={entries}
        busy={busy}
        onPick={(entry) => save('next', () => put([...entries, entry]))}
        extra={
          <Button type="button" variant="ghost" className={WRAP_BUTTON} disabled={busy} onClick={() => save('next', () => put(entries))}>
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
        onSave={(conditions) => save('next', () => putConditions(conditions))}
      />
    )
  } else {
    body = (
      <AgencyForm
        initial=""
        busy={busy}
        onSave={(text) => save('next', () => putAgency(text))}
        extra={
          <Button type="button" variant="ghost" className="w-full sm:w-auto" disabled={busy} onClick={() => save('next', () => putAgency(''))}>
            {copy.profile.notNowAgency}
          </Button>
        }
      />
    )
  }

  return (
    <Section title={copy.profile.nextTitle}>
      {body}
      <SaveFailed show={failed} />
    </Section>
  )
}

/** 問いと、選択肢、「自分で書く」。もう入っている選択肢は出さない。書いた言葉は、保存に失敗しても欄に残す。 */
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
            if (text.trim() !== '') onPick({ text: text.trim(), source: 'written' })
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
          <Button type="submit" className="w-full sm:w-auto sm:self-start" disabled={busy || text.trim() === ''}>
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

/** できること。外した力しかないときは「まだありません」と言わず、外した注記だけを出す（Claude の判断）。 */
function CanDoSection({ canDo }: { canDo: ProfileData['canDo'] }) {
  const empty = canDo.seen.length === 0 && canDo.checking.length === 0 && !canDo.hasExcluded
  return (
    <Section title={copy.profile.canDoTitle}>
      {canDo.seen.length > 0 && <CanDoGroup title={copy.profile.seenTitle} abilities={canDo.seen} />}
      {canDo.checking.length > 0 && <CanDoGroup title={copy.profile.checkingTitle} abilities={canDo.checking} />}
      {empty && <p className="text-sm leading-relaxed text-muted-foreground">{copy.profile.canDoEmpty}</p>}
      {canDo.hasExcluded && <p className="text-sm leading-relaxed text-muted-foreground">{copy.profile.excludedNote}</p>}
      <Link to="/abilities" className="text-sm font-medium text-primary underline underline-offset-4">
        {copy.profile.openAbilities}
      </Link>
    </Section>
  )
}

function CanDoGroup({ title, abilities }: { title: string; abilities: CanDoAbility[] }) {
  const id = useId()
  return (
    <div role="group" aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <h3 id={id} className="text-sm font-semibold text-muted-foreground">
        {title}
      </h3>
      {abilities.map((ability) => (
        <div key={ability.key} className="min-w-0">
          <h4 className="text-sm font-semibold">{ability.name}</h4>
          <QuoteList quotes={ability.quotes} />
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

function EntriesSection({
  title,
  entries,
  question,
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
  adding: boolean
  busy: boolean
  failed: boolean
  onAdd: () => void
  onCancel: () => void
  onSave: (entries: ProfileEntry[]) => void
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
                onClick={() => onSave(entries.filter((other) => other !== entry))}
              >
                {copy.profile.remove}
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">{copy.profile.notDecided}</p>
      )}
      {adding ? (
        <EntryPicker
          question={question}
          taken={entries}
          busy={busy}
          onPick={(entry) => onSave([...entries, entry])}
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
      <SaveFailed show={failed} />
    </Section>
  )
}

function hoursText(hours: number) {
  return copy.profile.hoursValue.replace('{n}', String(hours))
}

function incomeText(income: number | null) {
  return income === null ? copy.profile.incomeUndecided : copy.profile.incomeValue.replace('{n}', String(income))
}

function ConditionsSection({
  profile,
  editing,
  busy,
  failed,
  onEdit,
  onCancel,
  onSave,
}: {
  profile: ProfileData
  editing: boolean
  busy: boolean
  failed: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (conditions: ProfileConditions) => void
}) {
  const conditions = profile.conditions
  return (
    <Section title={copy.profile.conditionsTitle}>
      {editing ? (
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
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={onEdit}>
            {conditions ? copy.profile.edit : copy.profile.enter}
          </Button>
        </>
      )}
      <SaveFailed show={failed} />
    </Section>
  )
}

/** 条件の入力。時間帯はいくつでも、ほかは一つずつ選ぶ。収入の目安は「まだ決めていない」から始める（Claude の判断）。 */
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
      <Fieldset legend={copy.profile.monthlyIncome}>
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
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="w-full sm:w-auto" disabled={busy || !ready}>
          {copy.profile.save}
        </Button>
        {extra}
      </div>
    </form>
  )
}

function Fieldset({ legend, children }: { legend: string; children: ReactNode }) {
  return (
    <fieldset className="min-w-0">
      <legend className="text-sm font-medium">{legend}</legend>
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

function AgencySection({
  agency,
  editing,
  busy,
  failed,
  onEdit,
  onCancel,
  onSave,
}: {
  agency: string | null
  editing: boolean
  busy: boolean
  failed: boolean
  onEdit: () => void
  onCancel: () => void
  onSave: (text: string) => void
}) {
  return (
    <Section title={copy.profile.agencyTitle}>
      {editing ? (
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
          <Button type="button" variant="outline" size="sm" className="self-start" disabled={busy} onClick={onEdit}>
            {agency ? copy.profile.edit : copy.profile.write}
          </Button>
        </>
      )}
      <SaveFailed show={failed} />
    </Section>
  )
}

/** 主体性の欄。本人が書く。中身の例は入れない（profile-6（主体性は本人が書く））。 */
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
      <textarea
        id={id}
        value={text}
        onChange={(event) => setText(event.target.value)}
        placeholder={copy.profile.agencyPlaceholder}
        maxLength={MAX_AGENCY_LENGTH}
        rows={3}
        className={FIELD_CLASS}
      />
      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="w-full sm:w-auto" disabled={busy}>
          {copy.profile.save}
        </Button>
        {extra}
      </div>
    </form>
  )
}
