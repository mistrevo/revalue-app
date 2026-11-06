import { cn } from 'cn'
import { copy } from '@/copy'

/** 答えの例のボタン。AI の答えの例と、区切ったあとの次の一手で同じ見た目にする。 */
export const CHOICE_BUTTON =
  'min-h-[52px] min-w-0 rounded-[14px] border-[1.5px] border-primary bg-surface px-3 py-1.5 text-left text-sm leading-snug font-bold break-words text-primary outline-none hover:bg-tint hover:text-on-tint focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

/**
 * 答えの例（discover-3（選んでも書いてもよい））。5 つ以上（最初の問いの 9 つ）なら 2 列の格子、4 つ以下なら折り返して横に並べる。
 * 最後に、点線の枠の「それ以外（自分で書く）」を置き、押すと入力欄へ移る。長い言葉は折り返す。
 */
export function ChoiceButtons({
  choices,
  onChoose,
  onOther,
  disabled = false,
}: {
  choices: readonly string[]
  onChoose: (choice: string) => void
  onOther: () => void
  disabled?: boolean
}) {
  const grid = choices.length >= 5
  return (
    <div
      role="group"
      aria-label={copy.talk.choicesLabel}
      className={grid ? 'grid grid-cols-2 gap-2' : 'flex flex-wrap gap-2'}
    >
      {choices.map((choice) => (
        <button
          key={choice}
          type="button"
          className={cn(CHOICE_BUTTON, !grid && 'max-w-full')}
          onClick={() => onChoose(choice)}
          disabled={disabled}
        >
          {choice}
        </button>
      ))}
      <button
        type="button"
        className={cn(
          'min-h-[52px] min-w-0 rounded-[14px] border-[1.5px] border-dashed border-muted-foreground/60 bg-transparent px-3 py-1.5 text-left text-sm leading-snug font-bold break-words text-muted-foreground outline-none hover:bg-chip focus-visible:ring-3 focus-visible:ring-ring/50',
          !grid && 'max-w-full',
        )}
        onClick={onOther}
      >
        {copy.talk.other}
      </button>
    </div>
  )
}
