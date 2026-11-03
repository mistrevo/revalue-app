import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { copy } from '@/copy'
import { DailyLimitNotice } from './DailyLimitNotice'

describe('DailyLimitNotice', () => {
  it('foundation-6（使いすぎを穏やかに止める）: 上限の表示は穏やかな言葉と次の時刻を出す', () => {
    render(<DailyLimitNotice resetAt="2026-11-03T00:00:00+09:00" />)

    expect(screen.getByText(copy.limit.title)).toBeInTheDocument()
    expect(screen.getByText(/0 時/)).toHaveTextContent('11 月 3 日の 0 時（日本時間）から、また続きを話せます。')
  })

  it('foundation-6（使いすぎを穏やかに止める）: 仕事の選択肢と選んだ案を深める画面では、何がまたできるかをその画面に合わせて書く', () => {
    const { unmount } = render(<DailyLimitNotice resetAt="2026-11-03T00:00:00+09:00" for="options" />)
    expect(screen.getByText(/0 時/)).toHaveTextContent('11 月 3 日の 0 時（日本時間）から、また仕事の選択肢を作れます。')
    unmount()

    render(<DailyLimitNotice resetAt="2026-11-03T00:00:00+09:00" for="deepen" />)
    expect(screen.getByText(/0 時/)).toHaveTextContent('11 月 3 日の 0 時（日本時間）から、また選んだ案を深められます。')
  })

  it('foundation-6（使いすぎを穏やかに止める）: 次の時刻は日本時間で表す（UTC で渡されても）', () => {
    render(<DailyLimitNotice resetAt="2026-11-02T15:00:00Z" />)

    expect(screen.getByText(/0 時/)).toHaveTextContent('11 月 3 日の 0 時（日本時間）')
  })

  it('foundation-6（使いすぎを穏やかに止める）: 時刻が読めなくても穏やかな言葉は出る', () => {
    render(<DailyLimitNotice resetAt="not-a-date" />)

    expect(screen.getByText(copy.limit.title)).toBeInTheDocument()
    expect(screen.getByText(/0 時/)).toHaveTextContent('日本時間の 0 時')
  })
})
