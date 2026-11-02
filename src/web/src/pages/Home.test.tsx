import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { FAKE_OPENING, fakeEpisode, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Home', () => {
  it('foundation-2（始める前に保存するものを示す）: 了解した人にはホームが出て、設定へ進める', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    expect(await screen.findByText(copy.home.greeting)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.home.settingsLink })).toHaveAttribute('href', '/settings')
  })

  it('discover-1（具体的な一日を一つ聞く）: 「話す」で新しい場面を始め、最初の問いが出る', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    await userEvent.click(await screen.findByRole('button', { name: copy.home.talk }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST' && c.url === '/api/episodes')).toHaveLength(1)
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面があれば「続きから話す」でその場面へ進む', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [
        fakeEpisode({
          id: 'episode-7',
          turns: [
            ...fakeEpisode().turns,
            { role: 'user', text: '昨日は子どもの熱で、朝から予定を組み直した', answerKind: 'free', at: '2026-11-03T01:01:00Z' },
          ],
        }),
      ],
    })
    renderApp('/home')

    const resume = await screen.findByRole('link', { name: copy.home.continue })
    expect(resume).toHaveAttribute('href', '/talk/episode-7')
    expect(screen.queryByRole('button', { name: copy.home.talk })).not.toBeInTheDocument()

    await userEvent.click(resume)
    expect(await screen.findByText('昨日は子どもの熱で、朝から予定を組み直した')).toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: ほかの画面で途中の場面ができていたら、新しく作らずにその場面へ進む', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')
    const talk = await screen.findByRole('button', { name: copy.home.talk })
    // ホームを開いたあとで、別のタブで場面を始めていた
    api.state.episodes.push(fakeEpisode({ id: 'episode-9' }))

    await userEvent.click(talk)

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(api.calls.some((c) => c.url === '/api/episodes/episode-9')).toBe(true)
  })

  it('discover-8（話した出来事が残る）: ホームから、話したことの一覧へ進める', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    expect(await screen.findByRole('link', { name: copy.home.episodesLink })).toHaveAttribute('href', '/episodes')
  })

  it('validate-9（生活での根拠と仕事での発揮を分ける）: ホームから、見えた力の画面へ進める', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    await userEvent.click(await screen.findByRole('link', { name: copy.home.abilities }))

    expect(await screen.findByRole('heading', { name: copy.abilities.title })).toBeInTheDocument()
  })
})
