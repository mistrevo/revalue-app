import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { ChoiceButtons } from './ChoiceButtons'

/** 最初の問いの 9 つ（裏側の DiscoverText と同じ言葉）。 */
const OPENING = [
  'うれしかった・楽しかったこと',
  'できた・達成できたこと',
  'ほっとした・安心したこと',
  '困った・大変だったこと',
  '思いどおりにいかなかったこと',
  '迷った・悩んだこと',
  '腹が立った・納得できなかったこと',
  '気づいた・考えさせられたこと',
  '何気ない日常の出来事',
]

/** ボタンの中の、行を分けるまとまり（途中で先に分けない inline-block）の言葉。 */
function phrases(button: HTMLElement) {
  return [...button.querySelectorAll('span.inline-block')].map((span) => span.textContent)
}

describe('ChoiceButtons', () => {
  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 選択肢は「・」の後ろと「（」の前で行を分け、押すと元の言葉のまま送る', async () => {
    const onChoose = vi.fn()
    render(<ChoiceButtons choices={OPENING} onChoose={onChoose} onOther={() => {}} />)

    const done = screen.getByRole('button', { name: 'できた・達成できたこと' })
    expect(phrases(done)).toEqual(['できた・', '達成できたこと'])
    expect(phrases(screen.getByRole('button', { name: '腹が立った・納得できなかったこと' }))).toEqual([
      '腹が立った・',
      '納得できなかったこと',
    ])
    expect(phrases(screen.getByRole('button', { name: copy.talk.other }))).toEqual(['それ以外', '（自分で書く）'])
    // 分ける所がない言葉は、ひとまとまりのまま
    expect(phrases(screen.getByRole('button', { name: '何気ない日常の出来事' }))).toEqual(['何気ない日常の出来事'])
    // まとまりの中で分けるときも、言葉のまとまりで分けられるブラウザ（Chrome）ではそこで分ける
    for (const button of screen.getAllByRole('button')) expect(button).toHaveClass('[word-break:auto-phrase]')
    // Chrome は、inline-block のまとまりのあいだに空白を入れて読み上げの名前を作る（「できた・ 達成できたこと」）。
    // この画面のテスト（jsdom）では空白が出ないので、名前は元の言葉そのままを aria-label で渡していることを確かめる
    expect(done).toHaveAttribute('aria-label', 'できた・達成できたこと')
    expect(screen.getByRole('button', { name: copy.talk.other })).toHaveAttribute('aria-label', copy.talk.other)

    await userEvent.click(done)
    expect(onChoose).toHaveBeenCalledWith('できた・達成できたこと')
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 2 列の格子では行の長さをそろえ、最後の 1 字だけが次の行に落ちないようにする', () => {
    render(<ChoiceButtons choices={OPENING} onChoose={() => {}} onOther={() => {}} />)

    for (const button of screen.getAllByRole('button')) expect(button).toHaveClass('[text-wrap:balance]')
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 4 つ以下の答えの例も「・」の後ろで行を分ける。ボタンの幅は言葉に合わせるので、行の長さはそろえない', () => {
    render(<ChoiceButtons choices={['朝・夕方', '子どもを送った']} onChoose={() => {}} onOther={() => {}} />)

    const morning = screen.getByRole('button', { name: '朝・夕方' })
    expect(phrases(morning)).toEqual(['朝・', '夕方'])
    // 行の長さをそろえると、言葉に合わせた幅のボタンの右に空きが残る
    expect(morning).not.toHaveClass('[text-wrap:balance]')
  })
})
