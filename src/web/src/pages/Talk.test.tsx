import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import {
  distressEvents,
  FAKE_AFTER_SKIP,
  FAKE_DISTRESS_ACTIONS,
  FAKE_DISTRESS_TEXT,
  FAKE_OPENING,
  FAKE_OPENING_CHOICES,
  FAKE_SUPPORT_LABEL,
  FAKE_SUPPORT_URL,
  fakeEpisode,
  installFakeApi,
  replyEvents,
} from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

const messages = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))

function setup(episode = fakeEpisode()) {
  const api = installFakeApi({ loggedIn: true, consented: true, episodes: [episode] })
  renderApp(`/talk/${episode.id}`)
  return api
}

async function typeAndSend(text: string) {
  const input = await screen.findByRole('textbox', { name: copy.talk.inputLabel })
  await userEvent.type(input, text)
  await userEvent.click(screen.getByRole('button', { name: copy.talk.send }))
}

describe('Talk', () => {
  it('discover-7（返答が少しずつ流れる）: 返事が少しずつ表示され、待っている表示が消える', async () => {
    const api = setup()
    api.state.manualStream = true

    await typeAndSend('昨日は朝から子どもの支度をした')

    // 送った答えはすぐに出て、返事を待っている表示が出る
    expect(screen.getByText('昨日は朝から子どもの支度をした')).toBeInTheDocument()
    expect(await screen.findByText(copy.talk.waiting)).toBeInTheDocument()
    await waitFor(() => expect(api.streams).toHaveLength(1))

    api.streams[0].send('delta', { text: '朝から大変でしたね。' })
    expect(await screen.findByText('朝から大変でしたね。')).toBeInTheDocument()
    expect(screen.queryByText(copy.talk.waiting)).not.toBeInTheDocument()

    api.streams[0].send('delta', { text: 'まず何をしましたか？' })
    expect(await screen.findByText('朝から大変でしたね。まず何をしましたか？')).toBeInTheDocument()

    api.streams[0].send('choices', { choices: ['着替えを出した', '朝ごはんを作った', '時間割を見た'] })
    api.streams[0].send('done', { userTurnCount: 1, status: 'talking', move: 'askWhatYouDid' })
    api.streams[0].close()

    expect(await screen.findByRole('button', { name: '朝ごはんを作った' })).toBeInTheDocument()
    // 前の問いの選択肢は消えている
    expect(screen.queryByRole('button', { name: FAKE_OPENING_CHOICES[0] })).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('')
  })

  it('discover-3（選んでも書いてもよい）: 選択肢 3 つと「それ以外」と入力欄が出る。選択肢を押すと kind "choice" で送られる', async () => {
    const api = setup()

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    for (const choice of FAKE_OPENING_CHOICES) {
      expect(screen.getByRole('button', { name: choice })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: copy.talk.other })).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: FAKE_OPENING_CHOICES[1] }))

    expect(await screen.findByText('受け止めました。そのとき何をしましたか？')).toBeInTheDocument()
    expect(messages(api).map((c) => c.body)).toEqual([{ text: FAKE_OPENING_CHOICES[1], kind: 'choice' }])
  })

  it('discover-3（選んでも書いてもよい）: 「それ以外」で入力欄にフォーカスし、書いた答えは kind "free" で送られる', async () => {
    const api = setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.other }))
    const input = screen.getByRole('textbox', { name: copy.talk.inputLabel })
    expect(input).toHaveFocus()

    await userEvent.type(input, '公園で子どもと遊んだ')
    await userEvent.click(screen.getByRole('button', { name: copy.talk.send }))

    await screen.findByText('受け止めました。そのとき何をしましたか？')
    expect(messages(api).map((c) => c.body)).toEqual([{ text: '公園で子どもと遊んだ', kind: 'free' }])
  })

  it('discover-5（つらい話は飛ばせる）: 飛ばすは画面の中で一度確かめてから。理由は聞かない。window.confirm を使わない', async () => {
    const api = setup()
    const confirmSpy = vi.spyOn(window, 'confirm')
    const skips = () => api.calls.filter((c) => c.url.endsWith('/skip'))

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.skip }))
    expect(screen.getByText(copy.talk.skipQuestion)).toBeInTheDocument()
    expect(skips()).toHaveLength(0)
    // 理由を書く欄は増えない
    expect(screen.getAllByRole('textbox')).toHaveLength(1)

    // やめると元に戻る
    await userEvent.click(screen.getByRole('button', { name: copy.talk.skipNo }))
    expect(screen.queryByText(copy.talk.skipQuestion)).not.toBeInTheDocument()
    expect(skips()).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: copy.talk.skip }))
    await userEvent.click(screen.getByRole('button', { name: copy.talk.skipYes }))

    expect(await screen.findByText(FAKE_AFTER_SKIP)).toBeInTheDocument()
    expect(screen.queryByText(FAKE_OPENING)).not.toBeInTheDocument()
    expect(skips()).toHaveLength(1)
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('discover-5（つらい話は飛ばせる）: 飛ばしたとき、ほかの画面で別の場面が始まっていたら、その場面を開く', async () => {
    const api = setup()
    const other = fakeEpisode({
      id: 'episode-2',
      startedAt: '2026-11-03T01:30:00Z',
      turns: [{ role: 'assistant', text: 'ほかの画面で始めた場面の問い', choices: FAKE_OPENING_CHOICES, move: 'opening', at: '2026-11-03T01:30:00Z' }],
    })
    api.state.episodes.push(other)
    api.state.skipFindsInProgress = other.id

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.skip }))
    await userEvent.click(screen.getByRole('button', { name: copy.talk.skipYes }))

    expect(await screen.findByText('ほかの画面で始めた場面の問い')).toBeInTheDocument()
    expect(screen.queryByText(FAKE_OPENING)).not.toBeInTheDocument()
    expect(screen.queryByText(copy.errors.generic)).not.toBeInTheDocument()
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: 区切るとホームへ', async () => {
    const api = setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.finish }))

    expect(await screen.findByText(copy.home.greeting)).toBeInTheDocument()
    expect(api.calls.filter((c) => c.url === '/api/episodes/episode-1/finish')).toHaveLength(1)
    expect(api.state.episodes[0].status).toBe('finished')
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: 締めの返事のあとは話し終えた状態になり、入力欄が消える', async () => {
    const api = setup()
    api.state.reply = replyEvents(['たくさん聞かせてくれて', 'ありがとうございました。'], [], 'finished')

    await typeAndSend('最後に片づけをして寝ました')

    expect(await screen.findByText('たくさん聞かせてくれてありがとうございました。')).toBeInTheDocument()
    expect(await screen.findByText(copy.talk.finished)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.talk.backHome })).toHaveAttribute('href', '/home')
  })

  it('discover-8（話した出来事が残る）: 話し終えた場面は読み返せるが、入力欄も選択肢もない', async () => {
    setup(
      fakeEpisode({
        status: 'finished',
        turns: [
          ...fakeEpisode().turns,
          { role: 'user', text: '朝から家事でばたばたした', answerKind: 'choice', at: '2026-11-03T01:01:00Z' },
          { role: 'assistant', text: 'ありがとうございました。', move: 'close', at: '2026-11-03T01:02:00Z' },
        ],
      }),
    )

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(screen.getByText('朝から家事でばたばたした')).toBeInTheDocument()
    expect(screen.getByText('ありがとうございました。')).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.talk.other })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.talk.skip })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.talk.backHome })).toHaveAttribute('href', '/home')
  })

  it('discover-8（話した出来事が残る）: ない場面やほかの人の場面は、見つからないと穏やかに伝える', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/talk/episode-x')

    expect(await screen.findByText(copy.talk.notFound)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.talk.backHome })).toHaveAttribute('href', '/home')
  })

  it('discover-10（つらい状態のサインに応える）: 窓口のリンクと 3 つの行動が出る', async () => {
    const api = setup()
    api.state.reply = distressEvents()

    await typeAndSend('最近ずっと眠れなくて、つらい')

    expect(await screen.findByText(FAKE_DISTRESS_TEXT)).toBeInTheDocument()
    const link = screen.getByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })
    expect(link).toHaveAttribute('href', FAKE_SUPPORT_URL)
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'))
    for (const action of FAKE_DISTRESS_ACTIONS) {
      expect(screen.getByRole('button', { name: action })).toBeInTheDocument()
    }

    // 続けて話す → 入力欄へ
    await userEvent.click(screen.getByRole('button', { name: FAKE_DISTRESS_ACTIONS[0] }))
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveFocus()

    // 残さずに別の話へ → 画面の中で一度確かめる
    await userEvent.click(screen.getByRole('button', { name: FAKE_DISTRESS_ACTIONS[2] }))
    expect(screen.getByText(copy.talk.skipQuestion)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: copy.talk.skipYes }))
    expect(await screen.findByText(FAKE_AFTER_SKIP)).toBeInTheDocument()
  })

  it('discover-10（つらい状態のサインに応える）: 「今日はここで区切る」で区切ってホームへ', async () => {
    const api = setup()
    api.state.reply = distressEvents()

    await typeAndSend('死にたいと思うことがある')
    await userEvent.click(await screen.findByRole('button', { name: FAKE_DISTRESS_ACTIONS[1] }))

    expect(await screen.findByText(copy.home.greeting)).toBeInTheDocument()
    expect(api.state.episodes[0].status).toBe('finished')
  })

  it('discover-10（つらい状態のサインに応える）: 開き直しても、窓口のリンクと 3 つの行動が出る', async () => {
    setup(
      fakeEpisode({
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
    )

    expect(await screen.findByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })).toHaveAttribute('href', FAKE_SUPPORT_URL)
    expect(screen.getByRole('button', { name: FAKE_DISTRESS_ACTIONS[0] })).toBeInTheDocument()
    // サインへの応えには選択肢を付けない
    expect(screen.queryByRole('button', { name: copy.talk.other })).not.toBeInTheDocument()
  })

  it('discover-10（つらい状態のサインに応える）: 読み取りに失敗したときも、窓口を小さく添える', async () => {
    const api = setup()
    api.state.reply = [
      {
        event: 'notice',
        data: { kind: 'support', text: 'つらいときは、こちらの相談先も使えます。', linkUrl: FAKE_SUPPORT_URL, linkLabel: FAKE_SUPPORT_LABEL },
      },
      { event: 'error', data: { kind: 'failure' } },
    ]

    await typeAndSend('昨日のこと')

    expect(await screen.findByText(copy.talk.failure)).toBeInTheDocument()
    expect(screen.getByText('つらいときは、こちらの相談先も使えます。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })).toHaveAttribute('href', FAKE_SUPPORT_URL)
    expect(screen.queryByRole('button', { name: FAKE_DISTRESS_ACTIONS[0] })).not.toBeInTheDocument()
  })

  it('discover-10（つらい状態のサインに応える）: 返事の途中で AI が断ったときも、窓口を小さく添え、途中の返事は消す', async () => {
    const api = setup()
    api.state.reply = [
      { event: 'delta', data: { text: '途中まで' } },
      {
        event: 'notice',
        data: { kind: 'support', text: 'つらいときは、こちらの相談先も使えます。', linkUrl: FAKE_SUPPORT_URL, linkLabel: FAKE_SUPPORT_LABEL },
      },
      { event: 'error', data: { kind: 'refusal' } },
    ]

    await typeAndSend('昨日のこと')

    expect(await screen.findByText(copy.talk.refusal)).toBeInTheDocument()
    expect(screen.getByText('つらいときは、こちらの相談先も使えます。')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })).toHaveAttribute('href', FAKE_SUPPORT_URL)
    expect(screen.queryByText('途中まで')).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('昨日のこと')
  })

  it('discover-7（返答が少しずつ流れる）: 失敗したら穏やかな言葉が出て、書いた答えが入力欄に残る', async () => {
    const api = setup()
    api.state.reply = [
      { event: 'delta', data: { text: '途中まで' } },
      { event: 'error', data: { kind: 'failure' } },
    ]

    await typeAndSend('昨日は買い物に行った')

    expect(await screen.findByText(copy.talk.failure)).toBeInTheDocument()
    const input = screen.getByRole('textbox', { name: copy.talk.inputLabel })
    expect(input).toHaveValue('昨日は買い物に行った')
    // 途中まで流れた返事も、送った答えも、やりとりには残さない（保存されていないため）
    expect(screen.queryByText('途中まで')).not.toBeInTheDocument()
    const log = screen.getByRole('log')
    expect(within(log).queryByText('昨日は買い物に行った')).not.toBeInTheDocument()

    // そのまま送り直せる
    api.state.reply = replyEvents(['受け止めました。', 'それから？'], ['a', 'b', 'c'])
    await userEvent.click(screen.getByRole('button', { name: copy.talk.send }))
    expect(await screen.findByText('受け止めました。それから？')).toBeInTheDocument()
    expect(screen.queryByText(copy.talk.failure)).not.toBeInTheDocument()
    expect(messages(api).map((c) => c.body)).toEqual([
      { text: '昨日は買い物に行った', kind: 'free' },
      { text: '昨日は買い物に行った', kind: 'free' },
    ])
  })

  it('discover-7（返答が少しずつ流れる）: AI が断ったときも、穏やかな言葉が出て、書いた答えが残る', async () => {
    const api = setup()
    api.state.reply = [{ event: 'error', data: { kind: 'refusal' } }]

    await typeAndSend('昨日のこと')

    expect(await screen.findByText(copy.talk.refusal)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('昨日のこと')
  })

  it('foundation-6（使いすぎを穏やかに止める）: 上限で止まったら上限の表示が出る', async () => {
    const api = setup()
    api.state.reply = {
      status: 429,
      body: { type: '/problems/daily-limit', status: 429, resetAt: '2026-11-03T15:00:00Z' },
    }

    await typeAndSend('昨日のこと')

    expect(await screen.findByText(copy.limit.title)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('昨日のこと')
  })
})
