import { copy } from '@/copy'
import { formatResetTime } from '@/lib/jst'

/**
 * 送信回数の上限に達したときの表示。利用者のせいにせず、次に使える時刻を添える。
 * for は使う画面。何がまたできるかを、その画面に合わせて書く（00-common.md の「言葉」）。
 */
const BODY = { talk: copy.limit.body, options: copy.limit.bodyOptions, deepen: copy.limit.bodyDeepen } as const

export function DailyLimitNotice({ resetAt, for: where = 'talk' }: { resetAt: string; for?: keyof typeof BODY }) {
  return (
    <div role="status" className="rounded-xl border bg-muted/40 px-4 py-4 text-sm leading-relaxed">
      <p className="font-medium">{copy.limit.title}</p>
      <p className="mt-1 text-muted-foreground">
        {BODY[where].replace('{time}', formatResetTime(resetAt))}
      </p>
    </div>
  )
}
