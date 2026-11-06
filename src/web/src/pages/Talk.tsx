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
import { AfterTalk } from '@/components/talk/AfterTalk'
import { AnswerBar, MAX_ANSWER_LENGTH } from '@/components/talk/AnswerBar'
import { Bubble, DateChip, TalkCard } from '@/components/talk/Bubble'
import { ChoiceButtons } from '@/components/talk/ChoiceButtons'
import { TalkLayout } from '@/components/talk/TalkLayout'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'
import { clearDraft, readDraft, writeDraft } from '@/lib/drafts'
import { formatDayChip } from '@/lib/jst'

/** 入力欄から離れてから、メニュー板を戻すまでの間（ms）。「送る」を押すあいだに帯が動かないようにする（Claude の判断）。 */
const MENU_RETURN_DELAY = 200

/**
 * 話す画面。LINE のトークの形で、上の帯・やりとり・下の帯（入力の帯とメニュー板）に分ける（discover-12（開くとトークが出る））。
 * 場面が変わったら（飛ばしたあとなど）、読み直すために作り直す。
 */
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
  // 書きかけは、場面ごとにその端末のブラウザへ残し、開き直したら入力欄に戻す（discover-11（書きかけを残す））
  const [input, setInput] = useState(() => readDraft(id))
  // 入力欄に文字を打っているあいだは、メニュー板を隠す（キーボードとぶつからないように）
  const [typing, setTyping] = useState(false)
  const menuTimer = useRef<number | undefined>(undefined)
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
  // 読み直しに失敗したときに、念のため添える相談窓口（話す画面の読み取りの失敗と同じ扱い）
  const [correctionNotice, setCorrectionNotice] = useState<SupportNotice | null>(null)

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

  useEffect(() => () => window.clearTimeout(menuTimer.current), [])

  // 新しいやりとりが出たら、いちばん下を見せる
  useEffect(() => {
    bottomRef.current?.scrollIntoView?.({ block: 'end' })
  }, [episode?.turns.length, streamText, pending])

  if (load.kind === 'loading') {
    return (
      <TalkLayout>
        <p className="text-muted-foreground">{copy.loading}</p>
      </TalkLayout>
    )
  }
  if (load.kind !== 'ready' || episode === null) {
    return (
      <Page>
        <p role="alert" className="text-sm leading-relaxed">
          {load.kind === 'notFound' ? copy.talk.notFound : copy.errors.generic}
        </p>
        <BackToTalk />
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
          // 送れた書いた答えの書きかけは消す。選んで送ったときは、入力欄に残っている書きかけをそのまま残す
          if (kind === 'free') clearDraft(id)
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
      // 区切ったあとは、ほかの画面へ移らず、この画面で見えたことを出す
      const finished = await finishEpisode(id)
      clearDraft(id)
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
    setCorrectionNotice(null)
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
        setCorrectionNotice(e instanceof ApiError ? (e.notice ?? null) : null)
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
      clearDraft(id)
      navigate(`/talk/${next.id}`, { replace: true })
    } catch (e) {
      // この場面は消えたが、ほかの画面で別の場面がもう始まっていた。2 つ目は作られないので、その場面を開く
      if (e instanceof ApiError && e.status === 409 && e.episodeId) {
        clearDraft(id)
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
  // 相談窓口の 3 つの続け方を出しているあいだは、下の「ここで区切る」「この話は飛ばす」を重ねて出さない。
  // 同じことが窓口の「今日はここで区切る」「この話は残さずに、別の話にする」でできる（Claude の判断）
  const distressActionsShown = notice?.kind === 'distress' && talking && pending === null && Boolean(notice.actions?.length)

  function changeInput(value: string) {
    setInput(value)
    writeDraft(id, value)
  }

  // 入力欄から離れたら、少し待ってからメニュー板を戻す
  function focusChanged(focused: boolean) {
    window.clearTimeout(menuTimer.current)
    if (focused) {
      setTyping(true)
    } else {
      menuTimer.current = window.setTimeout(() => setTyping(false), MENU_RETURN_DELAY)
    }
  }

  const dateChip = formatDayChip(episode.startedAt)
  const sending = pending !== null

  // 入力欄のすぐ上に置く、「ここで区切る」「この話は飛ばす」（最初の問いのところでも出す。discover-5（つらい話は飛ばせる））
  const actions = confirmingSkip ? (
    <div className="rounded-xl bg-ground px-3 py-3">
      <p className="text-sm font-bold">{copy.talk.skipQuestion}</p>
      <div className="mt-2 flex flex-wrap gap-2">
        {/* どちらを選んでもよいので、片方を目立たせない（Claude の判断） */}
        <button type="button" onClick={skip} disabled={busy} className={PILL}>
          {copy.talk.skipYes}
        </button>
        <button type="button" onClick={() => setConfirmingSkip(false)} disabled={busy} className={PILL}>
          {copy.talk.skipNo}
        </button>
      </div>
    </div>
  ) : distressActionsShown ? null : (
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={finish} disabled={busy || sending} className={PILL}>
        {copy.talk.finish}
      </button>
      <button type="button" onClick={() => setConfirmingSkip(true)} disabled={busy || sending} className={PILL_QUIET}>
        {copy.talk.skip}
      </button>
    </div>
  )

  return (
    <TalkLayout
      menuHidden={typing && talking}
      footer={
        talking ? (
          <AnswerBar
            value={input}
            onChange={changeInput}
            onSend={() => void send(input, 'free')}
            sending={sending}
            actions={actions}
            inputRef={inputRef}
            onFocusChange={focusChanged}
          />
        ) : undefined
      }
    >
      <div className="flex flex-col gap-3">
        <div role="log" aria-label={copy.talk.logLabel} className="flex flex-col gap-3">
          {dateChip !== '' && <DateChip>{dateChip}</DateChip>}
          {episode.turns.map((turn, index) =>
            turn.answerKind === 'correction' ? (
              <CorrectionBox key={index} text={turn.text} />
            ) : (
              <Bubble key={index} role={turn.role}>
                {turn.text}
              </Bubble>
            ),
          )}
          {pending !== null && <Bubble role="user">{pending.text}</Bubble>}
          {pending !== null && streamText !== '' && <Bubble role="assistant">{streamText}</Bubble>}
          {pending !== null && streamText === '' && (
            <div role="status">
              <Bubble role="assistant">
                <span className="text-muted-foreground">{copy.talk.waiting}</span>
              </Bubble>
            </div>
          )}
          {!talking && <DateChip>{copy.talk.finishedChip}</DateChip>}
        </div>

        {/* 失敗の言葉を先に出し、相談先は、そのあとに添える */}
        {errorKind !== null && (
          <TalkCard role="alert">
            <p>{errorKind === 'refusal' ? copy.talk.refusal : errorKind === 'closed' ? copy.talk.closed : copy.talk.failure}</p>
            {errorKind === 'closed' && (
              <Button asChild variant="outline" className="mt-3 h-auto min-h-11 w-full py-2 whitespace-normal sm:w-auto">
                <Link to="/talk">{copy.nav.backToTalk}</Link>
              </Button>
            )}
          </TalkCard>
        )}
        {notice !== null && pending === null && (
          <TalkCard>
            {notice.kind === 'support' && <p>{notice.text}</p>}
            <a
              href={notice.linkUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="font-bold break-words text-primary underline underline-offset-4"
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
                    className="h-auto min-h-11 w-full justify-start py-2 text-left whitespace-normal"
                    onClick={distressHandlers[index]}
                    disabled={busy}
                  >
                    {action}
                  </Button>
                ))}
              </div>
            )}
          </TalkCard>
        )}

        {limitResetAt !== null && <DailyLimitNotice resetAt={limitResetAt} />}

        {talking && choices.length > 0 && (
          <ChoiceButtons choices={choices} onChoose={(choice) => void send(choice, 'choice')} onOther={focusInput} />
        )}

        {!talking && episode.insights && (
          // 見えたことは、トークの中のカードで出す。読み取りを直す欄も、カードの中で開く（03-validate.md の「話し終えたとき」）
          <Insights insights={episode.insights}>
            {correcting ? (
              <form
                className="flex flex-col gap-2 rounded-xl bg-ground px-3 py-3"
                onSubmit={(event) => {
                  event.preventDefault()
                  void correct()
                }}
              >
                <label htmlFor="talk-correction" className="text-sm font-bold">
                  {copy.insights.correctLabel}
                </label>
                <textarea
                  id="talk-correction"
                  value={correction}
                  onChange={(event) => setCorrection(event.target.value)}
                  placeholder={copy.insights.correctPlaceholder}
                  maxLength={MAX_ANSWER_LENGTH}
                  rows={3}
                  className="w-full rounded-xl border-[1.5px] border-field-border bg-field px-3 py-2 text-base leading-relaxed outline-none focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/30"
                />
                {correctionError !== null && (
                  <p role="alert" className="text-sm leading-relaxed">
                    {copy.insights.correctFailed}
                  </p>
                )}
                {correctionError !== null && correctionNotice !== null && (
                  <p className="text-sm leading-relaxed text-muted-foreground">
                    {correctionNotice.text}{' '}
                    <a
                      href={correctionNotice.linkUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-bold text-primary underline underline-offset-4"
                    >
                      {correctionNotice.linkLabel}
                      <span className="text-muted-foreground">{copy.talk.newTab}</span>
                    </a>
                  </p>
                )}
                <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                  <Button type="submit" disabled={busy || correction.trim() === ''} className="min-h-11 w-full sm:w-auto">
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
                    className="min-h-11 w-full sm:w-auto"
                  >
                    {copy.insights.correctCancel}
                  </Button>
                </div>
              </form>
            ) : (
              <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
                {episode.insights.canResume && (
                  <Button onClick={resume} disabled={busy} className="h-auto min-h-12 w-full rounded-[14px] py-2 text-[15px] whitespace-normal sm:w-auto sm:flex-1">
                    {copy.insights.resume}
                  </Button>
                )}
                <Button
                  variant="outline"
                  onClick={() => setCorrecting(true)}
                  disabled={busy}
                  className="h-auto min-h-12 w-full rounded-[14px] border-[1.5px] border-primary py-2 text-[15px] whitespace-normal text-primary sm:w-auto sm:flex-1"
                >
                  {copy.insights.correct}
                </Button>
                {/* 文字と地の組は、色のテストで確かめている on-tint と tint にする（みかんの accent と tile は 4.5 に届かない） */}
                <Link
                  to="/abilities"
                  className="inline-flex min-h-12 w-full items-center justify-center rounded-[14px] bg-tint px-3 py-2 text-center text-[15px] font-bold text-on-tint outline-none hover:bg-chip focus-visible:ring-3 focus-visible:ring-ring/50 sm:w-auto sm:flex-1"
                >
                  {copy.insights.seeAll}
                </Link>
              </div>
            )}
          </Insights>
        )}
        {/* つらい状態のサインに応えたところで終わった場面では、先へ進む道を勧めない（Claude の判断） */}
        {!talking && <AfterTalk distress={notice?.kind === 'distress'} refreshKey={episode.insights} />}

        {actionFailed && (
          <p role="alert" className="leading-relaxed">
            {copy.errors.generic}
          </p>
        )}
        <div ref={bottomRef} />
      </div>
    </TalkLayout>
  )
}

/** 入力欄の上の「ここで区切る」と、飛ばすときの確かめのボタン。枠は区切りの線の色にする。 */
const PILL =
  'min-h-11 rounded-full border-[1.5px] border-border bg-surface px-3.5 text-sm font-bold text-foreground outline-none hover:bg-ground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'
/** 「この話は飛ばす」。目立たせない。 */
const PILL_QUIET =
  'min-h-11 rounded-full px-3.5 text-sm font-bold text-muted-foreground outline-none hover:bg-ground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

function CorrectionBox({ text }: { text: string }) {
  return (
    <div className="flex justify-end">
      <div className="max-w-[85%] min-w-0 rounded-[18px] border border-border bg-surface px-3.5 py-2.5 leading-relaxed break-words">
        <p className="text-xs text-muted-foreground">{copy.talk.correctionLabel}</p>
        <p className="whitespace-pre-wrap">{text}</p>
      </div>
    </div>
  )
}

function BackToTalk() {
  return (
    <div className="mt-6">
      <Button asChild variant="outline" className="min-h-11 w-full sm:w-auto">
        <Link to="/talk">{copy.nav.backToTalk}</Link>
      </Button>
    </div>
  )
}
