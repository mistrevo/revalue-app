import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import {
  ApiError,
  finishEpisode,
  getEpisode,
  isDailyLimit,
  resumeEpisode,
  sendAnswer,
  sendCorrection,
  skipEpisode,
  type AnswerKind,
  type Episode,
  type SupportNotice,
  type TalkErrorKind,
  type Turn,
} from '@/api'
import { DailyLimitNotice } from '@/components/DailyLimitNotice'
import { Insights } from '@/components/Insights'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'

/** 1 つの答えの長さの上限（裏側と同じ）。 */
const MAX_ANSWER_LENGTH = 2000

/** 話す画面。場面が変わったら（飛ばしたあとなど）、読み直すために作り直す。 */
export function Talk() {
  const { id = '' } = useParams()
  return <TalkScreen key={id} id={id} />
}

type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'notFound' } | { kind: 'error' }

function TalkScreen({ id }: { id: string }) {
  const navigate = useNavigate()
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)

  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [episode, setEpisode] = useState<Episode | null>(null)
  const [notice, setNotice] = useState<SupportNotice | null>(null)
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<{ text: string; kind: AnswerKind } | null>(null)
  const [streamText, setStreamText] = useState('')
  const [errorKind, setErrorKind] = useState<TalkErrorKind | null>(null)
  const [limitResetAt, setLimitResetAt] = useState<string | null>(null)
  const [confirmingSkip, setConfirmingSkip] = useState(false)
  const [busy, setBusy] = useState(false)
  const [actionFailed, setActionFailed] = useState(false)
  const [correcting, setCorrecting] = useState(false)
  const [correction, setCorrection] = useState('')
  const [correctionError, setCorrectionError] = useState<'failure' | 'refusal' | null>(null)

  useEffect(() => {
    let active = true
    getEpisode(id)
      .then((loaded) => {
        if (!active) return
        setEpisode(loaded)
        setNotice(loaded.notice ?? null)
        setLoad({ kind: 'ready' })
      })
      .catch((e: unknown) => {
        if (!active) return
        setLoad(e instanceof ApiError && e.status === 404 ? { kind: 'notFound' } : { kind: 'error' })
      })
    return () => {
      active = false
    }
  }, [id])

  // 新しいやりとりが出たら、いちばん下を見せる
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' })
  }, [episode?.turns.length, streamText, pending])

  if (load.kind === 'loading') {
    return (
      <Page>
        <p className="text-sm text-muted-foreground">{copy.loading}</p>
      </Page>
    )
  }
  if (load.kind !== 'ready' || episode === null) {
    return (
      <Page>
        <p role="alert" className="text-sm leading-relaxed">
          {load.kind === 'notFound' ? copy.talk.notFound : copy.errors.generic}
        </p>
        <BackHome />
      </Page>
    )
  }

  const talking = episode.status === 'talking'
  const lastTurn = episode.turns.at(-1)
  const choices =
    talking && pending === null && lastTurn?.role === 'assistant' && lastTurn.choices ? lastTurn.choices : []

  async function send(text: string, kind: AnswerKind) {
    const answer = text.trim()
    if (pending !== null || answer === '') return

    setPending({ text: answer, kind })
    setStreamText('')
    setErrorKind(null)
    setNotice(null)
    setLimitResetAt(null)
    setConfirmingSkip(false)
    setActionFailed(false)
    if (kind === 'free') setInput('')

    // 書いた答えは、失敗したら入力欄に戻す
    const restore = () => {
      if (kind === 'free') setInput(text)
    }

    let body = ''
    let replyChoices: string[] | null = null
    let replyNotice: SupportNotice | null = null
    try {
      await sendAnswer(id, { text: answer, kind }, {
        onDelta: (piece) => {
          body += piece
          setStreamText(body)
        },
        onChoices: (received) => {
          replyChoices = received
        },
        onNotice: (received) => {
          replyNotice = received
          setNotice(received)
        },
        onDone: (done) => {
          const distress = replyNotice?.kind === 'distress' ? replyNotice : null
          const now = new Date().toISOString()
          const userTurn: Turn = { role: 'user', text: answer, answerKind: kind, at: now }
          const reply: Turn = {
            role: 'assistant',
            text: distress ? distress.text : body,
            choices: replyChoices,
            move: done.move,
            at: now,
          }
          setEpisode((current) =>
            current && { ...current, status: done.status, turns: [...current.turns, userTurn, reply], notice: distress },
          )
          setNotice(distress)
          // 締めの返事で話し終えたら、見えたことを読み直す
          if (done.status === 'finished') reloadEpisode()
        },
        onError: (kind) => {
          setErrorKind(kind)
          restore()
          if (kind === 'closed') reloadEpisode()
        },
      })
    } catch (e) {
      restore()
      if (isDailyLimit(e)) {
        setLimitResetAt(e.resetAt ?? '')
      } else {
        // ほかの画面で飛ばされた（404）・区切られた（409）場面には、送り直しても届かない
        const closed = e instanceof ApiError && (e.status === 404 || e.status === 409)
        setErrorKind(closed ? 'closed' : 'failure')
        if (closed) reloadEpisode()
      }
    } finally {
      setPending(null)
      setStreamText('')
    }
  }

  // いまの状態を読み直す。もうなければ、やりとりはそのまま残す
  function reloadEpisode() {
    getEpisode(id)
      .then(setEpisode)
      .catch(() => {})
  }

  async function finish() {
    setBusy(true)
    setActionFailed(false)
    try {
      // 区切ったあとは、ホームへ戻らず、この画面で見えたことを出す
      const finished = await finishEpisode(id)
      setEpisode(finished)
      setNotice(finished.notice ?? null)
      setConfirmingSkip(false)
    } catch {
      setActionFailed(true)
    } finally {
      setBusy(false)
    }
  }

  async function correct() {
    const text = correction.trim()
    if (text === '') return
    setBusy(true)
    setCorrectionError(null)
    setLimitResetAt(null)
    setActionFailed(false)
    try {
      const updated = await sendCorrection(id, text)
      setEpisode(updated)
      setNotice(updated.notice ?? null)
      setCorrecting(false)
      setCorrection('')
    } catch (e) {
      // 書いた訂正は入力欄に残す
      if (isDailyLimit(e)) {
        setLimitResetAt(e.resetAt ?? '')
      } else {
        setCorrectionError(e instanceof ApiError && e.kind === 'refusal' ? 'refusal' : 'failure')
      }
    } finally {
      setBusy(false)
    }
  }

  async function resume() {
    setBusy(true)
    setActionFailed(false)
    try {
      const resumed = await resumeEpisode(id)
      setEpisode(resumed)
      setNotice(null)
      setErrorKind(null)
      setCorrecting(false)
      setBusy(false)
    } catch (e) {
      // ほかの画面で別の場面が始まっていたら、その場面を開く（1 人 1 つまで）
      if (e instanceof ApiError && e.status === 409 && e.episodeId) {
        navigate(`/talk/${e.episodeId}`)
        return
      }
      setActionFailed(true)
      setBusy(false)
    }
  }

  async function skip() {
    setBusy(true)
    setActionFailed(false)
    try {
      const next = await skipEpisode(id)
      navigate(`/talk/${next.id}`, { replace: true })
    } catch (e) {
      // この場面は消えたが、ほかの画面で別の場面がもう始まっていた。2 つ目は作られないので、その場面を開く
      if (e instanceof ApiError && e.status === 409 && e.episodeId) {
        navigate(`/talk/${e.episodeId}`, { replace: true })
        return
      }
      setActionFailed(true)
      setBusy(false)
    }
  }

  function focusInput() {
    inputRef.current?.focus()
  }

  // つらい状態のサインのあとの 3 つの続け方。並びは裏側の DiscoverText.DistressActions と同じ
  // （続けて話す、今日はここで区切る、この話は残さずに別の話にする）
  const distressHandlers = [focusInput, finish, () => setConfirmingSkip(true)]

  return (
    <Page>
      <h1 className="text-lg font-bold">{copy.talk.title}</h1>

      <div role="log" aria-label={copy.talk.logLabel} className="mt-4 flex flex-col gap-3">
        {episode.turns.map((turn, index) => (
          <TurnBubble key={index} role={turn.role} text={turn.text} />
        ))}
        {pending !== null && <TurnBubble role="user" text={pending.text} />}
        {pending !== null && streamText !== '' && <TurnBubble role="assistant" text={streamText} />}
      </div>

      {pending !== null && streamText === '' && (
        <p role="status" className="mt-3 text-sm text-muted-foreground">
          {copy.talk.waiting}
        </p>
      )}

      {/* 失敗の言葉を先に出し、相談先は、そのあとに添える */}
      {errorKind !== null && (
        <p role="alert" className="mt-4 text-sm leading-relaxed">
          {errorKind === 'refusal' ? copy.talk.refusal : errorKind === 'closed' ? copy.talk.closed : copy.talk.failure}
        </p>
      )}
      {/* 話し終えた場面は、下にホームへの道が出るので、ここには出さない */}
      {errorKind === 'closed' && talking && <BackHome />}

      {notice !== null && pending === null && (
        <div className="mt-4 rounded-xl border bg-muted/40 px-4 py-3 text-sm leading-relaxed">
          {notice.kind === 'support' && <p>{notice.text}</p>}
          <a
            href={notice.linkUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-primary underline underline-offset-4"
          >
            {notice.linkLabel}
            <span className="text-muted-foreground">{copy.talk.newTab}</span>
          </a>
          {notice.kind === 'distress' && talking && notice.actions && (
            <div className="mt-3 flex flex-col gap-2">
              {notice.actions.map((action, index) => (
                <Button
                  key={action}
                  variant="outline"
                  className="h-auto w-full justify-start py-2 text-left whitespace-normal"
                  onClick={distressHandlers[index]}
                  disabled={busy}
                >
                  {action}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}

      {limitResetAt !== null && (
        <div className="mt-4">
          <DailyLimitNotice resetAt={limitResetAt} />
        </div>
      )}

      {talking ? (
        <>
          {choices.length > 0 && (
            <div role="group" aria-label={copy.talk.choicesLabel} className="mt-4 flex flex-col gap-2">
              {choices.map((choice) => (
                <Button
                  key={choice}
                  variant="outline"
                  className="h-auto w-full justify-start py-2 text-left whitespace-normal"
                  onClick={() => send(choice, 'choice')}
                >
                  {choice}
                </Button>
              ))}
              <Button
                variant="ghost"
                className="h-auto w-full justify-start py-2 text-left whitespace-normal"
                onClick={focusInput}
              >
                {copy.talk.other}
              </Button>
            </div>
          )}

          <form
            className="mt-4 flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault()
              void send(input, 'free')
            }}
          >
            <label htmlFor="talk-answer" className="sr-only">
              {copy.talk.inputLabel}
            </label>
            <textarea
              id="talk-answer"
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              placeholder={copy.talk.inputPlaceholder}
              maxLength={MAX_ANSWER_LENGTH}
              rows={3}
              className="w-full rounded-lg border bg-background px-3 py-2 text-base leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <Button type="submit" size="lg" className="w-full sm:w-auto sm:self-end" disabled={pending !== null || input.trim() === ''}>
              {pending !== null ? copy.talk.sending : copy.talk.send}
            </Button>
          </form>

          {confirmingSkip ? (
            <div className="mt-6 rounded-lg bg-muted/50 px-4 py-4">
              <p className="text-sm font-medium">{copy.talk.skipQuestion}</p>
              <div className="mt-3 flex flex-col gap-2 sm:flex-row">
                {/* どちらを選んでもよいので、片方を目立たせない（Claude の判断） */}
                <Button variant="outline" onClick={skip} disabled={busy} className="w-full sm:w-auto">
                  {copy.talk.skipYes}
                </Button>
                <Button variant="outline" onClick={() => setConfirmingSkip(false)} disabled={busy} className="w-full sm:w-auto">
                  {copy.talk.skipNo}
                </Button>
              </div>
            </div>
          ) : (
            <div className="mt-6 flex flex-col gap-2 sm:flex-row">
              <Button variant="outline" onClick={finish} disabled={busy || pending !== null} className="w-full sm:w-auto">
                {copy.talk.finish}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setConfirmingSkip(true)}
                disabled={busy || pending !== null}
                className="w-full sm:w-auto"
              >
                {copy.talk.skip}
              </Button>
            </div>
          )}
        </>
      ) : (
        <>
          <p className="mt-6 text-sm leading-relaxed text-muted-foreground">{copy.talk.finished}</p>
          {episode.insights && (
            <div className="mt-4">
              <Insights insights={episode.insights} />

              {correcting ? (
                <form
                  className="mt-4 flex flex-col gap-2 rounded-lg bg-muted/50 px-4 py-4"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void correct()
                  }}
                >
                  <label htmlFor="talk-correction" className="text-sm font-medium">
                    {copy.insights.correctLabel}
                  </label>
                  <textarea
                    id="talk-correction"
                    value={correction}
                    onChange={(event) => setCorrection(event.target.value)}
                    placeholder={copy.insights.correctPlaceholder}
                    maxLength={MAX_ANSWER_LENGTH}
                    rows={3}
                    className="w-full rounded-lg border bg-background px-3 py-2 text-base leading-relaxed outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
                  />
                  {correctionError !== null && (
                    <p role="alert" className="text-sm leading-relaxed">
                      {correctionError === 'refusal' ? copy.insights.correctRefusal : copy.talk.failure}
                    </p>
                  )}
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Button type="submit" disabled={busy || correction.trim() === ''} className="w-full sm:w-auto">
                      {copy.insights.correctSend}
                    </Button>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={busy}
                      onClick={() => {
                        setCorrecting(false)
                        setCorrectionError(null)
                      }}
                      className="w-full sm:w-auto"
                    >
                      {copy.insights.correctCancel}
                    </Button>
                  </div>
                </form>
              ) : (
                <div className="mt-4 flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  {episode.insights.canResume && (
                    <Button onClick={resume} disabled={busy} className="h-auto w-full py-2 whitespace-normal sm:w-auto">
                      {copy.insights.resume}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    onClick={() => setCorrecting(true)}
                    disabled={busy}
                    className="h-auto w-full py-2 whitespace-normal sm:w-auto"
                  >
                    {copy.insights.correct}
                  </Button>
                </div>
              )}

              <div className="mt-4">
                <Button asChild variant="ghost" className="h-auto w-full py-2 whitespace-normal sm:w-auto">
                  <Link to="/abilities">{copy.insights.seeAll}</Link>
                </Button>
              </div>
            </div>
          )}
          <BackHome />
        </>
      )}

      {actionFailed && (
        <p role="alert" className="mt-3 text-sm leading-relaxed">
          {copy.errors.generic}
        </p>
      )}
      <div ref={bottomRef} />
    </Page>
  )
}

function TurnBubble({ role, text }: { role: Turn['role']; text: string }) {
  const mine = role === 'user'
  return (
    <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          mine
            ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-primary px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap text-primary-foreground'
            : 'max-w-[85%] rounded-2xl rounded-bl-sm bg-muted px-4 py-2 text-sm leading-relaxed whitespace-pre-wrap'
        }
      >
        <span className="sr-only">{mine ? copy.talk.you : copy.talk.listener}</span>
        <p>{text}</p>
      </div>
    </div>
  )
}

function BackHome() {
  return (
    <div className="mt-6">
      <Button asChild variant="outline" className="w-full sm:w-auto">
        <Link to="/home">{copy.talk.backHome}</Link>
      </Button>
    </div>
  )
}
