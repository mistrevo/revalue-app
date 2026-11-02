import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOGIN_URL } from '@/api'
import { copy } from '@/copy'
import { installFakeApi } from '@/test/fake-api'
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
    expect(screen.queryByRole('link', { name: copy.landing.continue })).not.toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: 未ログインでログインの要る画面を開くと案内へ戻る', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/home')

    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.title })).toBeInTheDocument()
    expect(screen.queryByText(copy.home.greeting)).not.toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: 未ログインで設定とはじめにを開いても案内へ戻る', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    const { unmount } = renderApp('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.title })).toBeInTheDocument()
    unmount()

    renderApp('/start')
    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.title })).toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: ログイン済みなら「続きから」でホームへ進める', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/')

    const next = await screen.findByRole('link', { name: copy.landing.continue })
    expect(next).toHaveAttribute('href', '/home')
    expect(screen.queryByRole('link', { name: copy.landing.login })).not.toBeInTheDocument()
  })

  it('foundation-2（始める前に保存するものを示す）: ログイン済みで了解していなければ「続きから」ははじめにへ', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/')

    const next = await screen.findByRole('link', { name: copy.landing.continue })
    expect(next).toHaveAttribute('href', '/start')
  })
})
