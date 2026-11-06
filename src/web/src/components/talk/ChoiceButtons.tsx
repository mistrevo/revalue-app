import { cn } from 'cn'
import { copy } from '@/copy'

/**
 * 答えの例のボタン。AI の答えの例と、区切ったあとの次の一手で同じ見た目にする。
 * 行を分けるときは、言葉のまとまりで分けられるブラウザ（Chrome）ではそこで分ける（auto-phrase）。
 */
export const CHOICE_BUTTON =
  'min-h-[52px] min-w-0 rounded-[14px] border-[1.5px] border-primary bg-surface px-3 py-1.5 text-left text-sm leading-snug font-bold break-words [word-break:auto-phrase] text-primary outline-none hover:bg-tint hover:text-on-tint focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50'

/**
 * 2 列の格子では、行の長さもそろえ、最後の 1 字だけが次の行に落ちないようにする。
 * 幅を言葉に合わせるボタン（4 つ以下）では、そろえると右に空きが残るので使わない。
 */
const BALANCE = '[text-wrap:balance]'

/**
 * 行を分けてよい所（「・」の後ろと「（」の前）で、言葉をまとまりに分ける（common-4（どの画面からもトークへ戻れ、幅に収まる））。
 * 古い Safari でも読み込めるよう、後読みの正規表現は使わない。
 */
function phrasesOf(label: string): string[] {
  return label.replaceAll('・', '・\u0000').replaceAll('（', '\u0000（').split('\u0000').filter(Boolean)
}

/**
 * まとまりごとに inline-block にし、まとまりの途中では先に行を分けない。
 * Chrome は inline-block のあいだに空白を入れて読み上げの名前を作るので、ボタンには元の言葉を aria-label で渡す。
 */
function Phrases({ text }: { text: string }) {
  return phrasesOf(text).map((phrase, index) => (
    <span key={index} className="inline-block">
      {phrase}
    </span>
  ))
}

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
          className={cn(CHOICE_BUTTON, grid ? BALANCE : 'max-w-full')}
          aria-label={choice}
          onClick={() => onChoose(choice)}
          disabled={disabled}
        >
          <Phrases text={choice} />
        </button>
      ))}
      <button
        type="button"
        className={cn(
          'min-h-[52px] min-w-0 rounded-[14px] border-[1.5px] border-dashed border-muted-foreground/60 bg-transparent px-3 py-1.5 text-left text-sm leading-snug font-bold break-words [word-break:auto-phrase] text-muted-foreground outline-none hover:bg-chip focus-visible:ring-3 focus-visible:ring-ring/50',
          grid ? BALANCE : 'max-w-full',
        )}
        aria-label={copy.talk.other}
        onClick={onOther}
      >
        <Phrases text={copy.talk.other} />
      </button>
    </div>
  )
}
