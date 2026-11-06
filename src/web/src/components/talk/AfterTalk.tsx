import { useEffect, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { getNextStep, type NextStepKind } from '@/api'
import { copy } from '@/copy'
import { nextStepPath } from '@/lib/next-step'
import { useStartEpisode } from '@/lib/use-start-episode'
import { Bubble } from './Bubble'

/** 次の一手のボタン。答えの例と同じ枠と色で、言葉の長さに合わせた丸い形にする（モック talkend.html）。 */
const NEXT_BUTTON =
  'inline-flex min-h-11 max-w-full min-w-0 items-center rounded-full border-[1.5px] border-primary bg-surface px-4 py-1.5 text-left text-[15px] leading-snug font-bold break-words text-primary outline-none hover:bg-tint focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'
/** 「今日はここまで」と、つらい状態のサインのあとの「別の日のことを話す」。目立たせない。 */
const QUIET_BUTTON =
  'inline-flex min-h-11 max-w-full min-w-0 items-center rounded-full px-4 py-1.5 text-left text-[15px] leading-snug font-bold break-words text-muted-foreground outline-none hover:bg-chip focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

/** ボタンにする次にできること。talk は「別の日のことを話す」と重なり、continue は「別の日のことを話す」がその場面へ進むので出さない。 */
const SHOWN_STEPS: readonly NextStepKind[] = ['conditions', 'options', 'deepen', 'report']
type ShownStep = 'conditions' | 'options' | 'deepen' | 'report'

/**
 * 区切ったあとのトークの続き（common-3（次にできることを一つ示す））。見えた力のカードのあとに置く。
 * 聞き手の側に、受け止める一文と「このあと、どうしますか？」を出し、次にできること・「別の日のことを話す」・「今日はここまで」を、
 * 答えの例と同じ形のボタンで並べる。answered（本人が一度でも答えた場面）でなければ、話してくれたことへのお礼は言わない。
 * 次にできることを読めなかったときは、残りの 2 つだけ出す。「今日はここまで」は何も送らず、何も保存しない。
 * distress（この場面がつらい状態のサインに応えたところで終わっているか、力の確かめに使わない印が付いている）のときは、
 * 問いもボタンも出さず、先へ進むことを勧めない。サインのあと「続けて話す」を選んで区切った場面も、打ち明けた直後なので同じにする。
 * 目立たせない「別の日のことを話す」だけを置く（discover-10（つらい状態のサインに応える））。
 * refreshKey が変わったら（読み取りを直したときなど）、次にできることを読み直す。
 */
export function AfterTalk({
  distress,
  answered,
  refreshKey,
}: {
  distress: boolean
  answered: boolean
  refreshKey?: unknown
}) {
  const { start, starting, failed } = useStartEpisode()

  const startFailed = failed && (
    <p role="alert" className="leading-relaxed">
      {copy.errors.generic}
    </p>
  )

  if (distress) {
    return (
      <div className="flex flex-col gap-2">
        <div>
          <button type="button" className={QUIET_BUTTON} onClick={start} disabled={starting}>
            {copy.talk.anotherDay}
          </button>
        </div>
        {startFailed}
      </div>
    )
  }
  return (
    <NextChoices
      question={answered ? copy.talk.afterQuestion : copy.talk.afterQuestionUnanswered}
      refreshKey={refreshKey}
      start={start}
      starting={starting}
      startFailed={startFailed}
    />
  )
}

function NextChoices({
  question,
  refreshKey,
  start,
  starting,
  startFailed,
}: {
  question: string
  refreshKey?: unknown
  start: () => void
  starting: boolean
  startFailed: ReactNode
}) {
  // 読み終えるまでボタンを出さない（あとから一つ増えて、押す場所がずれないように）
  const [next, setNext] = useState<{ loaded: boolean; step: ShownStep | null }>({ loaded: false, step: null })
  const [done, setDone] = useState(false)

  useEffect(() => {
    let active = true
    getNextStep()
      .then((value) => {
        if (!active) return
        const shown = SHOWN_STEPS.includes(value.step) ? (value.step as ShownStep) : null
        setNext({ loaded: true, step: shown })
      })
      .catch(() => active && setNext({ loaded: true, step: null }))
    return () => {
      active = false
    }
  }, [refreshKey])

  if (done) {
    return (
      <div className="flex flex-col gap-3">
        <Bubble role="assistant">{question}</Bubble>
        <Bubble role="user">{copy.talk.doneForToday}</Bubble>
        <Bubble role="assistant">{copy.talk.doneForTodayReply}</Bubble>
      </div>
    )
  }

  const to = next.step === null ? null : nextStepPath({ step: next.step, episodeId: null })
  return (
    <div className="flex flex-col gap-3">
      <Bubble role="assistant">{question}</Bubble>
      {next.loaded && (
        <div role="group" aria-label={copy.talk.nextLabel} className="flex flex-wrap gap-2">
          {next.step !== null && to !== null && (
            <Link to={to} className={NEXT_BUTTON}>
              {copy.home.next[next.step]}
            </Link>
          )}
          <button type="button" className={NEXT_BUTTON} onClick={start} disabled={starting}>
            {copy.talk.anotherDay}
          </button>
          <button type="button" className={QUIET_BUTTON} onClick={() => setDone(true)}>
            {copy.talk.doneForToday}
          </button>
        </div>
      )}
      {startFailed}
    </div>
  )
}
