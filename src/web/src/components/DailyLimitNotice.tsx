import { copy } from '@/copy'
import { formatResetTime } from '@/lib/jst'

/** 送信回数の上限に達したときの表示。利用者のせいにせず、次に話せる時刻を添える。 */
export function DailyLimitNotice({ resetAt }: { resetAt: string }) {
  return (
    <div role="status" className="rounded-xl border bg-muted/40 px-4 py-4 text-sm leading-relaxed">
      <p className="font-medium">{copy.limit.title}</p>
      <p className="mt-1 text-muted-foreground">
        {copy.limit.body.replace('{time}', formatResetTime(resetAt))}
      </p>
    </div>
  )
}
