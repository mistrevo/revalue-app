import { copy } from '@/copy'

const jstParts = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  hourCycle: 'h23',
})

/** 次に送れる時刻（ISO 8601）を、日本時間の「11 月 3 日の 0 時（日本時間）」の形にする。 */
export function formatResetTime(resetAt: string): string {
  const date = new Date(resetAt)
  if (Number.isNaN(date.getTime())) {
    return copy.limit.timeFallback
  }
  const parts = Object.fromEntries(jstParts.formatToParts(date).map((part) => [part.type, part.value]))
  return copy.limit.time
    .replace('{month}', parts.month ?? '')
    .replace('{day}', parts.day ?? '')
    .replace('{hour}', String(Number(parts.hour ?? '0')))
}
