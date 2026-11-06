import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { FAKE_DISTRESS_ACTIONS, FAKE_DISTRESS_TEXT, FAKE_OPENING, FAKE_SUPPORT_LABEL, FAKE_SUPPORT_URL, fakeEpisode, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

const creates = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.filter((c) => c.method === 'POST' && c.url === '/api/episodes')

/** 決まった URL と方法の応答だけを、一度だけ差し替える。ほかは偽物の裏側のまま。 */
function overrideOnce(api: ReturnType<typeof installFakeApi>, method: string, url: string, response: () => Response) {
  const original = api.fetchMock.getMockImplementation()!
  let used = false
  api.fetchMock.mockImplementation(async (input, init) => {
    if (!used && String(input) === url && (init?.method ?? 'GET').toUpperCase() === method) {
      used = true
      api.calls.push({ method, url })
      return response()
    }
    return original(input, init)
  })
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

describe('TalkEntry', () => {
  it('discover-1（具体的な一日を一つ聞く）: 初めて開くと、場面を一つだけ作り、最初の問いが出る', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/talk')

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(creates(api)).toHaveLength(1)
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: 途中の場面があれば、開くとその場面の続きが出る', async () => {
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
    renderApp('/talk')

    expect(await screen.findByText('昨日は子どもの熱で、朝から予定を組み直した')).toBeInTheDocument()
    expect(api.calls.some((c) => c.url === '/api/episodes/episode-7')).toBe(true)
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('discover-12（開くとトークが出る）: 途中の場面がなければ、いちばん新しく話し終えた場面が出る', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [
        fakeEpisode({ id: 'episode-1', status: 'finished', startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T01:00:00Z' }),
        fakeEpisode({
          id: 'episode-2',
          status: 'finished',
          startedAt: '2026-11-02T00:00:00Z',
          finishedAt: '2026-11-02T01:00:00Z',
          turns: [
            ...fakeEpisode().turns,
            { role: 'user', text: '公園で子どもと遊んだ', answerKind: 'free', at: '2026-11-02T00:01:00Z' },
          ],
        }),
      ],
      nextStep: { step: 'options', episodeId: null },
    })
    renderApp('/talk')

    expect(await screen.findByText('公園で子どもと遊んだ')).toBeInTheDocument()
    expect(api.calls.some((c) => c.url === '/api/episodes/episode-2')).toBe(true)
    expect(creates(api)).toHaveLength(0)
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: ほかのタブで途中の場面ができていたら（409）、新しく作らずにその場面へ進む', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, episodes: [fakeEpisode({ id: 'episode-9' })] })
    // 一覧を読んだときにはまだなく、作ろうとしたときには、ほかのタブで始めていた
    overrideOnce(api, 'GET', '/api/episodes', () => json(200, []))
    renderApp('/talk')

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(api.calls.some((c) => c.url === '/api/episodes/episode-9')).toBe(true)
    expect(api.state.episodes).toHaveLength(1)
  })

  it('discover-12（開くとトークが出る）: 場面を作れなかったら、言葉と「もう一度」を出す（白い画面にしない）', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    overrideOnce(api, 'POST', '/api/episodes', () => json(500, { status: 500 }))
    renderApp('/talk')

    expect(await screen.findByText(copy.errors.generic)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: copy.talk.retry }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(creates(api)).toHaveLength(2)
  })

  it('discover-12（開くとトークが出る）: 一覧を読めなかったら、言葉と「もう一度」を出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    overrideOnce(api, 'GET', '/api/episodes', () => json(500, { status: 500 }))
    renderApp('/talk')

    expect(await screen.findByText(copy.errors.generic)).toBeInTheDocument()
    expect(creates(api)).toHaveLength(0)
    await userEvent.click(screen.getByRole('button', { name: copy.talk.retry }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(creates(api)).toHaveLength(1)
  })

  it('discover-10（つらい状態のサインに応える）: つらい状態のサインで終わったあとに開くと、会話を出さず、talk.rest と「別の日のことを話す」だけを出す', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      episodes: [
        fakeEpisode({
          status: 'finished',
          finishedAt: '2026-11-03T01:30:00Z',
          turns: [
            ...fakeEpisode().turns,
            { role: 'user', text: 'つらい', answerKind: 'free', at: '2026-11-03T01:01:00Z' },
            { role: 'assistant', text: FAKE_DISTRESS_TEXT, move: 'distress', at: '2026-11-03T01:02:00Z' },
          ],
          notice: {
            kind: 'distress',
            text: FAKE_DISTRESS_TEXT,
            linkUrl: FAKE_SUPPORT_URL,
            linkLabel: FAKE_SUPPORT_LABEL,
            actions: FAKE_DISTRESS_ACTIONS,
          },
        }),
      ],
      nextStep: { step: 'none', episodeId: null },
    })
    renderApp('/talk')

    expect(await screen.findByText(copy.talk.rest)).toBeInTheDocument()
    expect(screen.queryByText(FAKE_DISTRESS_TEXT)).not.toBeInTheDocument()
    expect(screen.queryByText('つらい')).not.toBeInTheDocument()
    // 先へ進むことを勧めない。出すのは「別の日のことを話す」だけ
    expect(screen.queryByText(copy.home.next.options)).not.toBeInTheDocument()
    expect(api.calls.some((c) => c.url === '/api/episodes/episode-1')).toBe(false)

    await userEvent.click(screen.getByRole('button', { name: copy.talk.anotherDay }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(creates(api)).toHaveLength(1)
  })

  it('discover-12（開くとトークが出る）: /home を開くと /talk へ進む', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(creates(api)).toHaveLength(1)
  })

  it('discover-12（開くとトークが出る）: 了解していない人が /talk を開くと、はじめにへ進む', async () => {
    const api = installFakeApi({ loggedIn: true, consented: false })
    renderApp('/talk')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    expect(creates(api)).toHaveLength(0)
  })

  it('discover-12（開くとトークが出る）: 開いた画面のタイトルは「話す」', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/talk')

    await waitFor(() => expect(document.title).toBe(`${copy.titles.talk} — ${copy.nav.appName}`))
  })
})
