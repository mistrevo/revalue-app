import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import type { NextStepKind } from '@/api'
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

    await userEvent.click(await screen.findByRole('button', { name: copy.home.next.talk }))

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

    const resume = await screen.findByRole('link', { name: copy.home.next.continue })
    expect(resume).toHaveAttribute('href', '/talk/episode-7')
    expect(screen.queryByRole('button', { name: copy.home.next.talk })).not.toBeInTheDocument()

    await userEvent.click(resume)
    expect(await screen.findByText('昨日は子どもの熱で、朝から予定を組み直した')).toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: ほかの画面で途中の場面ができていたら、新しく作らずにその場面へ進む', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')
    const talk = await screen.findByRole('button', { name: copy.home.next.talk })
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

  it('profile-1（5 つを分けて残す）: ホームから 5 つの記録へ行ける', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    await userEvent.click(await screen.findByRole('link', { name: copy.home.profile }))

    expect(await screen.findByRole('heading', { level: 1, name: copy.profile.title })).toBeInTheDocument()
  })

  it('options-7（1 場面で進める）: ホームから仕事の選択肢へ行ける', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    await userEvent.click(await screen.findByRole('link', { name: copy.home.options }))

    expect(await screen.findByRole('heading', { level: 1, name: copy.options.title })).toBeInTheDocument()
  })

  it('deepen-1（選んだ 1 案だけ深める）: ホームから選んだ案を深める画面へ行ける', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    await userEvent.click(await screen.findByRole('link', { name: copy.home.deepen }))

    expect(await screen.findByRole('heading', { level: 1, name: copy.deepen.title })).toBeInTheDocument()
  })

  it('report-1（一つにまとめて示す）: ホームから可能性レポートへ行ける', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    await userEvent.click(await screen.findByRole('link', { name: copy.home.report }))

    expect(await screen.findByRole('heading', { level: 1, name: copy.report.title })).toBeInTheDocument()
  })

  const linkSteps: { step: Exclude<NextStepKind, 'talk'>; href: string }[] = [
    { step: 'continue', href: '/talk/episode-5' },
    { step: 'conditions', href: '/profile?ask=conditions' },
    { step: 'abilities', href: '/abilities' },
    { step: 'options', href: '/options' },
    { step: 'deepen', href: '/deepen' },
    { step: 'report', href: '/report' },
  ]

  it.each(linkSteps)('common-3（次にできることを一つ示す）: 次にできることが $step なら、その画面への道を一つだけ目立たせて出す', async ({ step, href }) => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      nextStep: { step, episodeId: step === 'continue' ? 'episode-5' : null },
    })
    renderApp('/home')

    const section = await screen.findByRole('region', { name: copy.home.next.title })
    const link = await within(section).findByRole('link', { name: copy.home.next[step] })
    expect(link).toHaveAttribute('href', href)
    expect(within(section).getAllByRole('link')).toHaveLength(1)
    expect(within(section).queryAllByRole('button')).toHaveLength(0)
    expect(within(section).getByText(copy.home.next.anywhere)).toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: 次にできることが talk なら、新しい場面を作るボタンを一つだけ出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'talk', episodeId: null } })
    renderApp('/home')

    const section = await screen.findByRole('region', { name: copy.home.next.title })
    await userEvent.click(within(section).getByRole('button', { name: copy.home.next.talk }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST' && c.url === '/api/episodes')).toHaveLength(1)
  })

  it('common-3（次にできることを一つ示す）: 次にできることを読めなかったら、欄を出さずに、いままでどおり「話す」を出す', async () => {
    installFakeApi({ loggedIn: true, consented: true, nextStep: { status: 500, body: { status: 500 } } })
    renderApp('/home')

    expect(await screen.findByRole('button', { name: copy.home.talk })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: copy.home.next.title })).not.toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: 次にできることを読めなくても、途中の場面があれば「続きから話す」を出す', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [fakeEpisode({ id: 'episode-8' })],
      nextStep: { status: 500, body: { status: 500 } },
    })
    renderApp('/home')

    expect(await screen.findByRole('link', { name: copy.home.continue })).toHaveAttribute('href', '/talk/episode-8')
  })

  it('common-3（次にできることを一つ示す）: 話し終えた場面があれば、初めての人向けのあいさつを出さない', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [fakeEpisode({ status: 'finished', finishedAt: '2026-11-03T01:30:00Z' })],
    })
    renderApp('/home')

    expect(await screen.findByText(copy.home.greetingAgain)).toBeInTheDocument()
    expect(screen.queryByText(copy.home.greeting)).not.toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: 各画面への道は、どの幅でも折り返して収まる並びにする（横一列に並べない）', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    const { container } = renderApp('/home')

    await screen.findByRole('link', { name: copy.home.settingsLink })
    expect(container.innerHTML).not.toContain('sm:flex-row')
  })
})
