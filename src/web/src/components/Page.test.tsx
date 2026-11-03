import { screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { fakeEpisode, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Page', () => {
  it('common-3（次にできることを一つ示す）: ログインして了解した人の画面では、見出しの「RE:VALUE」がホームへ行く', async () => {
    const episode = fakeEpisode()
    installFakeApi({ loggedIn: true, consented: true, episodes: [episode] })
    renderApp(`/talk/${episode.id}`)

    await screen.findByRole('textbox', { name: copy.talk.inputLabel })
    expect(screen.getByRole('link', { name: copy.nav.appName })).toHaveAttribute('href', '/home')
  })

  it('common-3（次にできることを一つ示す）: 案内とはじめにでは、見出しの「RE:VALUE」は案内へ行く', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    await screen.findByRole('heading', { level: 1, name: copy.start.title })
    expect(screen.getByRole('link', { name: copy.nav.appName })).toHaveAttribute('href', '/')
  })

  it('common-3（次にできることを一つ示す）: 画面ごとにページのタイトルが変わる', async () => {
    const episode = fakeEpisode()
    installFakeApi({ loggedIn: true, consented: true, episodes: [episode] })
    renderApp(`/talk/${episode.id}`)

    await waitFor(() => expect(document.title).toBe(`${copy.titles.talk} — ${copy.nav.appName}`))
    expect(copy.titles.talk).toBe('話す')
  })

  it('common-3（次にできることを一つ示す）: ホームと案内のページのタイトル', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    const home = renderApp('/home')
    await waitFor(() => expect(document.title).toBe(`${copy.titles.home} — ${copy.nav.appName}`))
    home.unmount()

    installFakeApi({ loggedIn: false, consented: false })
    renderApp('/')
    await waitFor(() => expect(document.title).toBe(copy.landing.title))
  })
})
