import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { fakeEpisode, fakeInsights, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

const answered = (id: string, startedAt: string, status: 'talking' | 'finished', answer: string) =>
  fakeEpisode({
    id,
    status,
    startedAt,
    turns: [...fakeEpisode().turns, { role: 'user', text: answer, answerKind: 'free', at: startedAt }],
  })

describe('Episodes', () => {
  it('discover-8（話した出来事が残る）: 途中と話し終えた場面が、新しい順に、日付と書き出しつきで並ぶ', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [
        answered('episode-1', '2026-11-01T03:00:00Z', 'finished', '公園で子どもと遊んだ'),
        answered('episode-2', '2026-11-03T03:00:00Z', 'talking', '朝から予定を組み直した'),
      ],
    })
    renderApp('/episodes')

    const items = await screen.findAllByRole('listitem')
    expect(items).toHaveLength(2)
    expect(items[0]).toHaveTextContent('朝から予定を組み直した')
    expect(items[0]).toHaveTextContent(copy.episodes.talking)
    expect(items[0]).toHaveTextContent('11 月 3 日')
    expect(items[1]).toHaveTextContent('公園で子どもと遊んだ')
    expect(items[1]).toHaveTextContent(copy.episodes.finished)
    expect(items[1]).toHaveTextContent('11 月 1 日')
  })

  it('discover-8（話した出来事が残る）: 一覧から開くと読み返せる。話し終えた場面には入力欄がない', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [answered('episode-1', '2026-11-01T03:00:00Z', 'finished', '公園で子どもと遊んだ')],
    })
    renderApp('/episodes')

    await userEvent.click(await screen.findByRole('link', { name: /公園で子どもと遊んだ/ }))

    expect(await screen.findByText(copy.talk.finishedChip)).toBeInTheDocument()
    expect(screen.getByText('公園で子どもと遊んだ')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: 一覧から途中の場面を開くと、続きから話せる', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [answered('episode-2', '2026-11-03T03:00:00Z', 'talking', '朝から予定を組み直した')],
    })
    renderApp('/episodes')

    await userEvent.click(await screen.findByRole('link', { name: /朝から予定を組み直した/ }))

    expect(await screen.findByRole('textbox', { name: copy.talk.inputLabel })).toBeInTheDocument()
  })

  it('discover-8（話した出来事が残る）: まだ答えていない場面と、空の一覧も穏やかに出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, episodes: [fakeEpisode()] })
    const { unmount } = renderApp('/episodes')
    expect(await screen.findByText(copy.episodes.noPreview)).toBeInTheDocument()
    unmount()

    api.state.episodes = []
    renderApp('/episodes')
    expect(await screen.findByText(copy.episodes.empty)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.nav.backToTalk })).toHaveAttribute('href', '/talk')
  })

  it('common-5（どの色でも読める）: マウスを載せても行の地は surface のまま。「続きから話せる」の accent の文字を tint の地に載せず、話している途中の札は tint の地に onTint の文字', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [
        { ...answered('episode-1', '2026-11-01T03:00:00Z', 'finished', '公園で子どもと遊んだ'), insights: fakeInsights({ canResume: true }) },
        answered('episode-2', '2026-11-03T03:00:00Z', 'talking', '朝から予定を組み直した'),
      ],
    })
    renderApp('/episodes')

    const resumable = await screen.findByRole('link', { name: /公園で子どもと遊んだ/ })
    const talking = screen.getByRole('link', { name: /朝から予定を組み直した/ })
    // 行の中には accent の文字（続きから話せる）がある。accent と tint は 4.5 に届かない色がある（00-common.md の「見た目」）
    expect(within(resumable).getByText(copy.episodes.canResume)).toHaveClass('text-primary')
    for (const link of [resumable, talking]) {
      expect(link.className).toContain('bg-surface')
      expect(link.className).not.toMatch(/hover:bg-/)
      expect(link.className).toContain('hover:border-primary')
    }
    // 話している途中の札は、確かめた組（tint の地に onTint の文字）。accent を薄めた地に accent の文字を載せない
    const badge = within(talking).getByText(copy.episodes.talking)
    expect(badge).toHaveClass('bg-tint', 'text-on-tint')
    expect(badge.className).not.toMatch(/bg-primary|text-primary/)
  })

  it('validate-11（要確認の場面に戻れる）: 続きを話せる場面に「もう少し聞かせてほしいことがあります」と添える', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [
        { ...answered('episode-1', '2026-11-01T03:00:00Z', 'finished', '公園で子どもと遊んだ'), insights: fakeInsights({ canResume: true }) },
        { ...answered('episode-2', '2026-11-02T03:00:00Z', 'finished', '朝から予定を組み直した'), insights: fakeInsights({ canResume: false }) },
      ],
    })
    renderApp('/episodes')

    const items = await screen.findAllByRole('listitem')
    expect(items[0]).toHaveTextContent('朝から予定を組み直した')
    expect(items[0]).not.toHaveTextContent(copy.episodes.canResume)
    expect(items[1]).toHaveTextContent('公園で子どもと遊んだ')
    expect(items[1]).toHaveTextContent(copy.episodes.canResume)
  })
})
