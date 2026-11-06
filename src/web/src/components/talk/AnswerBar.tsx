import { ArrowRight, Check } from 'lucide-react'
import { useLayoutEffect, type ReactNode, type RefObject } from 'react'
import { copy } from '@/copy'

/** 1 つの答えの長さの上限（裏側と同じ）。 */
export const MAX_ANSWER_LENGTH = 2000

/** 入力欄が広がる高さの上限（px）。それより長い文は、入力欄の中で上下に動かす。 */
const MAX_INPUT_HEIGHT = 160

/**
 * 入力の帯。入力欄（1 行から、書くと広がる）と丸い「送る」ボタン。actions（「ここで区切る」「この話は飛ばす」、
 * または飛ばすときの確かめ）は入力欄のすぐ上に置く。書きかけがあるあいだは、残っていることを下に小さく出す
 * （discover-11（書きかけを残す））。返事を待つあいだ（sending）は、入力欄を読むだけにする。送った答えの書きかけを
 * 送れたときに消し、送れなかったときに入力欄へ戻すので、待つあいだに書いた文があると、知らせずに消したり入れ替えたりしてしまうため
 * （Claude の判断）。フォーカスとキーボードは外さない。
 */
export function AnswerBar({
  value,
  onChange,
  onSend,
  sending,
  disabled = false,
  actions,
  inputRef,
  onFocusChange,
}: {
  value: string
  onChange: (value: string) => void
  onSend: () => void
  sending: boolean
  disabled?: boolean
  actions?: ReactNode
  inputRef: RefObject<HTMLTextAreaElement | null>
  onFocusChange?: (focused: boolean) => void
}) {
  // 書いた分だけ入力欄を広げる。画面の幅が変わったときも測り直す（測れないとき（テストなど）は、そのまま）
  useLayoutEffect(() => {
    const fit = () => {
      const el = inputRef.current
      if (!el) return
      el.style.height = 'auto'
      if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`
    }
    fit()
    window.addEventListener('resize', fit)
    return () => window.removeEventListener('resize', fit)
  }, [value, inputRef])

  const hasDraft = value.trim() !== ''

  return (
    <div className="flex flex-col gap-2">
      {actions}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          onSend()
        }}
      >
        <label htmlFor="talk-answer" className="sr-only">
          {copy.talk.inputLabel}
        </label>
        <textarea
          id="talk-answer"
          ref={inputRef}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onFocus={() => onFocusChange?.(true)}
          onBlur={() => onFocusChange?.(false)}
          placeholder={copy.talk.inputPlaceholder}
          maxLength={MAX_ANSWER_LENGTH}
          rows={1}
          readOnly={sending}
          disabled={disabled}
          className="min-h-12 min-w-0 flex-1 resize-none rounded-[22px] border-[1.5px] border-field-border bg-field px-4 py-3 text-base leading-normal text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-3 focus-visible:ring-ring/30"
        />
        <button
          type="submit"
          aria-label={copy.talk.send}
          disabled={sending || !hasDraft}
          className="flex size-12 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <ArrowRight aria-hidden className="size-[22px]" strokeWidth={2.2} />
        </button>
      </form>
      {hasDraft && (
        <p className="ml-4 flex items-center gap-1 text-xs leading-relaxed text-muted-foreground">
          <Check aria-hidden className="size-3.5 shrink-0 text-primary" strokeWidth={2.4} />
          <span>{copy.talk.draftKept}</span>
        </p>
      )}
    </div>
  )
}
