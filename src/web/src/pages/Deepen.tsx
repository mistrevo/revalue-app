import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import {
  ApiError,
  generateDeepen,
  getAbilities,
  getDeepen,
  isDailyLimit,
  putDeepenAnswer,
  putDeepenSteps,
  putDeepenTasks,
  type AbilityKey,
  type Deepen as DeepenData,
  type DeepenContent,
  type DeepenQuestion,
  type DeepenStep,
  type DeepenTarget,
  type DeepenTask,
  type DeepenTaskRequest,
} from '@/api'
import { DailyLimitNotice } from '@/components/DailyLimitNotice'
import { QuoteList } from '@/components/Insights'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { hasVisibleText } from '@/lib/text'

type State = { kind: 'loading' } | { kind: 'ready'; data: DeepenData } | { kind: 'error' }

/** 作っているあいだの表示。regenerating は、選んだ案が変わったので作り直しているとき。 */
type Generating = 'idle' | 'generating' | 'regenerating'

/** 作れなかったとき。failed は AI が失敗したか断った、limit は 1 日の送信回数の上限。 */
type GenerateError = { kind: 'failed' } | { kind: 'limit'; resetAt: string } | null

/** 書き換えで出す言葉と、出す場所。top は画面の上（選んだ案が変わって、下の中身を出さなくなったとき）。 */
type Where = 'top' | 'tasks' | 'steps' | `question:${string}`
type Notice = { where: Where; text: string } | null

const ABILITY_KEYS: AbilityKey[] = ['noticing', 'coordinating', 'prioritizing']
const MAX_TASKS = 5
const MAX_OWN_STEPS = 3
// 入力欄の maxLength は UTF-16 の長さで数えるので、見た目の文字で数える裏側の上限より手前で止まることがある。
// 裏側の上限を超えては送らない安全な側に置いている（仕事の選択肢の画面と同じ。Claude の判断）
const MAX_TASK_NAME = 30
const MAX_TASK_DETAIL = 80
const MAX_KNOWLEDGE = 60
const MAX_ANSWER = 200
const MAX_STEP = 100

const FIELD_CLASS =
  'w-full min-w-0 rounded-lg border bg-background px-3 py-2 text-base leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50'
/** 部分ごとの枠（仕事の選択肢の画面のカードと同じ見た目）。 */
const CARD_CLASS = 'flex min-w-0 flex-col gap-3 rounded-xl border px-4 py-4'

function toRequest(task: DeepenTask): DeepenTaskRequest {
  return { name: task.name, detail: task.detail, ability: task.ability, knowledge: task.knowledge.join('、') }
}

/**
 * 選んだ案を深める（06-deepen.md）。選んだ 1 案だけを、業務ごとに照らし、仮の場面の問いと最初の一歩の候補を示す。
 * 選んだ案が変わっていたら、開いたときに 1 回だけ作り直す。作り直すあいだ、前の案の中身は出さない。
 * 状態の呼び名、点数、順位は出さない。
 */
export function Deepen() {
  const [state, setState] = useState<State>({ kind: 'loading' })
  const [generating, setGenerating] = useState<Generating>('idle')
  const [generateError, setGenerateError] = useState<GenerateError>(null)
  const [notice, setNotice] = useState<Notice>(null)
  const [busy, setBusy] = useState(false)
  // 一歩の欄を、読み直した中身で作り直すための印
  const [reloads, setReloads] = useState(0)
  // 業務を直すときの力の名前（裏側が決めた名前を、見えた力の API から取る）
  const [abilityNames, setAbilityNames] = useState<Partial<Record<AbilityKey, string>>>({})
  // 開いたときの作り直しを 1 回だけにする印。StrictMode で画面を開く処理が 2 回走っても POST は 1 回
  const autoRegenerated = useRef(false)

  const generate = useCallback(async (mode: Exclude<Generating, 'idle'>) => {
    setGenerating(mode)
    setGenerateError(null)
    setNotice(null)
    try {
      setState({ kind: 'ready', data: await generateDeepen() })
    } catch (e) {
      if (isDailyLimit(e)) {
        setGenerateError({ kind: 'limit', resetAt: e.resetAt ?? '' })
      } else if (e instanceof ApiError && e.status === 409) {
        // ほかの画面で選んだ案が変わり、いまは進めない。読み直して、足りないものを出す
        try {
          setState({ kind: 'ready', data: await getDeepen() })
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
    getDeepen()
      .then((data) => {
        if (!active) return
        setState({ kind: 'ready', data })
        if (data.readiness === 'ready' && data.content?.stale && !autoRegenerated.current) {
          autoRegenerated.current = true
          if (data.content.retryPaused) {
            // いまの案で一度失敗している。開くたびに送信回数を使わないよう、自動では作り直さず「もう一度作る」を出す
            setGenerateError({ kind: 'failed' })
          } else {
            void generate('regenerating')
          }
        }
      })
      .catch(() => active && setState({ kind: 'error' }))
    getAbilities()
      .then((abilities) => {
        if (!active) return
        setAbilityNames(Object.fromEntries(abilities.abilities.map((a) => [a.key, a.name])))
      })
      .catch(() => {
        // 取れなくても、業務に付いている力の名前で選べる
      })
    return () => {
      active = false
    }
  }, [generate])

  /** 書き換えを送る。失敗したら、その場所に穏やかな言葉を出す。できたら true。 */
  async function change(where: Where, run: () => Promise<DeepenData>): Promise<boolean> {
    setBusy(true)
    setNotice(null)
    try {
      setState({ kind: 'ready', data: await run() })
      return true
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // 見ていた中身が変わっていた。読み直して、いまの中身を出す
        let fresh: DeepenData | null = null
        try {
          fresh = await getDeepen()
          setState({ kind: 'ready', data: fresh })
          setReloads((n) => n + 1)
        } catch {
          // 読み直せなくても、言葉は出す
        }
        const sameTarget = fresh?.readiness === 'ready' && fresh.content !== null && !fresh.content.stale
        if (sameTarget && where === 'steps') {
          // 選んだ案は同じで、条件が変わって選べない候補があった
          setNotice({ where, text: copy.deepen.stepsChanged })
        } else {
          setNotice({ where: 'top', text: copy.deepen.changed })
        }
      } else {
        setNotice({ where, text: copy.deepen.saveFailed })
      }
      return false
    } finally {
      setBusy(false)
    }
  }

  const data = state.kind === 'ready' ? state.data : null
  const content = data?.content ?? null
  const showContent = content !== null && !content.stale && generating === 'idle'
  const canGenerate = generating === 'idle' && generateError?.kind !== 'limit' && (content === null || content.stale)
  const noticeAt = (where: Where) => (notice?.where === where ? notice.text : null)

  return (
    <Page>
      <h1 className="text-2xl font-bold tracking-tight">{copy.deepen.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{copy.deepen.lead}</p>

      {state.kind === 'loading' && <p className="mt-6 text-sm text-muted-foreground">{copy.loading}</p>}
      {state.kind === 'error' && (
        <p role="alert" className="mt-6 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}

      {data && (
        <div className="mt-6 flex flex-col gap-4">
          <Alert text={noticeAt('top')} />

          {data.readiness !== 'ready' || data.target === null ? (
            <NotReady readiness={data.readiness} />
          ) : (
            <>
              <TargetSection target={data.target} />

              {generating !== 'idle' && (
                <p role="status" className="rounded-xl bg-muted/50 px-4 py-3 text-sm leading-relaxed">
                  {generating === 'regenerating' ? copy.deepen.regenerating : copy.deepen.generating}
                </p>
              )}
              {generateError?.kind === 'failed' && (
                <p role="alert" className="text-sm leading-relaxed">
                  {copy.deepen.generateFailed}
                </p>
              )}
              {generateError?.kind === 'limit' && <DailyLimitNotice resetAt={generateError.resetAt} />}
              {canGenerate && (
                <Button
                  size="lg"
                  className="w-full sm:w-auto sm:self-start"
                  onClick={() => generate(content?.stale ? 'regenerating' : 'generating')}
                >
                  {generateError?.kind === 'failed' ? copy.deepen.retry : copy.deepen.generate}
                </Button>
              )}

              {showContent && (
                <>
                  <TasksSection
                    content={content}
                    abilityNames={abilityNames}
                    busy={busy}
                    notice={noticeAt('tasks')}
                    onSave={(tasks) => change('tasks', () => putDeepenTasks(tasks))}
                  />
                  <QuestionsSection
                    questions={content.questions}
                    busy={busy}
                    noticeFor={(id) => noticeAt(`question:${id}`)}
                    onAnswer={(id, text, fromChoice) =>
                      change(`question:${id}`, () => putDeepenAnswer(id, { text, fromChoice }))
                    }
                  />
                  <StepsSection
                    key={`${content.generatedAt}-${reloads}`}
                    content={content}
                    busy={busy}
                    notice={noticeAt('steps')}
                    onSave={(steps) => change('steps', () => putDeepenSteps(steps))}
                  />
                  <NotWorking />
                </>
              )}
            </>
          )}
        </div>
      )}

      <div className="mt-6">
        <Button asChild variant="outline" className="w-full sm:w-auto">
          <Link to="/home">{copy.deepen.backHome}</Link>
        </Button>
      </div>
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

function Alert({ text }: { text: string | null }) {
  if (!text) return null
  return (
    <p role="alert" className="text-sm leading-relaxed">
      {text}
    </p>
  )
}

/** 進めないときは、何をすれば進めるかを一つだけ伝える。 */
function NotReady({ readiness }: { readiness: DeepenData['readiness'] }) {
  const { text, to, link } =
    readiness === 'needsConditions'
      ? { text: copy.deepen.needsConditions, to: '/profile', link: copy.deepen.toProfile }
      : readiness === 'hold'
        ? { text: copy.deepen.hold, to: '/options', link: copy.deepen.toOptions }
        : { text: copy.deepen.noChoice, to: '/options', link: copy.deepen.toOptions }
  return (
    <div className="flex flex-col gap-3 rounded-xl border px-4 py-4">
      <p className="text-sm leading-relaxed">{text}</p>
      <Button asChild className="w-full sm:w-auto sm:self-start">
        <Link to={to}>{link}</Link>
      </Button>
    </div>
  )
}

/** 選んだ案の種類と名前、仕事の選択肢へ戻る道。いまの条件に収まらなくなっていたら、仕事の選択肢の画面と同じ一言を添える。 */
function TargetSection({ target }: { target: DeepenTarget }) {
  const id = useId()
  const kind = target.kind === 'own' ? copy.deepen.ownKind : copy.options.kinds[target.kind].label
  return (
    <section aria-labelledby={id} className={`${CARD_CLASS} border-primary/40 bg-primary/5`}>
      <h2 id={id} className="text-base font-bold">
        {copy.deepen.targetTitle}
      </h2>
      <div>
        <p className="text-sm text-muted-foreground">{kind}</p>
        <p className="text-lg font-bold break-words">{target.title}</p>
      </div>
      {target.outsideConditions && <p className="text-sm leading-relaxed text-muted-foreground">{copy.options.chosenOutside}</p>}
      <Button asChild variant="outline" className="w-full sm:w-auto sm:self-start">
        <Link to="/options">{copy.deepen.backToOptions}</Link>
      </Button>
    </section>
  )
}

/**
 * 業務ごとに照らした結果（deepen-2（業務ごとに照らす））。見立ての業務（「創る」と本人が書いた仕事）は、
 * 「AI の見立て（直せます）」と示し、直す・消す・足すができる。一覧を丸ごと置き換えて送る。
 */
function TasksSection({
  content,
  abilityNames,
  busy,
  notice,
  onSave,
}: {
  content: DeepenContent
  abilityNames: Partial<Record<AbilityKey, string>>
  busy: boolean
  notice: string | null
  onSave: (tasks: DeepenTaskRequest[]) => Promise<boolean>
}) {
  // 'new' は書き足している、数字はその並びの業務を直している
  const [editing, setEditing] = useState<number | 'new' | null>(null)
  const { tasks, tasksRejected } = content
  const editable = tasksRejected || tasks.some((t) => t.drafted)
  // 業務に付いている名前を先に、見えた力の API の名前で足す
  const names: Partial<Record<AbilityKey, string>> = {
    ...abilityNames,
    ...Object.fromEntries(tasks.map((t) => [t.ability, t.abilityName])),
  }
  const current = tasks.map(toRequest)

  async function save(next: DeepenTaskRequest[]) {
    if (await onSave(next)) setEditing(null)
  }

  return (
    <Section title={copy.deepen.tasksTitle}>
      {editable && <p className="-mt-2 text-sm text-muted-foreground">{copy.deepen.draftedTitle}</p>}
      {tasksRejected && <p className="text-sm leading-relaxed">{copy.deepen.tasksRejected}</p>}

      {tasks.length > 0 && (
        <ul className="flex flex-col gap-3">
          {tasks.map((task, index) =>
            editing === index ? (
              <li key={task.id ?? index}>
                <TaskForm
                  initial={current[index]}
                  names={names}
                  busy={busy}
                  onCancel={() => setEditing(null)}
                  onSave={(value) => save(current.map((t, i) => (i === index ? value : t)))}
                />
              </li>
            ) : (
              <li key={task.id ?? index}>
                <TaskCard
                  task={task}
                  actions={
                    editable && (
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          aria-label={copy.deepen.editLabel.replace('{text}', task.name)}
                          onClick={() => setEditing(index)}
                        >
                          {copy.deepen.edit}
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          aria-label={copy.deepen.removeLabel.replace('{text}', task.name)}
                          onClick={() => void save(current.filter((_, i) => i !== index))}
                        >
                          {copy.deepen.remove}
                        </Button>
                      </div>
                    )
                  }
                />
              </li>
            ),
          )}
        </ul>
      )}

      {tasks.length > 0 && <p className="text-sm leading-relaxed text-muted-foreground">{copy.deepen.workNote}</p>}

      {editable &&
        (editing === 'new' ? (
          <TaskForm initial={null} names={names} busy={busy} onCancel={() => setEditing(null)} onSave={(value) => save([...current, value])} />
        ) : tasks.length < MAX_TASKS ? (
          <Button variant="outline" className="w-full sm:w-auto sm:self-start" disabled={busy} onClick={() => setEditing('new')}>
            {copy.deepen.taskAdd}
          </Button>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.deepen.taskMax}</p>
        ))}

      <Alert text={notice} />
    </Section>
  )
}

/** 業務 1 つ。使えるところ（力の名前、状態、根拠の本人の言葉）と、まだ確かめていないこと（力、知識や道具）。 */
function TaskCard({ task, actions }: { task: DeepenTask; actions: ReactNode }) {
  const id = useId()
  const notYet = [...(task.usable ? [] : [copy.deepen.abilityNotYet.replace('{name}', task.abilityName)]), ...task.knowledge]
  return (
    <article aria-labelledby={id} className="flex min-w-0 flex-col gap-2 rounded-lg bg-muted/40 px-3 py-3 text-sm leading-relaxed">
      <div>
        <h3 id={id} className="font-semibold break-words">
          {task.name}
        </h3>
        {task.detail && <p className="break-words">{task.detail}</p>}
      </div>
      {task.usable && (
        <div>
          <p className="text-muted-foreground">{copy.deepen.usableTitle}</p>
          <p className="mt-1 flex flex-wrap items-baseline gap-x-2">
            <span className="font-semibold">{task.abilityName}</span>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{copy.deepen.abilityStates[task.usable.state]}</span>
          </p>
          <QuoteList quotes={task.usable.quotes} />
        </div>
      )}
      {notYet.length > 0 && (
        <div>
          <p className="text-muted-foreground">{copy.deepen.notYetTitle}</p>
          <ul className="mt-1 list-disc pl-5">
            {notYet.map((text) => (
              <li key={text} className="break-words">
                {text}
              </li>
            ))}
          </ul>
        </div>
      )}
      {actions}
    </article>
  )
}

/** 業務の名前、中身、使う力、要る知識や道具。名前と力がないと保存しない（裏側も断る）。 */
function TaskForm({
  initial,
  names,
  busy,
  onSave,
  onCancel,
}: {
  initial: DeepenTaskRequest | null
  names: Partial<Record<AbilityKey, string>>
  busy: boolean
  onSave: (task: DeepenTaskRequest) => void
  onCancel: () => void
}) {
  const nameId = useId()
  const detailId = useId()
  const abilityId = useId()
  const knowledgeId = useId()
  const hintId = useId()
  const [name, setName] = useState(initial?.name ?? '')
  const [detail, setDetail] = useState(initial?.detail ?? '')
  const [ability, setAbility] = useState<AbilityKey | ''>(initial?.ability ?? '')
  const [knowledge, setKnowledge] = useState(initial?.knowledge ?? '')
  const canSave = hasVisibleText(name) && ability !== ''

  return (
    <form
      className="flex flex-col gap-3 rounded-lg border px-3 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        if (canSave && !busy) onSave({ name: name.trim(), detail: detail.trim(), ability, knowledge: knowledge.trim() })
      }}
    >
      <div className="flex flex-col gap-1">
        <label htmlFor={nameId} className="text-sm font-medium">
          {copy.deepen.taskNameLabel}
        </label>
        <input
          id={nameId}
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={MAX_TASK_NAME}
          aria-describedby={canSave ? undefined : hintId}
          className={FIELD_CLASS}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={detailId} className="text-sm font-medium">
          {copy.deepen.taskDetailLabel}
        </label>
        <textarea
          id={detailId}
          value={detail}
          onChange={(event) => setDetail(event.target.value)}
          maxLength={MAX_TASK_DETAIL}
          rows={2}
          className={FIELD_CLASS}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={abilityId} className="text-sm font-medium">
          {copy.deepen.taskAbilityLabel}
        </label>
        <select
          id={abilityId}
          value={ability}
          onChange={(event) => setAbility(event.target.value as AbilityKey | '')}
          className={FIELD_CLASS}
        >
          <option value="" disabled>
            {copy.deepen.taskAbilityPlaceholder}
          </option>
          {ABILITY_KEYS.filter((key) => names[key]).map((key) => (
            <option key={key} value={key}>
              {names[key]}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={knowledgeId} className="text-sm font-medium">
          {copy.deepen.taskKnowledgeLabel}
        </label>
        <input
          id={knowledgeId}
          value={knowledge}
          onChange={(event) => setKnowledge(event.target.value)}
          maxLength={MAX_KNOWLEDGE}
          className={FIELD_CLASS}
        />
      </div>
      {!canSave && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {copy.deepen.taskNeedName}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={!canSave || busy}>
          {copy.deepen.save}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {copy.deepen.cancel}
        </Button>
      </div>
    </form>
  )
}

/**
 * 仮の場面の問い（deepen-6（仮の場面での考え方を聞く））。選択肢 3 つ、「それ以外」、自由に書く欄。
 * 答えは考え方として残し、力の見立てには使わないと伝える。正解は作らない。
 */
function QuestionsSection({
  questions,
  busy,
  noticeFor,
  onAnswer,
}: {
  questions: DeepenQuestion[]
  busy: boolean
  noticeFor: (id: string) => string | null
  onAnswer: (id: string, text: string, fromChoice: boolean) => Promise<boolean>
}) {
  return (
    <Section title={copy.deepen.questionsTitle}>
      {questions.length === 0 ? (
        <p className="text-sm leading-relaxed">{copy.deepen.noQuestions}</p>
      ) : (
        <>
          <p className="-mt-1 text-sm leading-relaxed text-muted-foreground">{copy.deepen.questionsLead}</p>
          {questions.map((question) => (
            <QuestionItem key={question.id} question={question} busy={busy} notice={noticeFor(question.id)} onAnswer={onAnswer} />
          ))}
        </>
      )}
    </Section>
  )
}

function QuestionItem({
  question,
  busy,
  notice,
  onAnswer,
}: {
  question: DeepenQuestion
  busy: boolean
  notice: string | null
  onAnswer: (id: string, text: string, fromChoice: boolean) => Promise<boolean>
}) {
  const fieldId = useId()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [input, setInput] = useState('')
  const answer = question.answer

  return (
    <div className="flex min-w-0 flex-col gap-3 rounded-lg bg-muted/40 px-3 py-3">
      <p className="text-sm leading-relaxed break-words">{question.situation}</p>
      <div role="group" aria-label={copy.deepen.choicesLabel} className="flex flex-col gap-2">
        {question.choices.map((choice) => (
          <Button
            key={choice}
            variant="outline"
            className="h-auto w-full justify-start py-2 text-left whitespace-normal"
            disabled={busy}
            aria-pressed={answer?.fromChoice === true && answer.text === choice}
            onClick={() => void onAnswer(question.id, choice, true)}
          >
            {choice}
          </Button>
        ))}
        <Button
          variant="ghost"
          className="h-auto w-full justify-start py-2 text-left whitespace-normal"
          onClick={() => inputRef.current?.focus()}
        >
          {copy.deepen.other}
        </Button>
      </div>
      <form
        className="flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault()
          if (!hasVisibleText(input) || busy) return
          if (await onAnswer(question.id, input.trim(), false)) setInput('')
        }}
      >
        <label htmlFor={fieldId} className="text-sm font-medium">
          {copy.deepen.answerLabel}
        </label>
        <textarea
          id={fieldId}
          ref={inputRef}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={copy.deepen.answerPlaceholder}
          maxLength={MAX_ANSWER}
          rows={2}
          className={FIELD_CLASS}
        />
        <Button type="submit" className="w-full sm:w-auto sm:self-end" disabled={busy || !hasVisibleText(input)}>
          {copy.deepen.answerSend}
        </Button>
      </form>
      {answer && (
        <div role="status" className="rounded-lg bg-background px-3 py-2 text-sm leading-relaxed">
          <p className="break-words">{copy.deepen.yourAnswer.replace('{text}', answer.text)}</p>
          <p className="text-muted-foreground">{copy.deepen.answerSaved}</p>
        </div>
      )}
      <Alert text={notice} />
    </div>
  )
}

/**
 * 最初の一歩（deepen-3（最初の一歩は小さく）、deepen-4（創るの一歩には需要の確かめを入れる））。
 * 候補を選んでも、自分で書いても、決めずにおいてもよい。裏側は、いまの条件で出す候補だけを返す。
 */
function StepsSection({
  content,
  busy,
  notice,
  onSave,
}: {
  content: DeepenContent
  busy: boolean
  notice: string | null
  onSave: (steps: { chosen: string[]; own: string[] }) => Promise<boolean>
}) {
  const { steps } = content
  const [chosen, setChosen] = useState<string[]>(() => steps.filter((s) => s.chosen).map((s) => s.id))
  const [own, setOwn] = useState<string[]>(() =>
    Array.from({ length: MAX_OWN_STEPS }, (_, i) => content.ownSteps[i] ?? ''),
  )
  const [saved, setSaved] = useState(false)
  // 書いた欄の次に、空の欄を 1 つだけ出す（3 つまで）
  const lastWritten = own.reduce((last, text, i) => (text.trim() !== '' ? i : last), -1)
  const visibleOwn = Math.min(MAX_OWN_STEPS, Math.max(1, lastWritten + 2))
  // コードの候補（f）と、中身の候補（s）が並んでいたら、条件が変わって入れ替えた
  const replaced = steps.some((s) => s.id.startsWith('f')) && steps.some((s) => s.id.startsWith('s'))

  function toggle(step: DeepenStep, checked: boolean) {
    setSaved(false)
    setChosen((current) =>
      checked ? steps.filter((s) => s.id === step.id || current.includes(s.id)).map((s) => s.id) : current.filter((id) => id !== step.id),
    )
  }

  return (
    <Section title={copy.deepen.stepsTitle}>
      <p className="-mt-1 text-sm leading-relaxed text-muted-foreground">{copy.deepen.stepsLead}</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={async (event) => {
          event.preventDefault()
          if (busy) return
          setSaved(false)
          const written = own.map((text) => text.trim()).filter((text) => hasVisibleText(text))
          if (await onSave({ chosen, own: written })) setSaved(true)
        }}
      >
        <ul className="flex flex-col gap-2">
          {steps.map((step) => (
            <li key={step.id} className="rounded-lg bg-muted/40 px-3 py-2 text-sm leading-relaxed">
              <label className="flex items-start gap-3">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0"
                  checked={chosen.includes(step.id)}
                  // 収まらない候補は、選んでいたものだけが来る。外したあとは選び直せない（裏側も断る）
                  disabled={busy || (!step.fits && !step.chosen)}
                  onChange={(event) => toggle(step, event.target.checked)}
                />
                <span className="min-w-0 break-words">{step.text}</span>
              </label>
              <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 pl-7 text-muted-foreground">
                <span>{`${copy.deepen.stepHours.replace('{n}', String(step.hours))}、${copy.deepen.placeValues[step.place]}`}</span>
                {step.demandCheck && (
                  <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-foreground">{copy.deepen.demandCheck}</span>
                )}
                {!step.fits && <span className="rounded-full bg-muted px-2 py-0.5 text-xs">{copy.deepen.stepOutside}</span>}
              </p>
            </li>
          ))}
        </ul>
        {replaced && <p className="text-sm leading-relaxed text-muted-foreground">{copy.deepen.stepsReplaced}</p>}

        <fieldset className="flex min-w-0 flex-col gap-2">
          <legend className="text-sm font-medium">{copy.deepen.ownStepsTitle}</legend>
          {own.slice(0, visibleOwn).map((text, i) => {
            const label = copy.deepen.ownStepLabel.replace('{n}', String(i + 1))
            return (
              <input
                key={i}
                aria-label={label}
                value={text}
                maxLength={MAX_STEP}
                onChange={(event) => {
                  setSaved(false)
                  setOwn((current) => current.map((t, j) => (j === i ? event.target.value : t)))
                }}
                className={FIELD_CLASS}
              />
            )
          })}
        </fieldset>

        <Button type="submit" className="w-full sm:w-auto sm:self-start" disabled={busy}>
          {copy.deepen.stepsSave}
        </Button>
        {saved && (
          <p role="status" className="text-sm leading-relaxed">
            {copy.deepen.stepsSaved}
          </p>
        )}
        <Alert text={notice} />
      </form>
    </Section>
  )
}

/** うまくいかなかったときの受け止め方と、次の考え方（deepen-5（うまくいかなくても次へ））。文はコードが決めたもの。 */
function NotWorking() {
  return (
    <Section title={copy.deepen.notWorkingTitle}>
      <p className="text-sm leading-relaxed">{copy.deepen.notWorking}</p>
      <Button asChild variant="outline" className="w-full sm:w-auto sm:self-start">
        <Link to="/options">{copy.deepen.notWorkingLink}</Link>
      </Button>
    </Section>
  )
}
