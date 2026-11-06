import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOGIN_URL } from '@/api'
import { copy } from '@/copy'
import { FAKE_OPENING, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Landing', () => {
  it('foundation-1（案内はログインなしで見られる）: 未ログインで案内が出て、ログインは素のリンク', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/')

    expect(screen.getByRole('heading', { level: 1, name: copy.landing.title })).toBeInTheDocument()
    for (const promise of copy.landing.promises) {
      expect(screen.getByRole('heading', { name: promise.title })).toBeInTheDocument()
    }
    const login = await screen.findByRole('link', { name: copy.landing.login })
    expect(login.tagName).toBe('A')
    expect(login).toHaveAttribute('href', LOGIN_URL)
  })

  it('foundation-1（案内はログインなしで見られる）: 未ログインでログインの要る画面を開くと案内へ戻る', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/talk')

    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.title })).toBeInTheDocument()
    expect(screen.queryByText(FAKE_OPENING)).not.toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: 未ログインで設定とはじめにを開いても案内へ戻る', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    const { unmount } = renderApp('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.title })).toBeInTheDocument()
    unmount()

    renderApp('/start')
    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.title })).toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: ログインして了解した人が案内を開くと、トークへ進む', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/')

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: copy.landing.login })).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST' && c.url === '/api/episodes')).toHaveLength(1)
  })

  it('foundation-2（始める前に保存するものを示す）: ログインして了解していない人が案内を開くと、はじめにへ進む', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
  })
})
