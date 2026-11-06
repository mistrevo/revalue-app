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
  it('foundation-1（案内はログインなしで見られる）: 約束 3 つが題と 1 行で出て、先頭は「あなたの言葉が根拠です」「決めるのはあなたです」', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/')

    const titles = await screen.findAllByRole('heading', { level: 2 })
    expect(titles.map((t) => t.textContent)).toEqual(['あなたの言葉が根拠です', '決めるのはあなたです', '安心して話せます'])
    expect(screen.getByText('見えた力には、話した言葉をそのまま添えます')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: copy.landing.tagline })).toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: ログインのボタンは組み込み認証へページごと移動するリンクで、進め方が 1 行で出る', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/')

    const login = await screen.findByRole('link', { name: copy.landing.login })
    expect(login.tagName).toBe('A')
    expect(login).toHaveAttribute('href', LOGIN_URL)
    expect(screen.getByText(copy.landing.flow.join(' → '))).toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: 未ログインでログインの要る画面を開くと案内へ戻る', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/talk')

    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.tagline })).toBeInTheDocument()
    expect(screen.queryByText(FAKE_OPENING)).not.toBeInTheDocument()
  })

  it('foundation-1（案内はログインなしで見られる）: 未ログインで設定とはじめにを開いても案内へ戻る', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    const { unmount } = renderApp('/settings')
    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.tagline })).toBeInTheDocument()
    unmount()

    renderApp('/start')
    expect(await screen.findByRole('heading', { level: 1, name: copy.landing.tagline })).toBeInTheDocument()
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
