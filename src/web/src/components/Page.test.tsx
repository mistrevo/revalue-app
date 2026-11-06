import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { fakeEpisode, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Page', () => {
  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 了解した人の画面では、上の帯から「トークに戻る」で /talk へ行ける', async () => {
    installFakeApi({ loggedIn: true, consented: true, episodes: [fakeEpisode()] })
    renderApp('/abilities')
    const back = await screen.findByRole('link', { name: copy.nav.backToTalk })
    expect(back).toHaveAttribute('href', '/talk')
    expect(screen.queryByRole('link', { name: copy.nav.appName })).not.toBeInTheDocument()
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 案内では、上の帯は「RE:VALUE」で案内へ行く', async () => {
    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/')
    expect(await screen.findByRole('link', { name: copy.nav.appName })).toHaveAttribute('href', '/')
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 案内とはじめにでは、見出しの「RE:VALUE」は案内へ行く', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    await screen.findByRole('heading', { level: 1, name: copy.start.title })
    expect(screen.getByRole('link', { name: copy.nav.appName })).toHaveAttribute('href', '/')
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 画面ごとにページのタイトルが変わる', async () => {
    const episode = fakeEpisode()
    installFakeApi({ loggedIn: true, consented: true, episodes: [episode] })
    renderApp(`/talk/${episode.id}`)

    await waitFor(() => expect(document.title).toBe(`${copy.titles.talk} — ${copy.nav.appName}`))
    expect(copy.titles.talk).toBe('話す')
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 開いたときのトークと案内のページのタイトル', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    const talk = renderApp('/talk')
    await waitFor(() => expect(document.title).toBe(`${copy.titles.talk} — ${copy.nav.appName}`))
    talk.unmount()

    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/')
    await waitFor(() => expect(document.title).toBe(copy.landing.title))
  })
})
