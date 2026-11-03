import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { installFakeApi } from '@/test/fake-api'
import { NextStepLink } from './NextStepLink'

afterEach(() => {
  vi.unstubAllGlobals()
})

function renderAt(path: string, node = <NextStepLink />) {
  return render(<MemoryRouter initialEntries={[path]}>{node}</MemoryRouter>)
}

function nextStepCalls(api: ReturnType<typeof installFakeApi>) {
  return api.calls.filter((c) => c.url === '/api/next-step')
}

describe('NextStepLink', () => {
  it('common-3（次にできることを一つ示す）: 次にできることへの道を一つだけ出し、どこから進めてもよいと添える', async () => {
    installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'options', episodeId: null } })
    renderAt('/abilities')

    const region = await screen.findByRole('region', { name: copy.home.next.title })
    expect(within(region).getByRole('link', { name: copy.home.next.options })).toHaveAttribute('href', '/options')
    expect(within(region).getAllByRole('link')).toHaveLength(1)
    expect(within(region).getByText(copy.home.next.anywhere)).toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: talk はホームへ、continue はその場面へ行く', async () => {
    installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'talk', episodeId: null } })
    const { unmount } = renderAt('/abilities')
    expect(await screen.findByRole('link', { name: copy.home.next.talk })).toHaveAttribute('href', '/home')
    unmount()
    vi.unstubAllGlobals()

    installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'continue', episodeId: 'episode-3' } })
    renderAt('/abilities')
    expect(await screen.findByRole('link', { name: copy.home.next.continue })).toHaveAttribute('href', '/talk/episode-3')
  })

  it('common-3（次にできることを一つ示す）: いまいる画面と同じ行き先なら出さない', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'conditions', episodeId: null } })
    renderAt('/profile')

    await waitFor(() => expect(nextStepCalls(api)).toHaveLength(1))
    expect(screen.queryByRole('region', { name: copy.home.next.title })).not.toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: 読めなかったら何も出さない', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, nextStep: { status: 500, body: { status: 500 } } })
    renderAt('/abilities')

    await waitFor(() => expect(nextStepCalls(api)).toHaveLength(1))
    expect(screen.queryByRole('region', { name: copy.home.next.title })).not.toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: refreshKey が変わったら読み直す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'abilities', episodeId: null } })
    function Host() {
      const [key, setKey] = useState(0)
      return (
        <>
          <button onClick={() => setKey((k) => k + 1)}>変える</button>
          <NextStepLink refreshKey={key} />
        </>
      )
    }
    renderAt('/abilities', <Host />)
    await waitFor(() => expect(nextStepCalls(api)).toHaveLength(1))
    expect(screen.queryByRole('region', { name: copy.home.next.title })).not.toBeInTheDocument()

    api.state.nextStep = { step: 'options', episodeId: null }
    await userEvent.click(screen.getByRole('button', { name: '変える' }))

    expect(await screen.findByRole('link', { name: copy.home.next.options })).toHaveAttribute('href', '/options')
    expect(nextStepCalls(api)).toHaveLength(2)
  })
})
