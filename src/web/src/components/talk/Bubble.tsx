import type { ReactNode } from 'react'
import { copy } from '@/copy'

/**
 * トークの吹き出し。聞き手は左に surface、本人は右に tint。読み上げでは、だれの言葉かを先に伝える。
 */
export function Bubble({ role, children }: { role: 'user' | 'assistant'; children: ReactNode }) {
  const mine = role === 'user'
  return (
    <div className={mine ? 'flex justify-end' : 'flex justify-start'}>
      <div
        className={
          mine
            ? 'max-w-[85%] min-w-0 rounded-[18px] rounded-tr-[4px] bg-tint px-3.5 py-2.5 leading-[1.7] break-words whitespace-pre-wrap text-on-tint'
            : 'max-w-[88%] min-w-0 rounded-[18px] rounded-tl-[4px] bg-surface px-3.5 py-2.5 leading-[1.7] break-words whitespace-pre-wrap'
        }
      >
        <span className="sr-only">{mine ? copy.talk.you : copy.talk.listener}</span>
        <p>{children}</p>
      </div>
    </div>
  )
}

/** 場面の始まりに出す日付の札。 */
export function DateChip({ children }: { children: ReactNode }) {
  return (
    <p className="self-center rounded-full bg-chip px-3 py-0.5 text-xs leading-relaxed text-muted-foreground">{children}</p>
  )
}

/** トークの中に出すお知らせのカード（相談先の案内、使いすぎのお知らせ、失敗の言葉）。 */
export function TalkCard({ children, role }: { children: ReactNode; role?: 'alert' | 'status' }) {
  return (
    <div data-slot="talk-card" role={role} className="rounded-2xl border border-border bg-surface px-4 py-3 leading-relaxed">
      {children}
    </div>
  )
}
