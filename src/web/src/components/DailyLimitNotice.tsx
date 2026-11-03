import { copy } from '@/copy'
import { formatResetTime } from '@/lib/jst'

/**
 * 送信回数の上限に達したときの表示。利用者のせいにせず、次に使える時刻を添える。
 * for は使う画面。talk は話す画面（また続きを話せます）、make は仕事の選択肢と選んだ案を深める画面（また作れます）。
 */
export function DailyLimitNotice({ resetAt, for: where = 'talk' }: { resetAt: string; for?: 'talk' | 'make' }) {
  return (
    <div role="status" className="rounded-xl border bg-muted/40 px-4 py-4 text-sm leading-relaxed">
      <p className="font-medium">{copy.limit.title}</p>
      <p className="mt-1 text-muted-foreground">
        {(where === 'make' ? copy.limit.bodyMake : copy.limit.body).replace('{time}', formatResetTime(resetAt))}
      </p>
    </div>
  )
}
