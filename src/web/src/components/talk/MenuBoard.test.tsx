import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { describe, expect, it } from 'vitest'
import { copy } from '@/copy'
import { MenuBoard } from './MenuBoard'

const TILES = [
  { name: copy.menu.episodes, href: '/episodes' },
  { name: copy.menu.abilities, href: '/abilities' },
  { name: copy.menu.profile, href: '/profile' },
  { name: copy.menu.options, href: '/options' },
  { name: copy.menu.report, href: '/report' },
  { name: copy.menu.settings, href: '/settings' },
]

function renderBoard(variant: 'bottom' | 'side') {
  return render(
    <MemoryRouter>
      <MenuBoard variant={variant} />
    </MemoryRouter>,
  )
}

describe('MenuBoard', () => {
  it('discover-12（開くとトークが出る）: スマホでは初めたたんでいて、開くと 6 つのタイルが出る。たたむと隠れる', async () => {
    renderBoard('bottom')

    const nav = screen.getByRole('navigation', { name: copy.menu.label })
    const open = within(nav).getByRole('button', { name: copy.menu.open })
    expect(open).toHaveAttribute('aria-expanded', 'false')
    expect(within(nav).queryAllByRole('link')).toHaveLength(0)

    await userEvent.click(open)

    const close = within(nav).getByRole('button', { name: copy.menu.close })
    expect(close).toHaveAttribute('aria-expanded', 'true')
    expect(within(nav).getAllByRole('link').map((l) => [l.textContent, l.getAttribute('href')])).toEqual(
      TILES.map((t) => [t.name, t.href]),
    )

    await userEvent.click(close)
    expect(within(nav).queryAllByRole('link')).toHaveLength(0)
  })

  it('discover-12（開くとトークが出る）: PC では、たたむボタンを出さず、いつも 6 つのタイルを出す', () => {
    renderBoard('side')

    const nav = screen.getByRole('navigation', { name: copy.menu.label })
    expect(within(nav).queryByRole('button')).not.toBeInTheDocument()
    expect(within(nav).getAllByRole('link')).toHaveLength(6)
  })

  it('discover-12（開くとトークが出る）: 選んだ案を深める画面はタイルにしない（仕事の選択肢と次にできることから行く）', async () => {
    renderBoard('bottom')
    await userEvent.click(screen.getByRole('button', { name: copy.menu.open }))

    expect(screen.queryByRole('link', { name: copy.titles.deepen })).not.toBeInTheDocument()
  })
})
