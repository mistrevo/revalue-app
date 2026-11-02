import { copy } from '@/copy'

const jstParts = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: 'numeric',
  hourCycle: 'h23',
})

const jstDay = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' })

/** 日時（ISO 8601）を、日本時間の「11 月 3 日」の形にする。読めなければ空の文字。 */
export function formatDay(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const parts = Object.fromEntries(jstDay.formatToParts(date).map((part) => [part.type, part.value]))
  return copy.episodes.date.replace('{month}', parts.month ?? '').replace('{day}', parts.day ?? '')
}

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

const jstDateTime = new Intl.DateTimeFormat('ja-JP', {
  timeZone: 'Asia/Tokyo',
  month: 'numeric',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
})

/** 日時（ISO 8601）を、日本時間の「11 月 3 日 12:00」の形にする。読めなければ空の文字。 */
export function formatDateTime(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  const parts = Object.fromEntries(jstDateTime.formatToParts(date).map((part) => [part.type, part.value]))
  return copy.abilities.dateTime
    .replace('{month}', parts.month ?? '')
    .replace('{day}', parts.day ?? '')
    .replace('{hour}', parts.hour ?? '')
    .replace('{minute}', parts.minute ?? '')
}
