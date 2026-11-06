import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forbiddenWords from '../../../shared/forbidden-words.json'
import { copy } from '@/copy'
import {
  distressEvents,
  FAKE_AFTER_SKIP,
  FAKE_DISTRESS_ACTIONS,
  FAKE_DISTRESS_TEXT,
  FAKE_HINT,
  FAKE_OPENING,
  FAKE_OPENING_CHOICES,
  FAKE_RESUME_CHOICES,
  FAKE_RESUME_QUESTION,
  FAKE_SUPPORT_LABEL,
  FAKE_SUPPORT_URL,
  fakeEpisode,
  fakeInsights,
  installFakeApi,
  replyEvents,
} from '@/test/fake-api'
import { readDraft, writeDraft } from '@/lib/drafts'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  localStorage.clear()
})

const messages = (api: ReturnType<typeof installFakeApi>) =>
  api.calls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))

function setup(episode = fakeEpisode()) {
  const api = installFakeApi({ loggedIn: true, consented: true, episodes: [episode] })
  renderApp(`/talk/${episode.id}`)
  return api
}

/** テストが開けるまで、応答を待たせる約束。 */
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
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

  it('discover-6（一場面ずつ区切り、続きから話せる）: 区切るとほかの画面へ移らず、話し終えた状態になる', async () => {
    const api = setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.finish }))

    expect(await screen.findByText(copy.talk.finishedChip)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.url === '/api/episodes/episode-1/finish')).toHaveLength(1)
    expect(api.state.episodes[0].status).toBe('finished')
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）: 締めの返事のあとは話し終えた状態になり、入力欄が消える', async () => {
    const api = setup()
    api.state.reply = replyEvents(['たくさん聞かせてくれて', 'ありがとうございました。'], [], 'finished')

    await typeAndSend('最後に片づけをして寝ました')

    expect(await screen.findByText('たくさん聞かせてくれてありがとうございました。')).toBeInTheDocument()
    expect(await screen.findByText(copy.talk.finishedChip)).toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: copy.menu.label })).toBeInTheDocument()
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
    expect(screen.getByRole('navigation', { name: copy.menu.label })).toBeInTheDocument()
  })

  it('discover-8（話した出来事が残る）: ない場面やほかの人の場面は、見つからないと穏やかに伝える', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/talk/episode-x')

    expect(await screen.findByText(copy.talk.notFound)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.nav.backToTalk })).toHaveAttribute('href', '/talk')
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

  it('discover-10（つらい状態のサインに応える）: 「今日はここで区切る」で区切り、話す画面に留まる。見えたことは出さない', async () => {
    const api = setup()
    api.state.reply = distressEvents()
    // この場面は力の確かめに使わないので、裏側は見えたことを返さない
    api.state.finishInsights = null

    await typeAndSend('死にたいと思うことがある')
    await userEvent.click(await screen.findByRole('button', { name: FAKE_DISTRESS_ACTIONS[1] }))

    expect(await screen.findByText(copy.talk.finishedChip)).toBeInTheDocument()
    expect(api.state.episodes[0].status).toBe('finished')
    expect(screen.queryByText(copy.insights.seenTitle)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.insights.correct })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })).toBeInTheDocument()
  })

  it('discover-10（つらい状態のサインに応える）: 「今日はここで区切る」で区切った画面には、次にできることへの道を出さない（先へ進むことを勧めない）', async () => {
    const api = setup()
    api.state.reply = distressEvents()
    api.state.finishInsights = null
    // 裏側が先へ進む道を返す状態でも、話す画面では出さない
    api.state.nextStep = { step: 'options', episodeId: null }

    await typeAndSend('最近ずっと眠れなくて、つらい')
    await userEvent.click(await screen.findByRole('button', { name: FAKE_DISTRESS_ACTIONS[1] }))

    expect(await screen.findByText(copy.talk.finishedChip)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: copy.home.next.title })).not.toBeInTheDocument()
    expect(screen.queryByText(copy.talk.afterQuestion)).not.toBeInTheDocument()
    expect(screen.queryByText(copy.home.next.options)).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: copy.talk.anotherDay })).toHaveLength(1)
    expect(api.calls.filter((c) => c.url === '/api/next-step')).toHaveLength(0)
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

  it('discover-7（返答が少しずつ流れる）: ほかの画面で閉じられた場面に送ったら、送り直しを促さず、トークに戻る道を出す', async () => {
    const api = setup()
    await screen.findByRole('textbox', { name: copy.talk.inputLabel })
    // 開いたあとに、ほかの画面で飛ばされ、この場面はもうない
    api.state.episodes = []

    await typeAndSend('昨日は公園に行った')

    expect(await screen.findByText(copy.talk.closed)).toBeInTheDocument()
    expect(screen.queryByText(copy.talk.failure)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.nav.backToTalk })).toHaveAttribute('href', '/talk')
  })

  it('discover-7（返答が少しずつ流れる）: 返事を流しているあいだに閉じられたと知らされたら、送り直しを促さない', async () => {
    const api = setup()
    api.state.reply = [{ event: 'error', data: { kind: 'closed' } }]

    await typeAndSend('昨日は公園に行った')

    expect(await screen.findByText(copy.talk.closed)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.nav.backToTalk })).toHaveAttribute('href', '/talk')
  })

  it('discover-10（つらい状態のサインに応える）: 失敗の言葉を先に出し、相談先はそのあとに添える', async () => {
    const api = setup()
    api.state.reply = [
      {
        event: 'notice',
        data: { kind: 'support', text: 'つらいときは、こちらの相談先も使えます。', linkUrl: FAKE_SUPPORT_URL, linkLabel: FAKE_SUPPORT_LABEL },
      },
      { event: 'error', data: { kind: 'failure' } },
    ]

    await typeAndSend('昨日のこと')

    const failure = await screen.findByText(copy.talk.failure)
    const support = screen.getByText('つらいときは、こちらの相談先も使えます。')
    expect(failure.compareDocumentPosition(support) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
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

  // ---- 03 validate（確かめる） ----

  const finishedWithInsights = (insights = fakeInsights()) =>
    fakeEpisode({
      status: 'finished',
      finishedAt: '2026-11-03T01:10:00Z',
      turns: [
        ...fakeEpisode().turns,
        { role: 'user', text: '班の 2 家族の都合を聞きました', answerKind: 'free', at: '2026-11-03T01:01:00Z' },
        { role: 'assistant', text: 'ありがとうございました。', move: 'close', at: '2026-11-03T01:02:00Z' },
      ],
      insights,
    })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 区切るとほかの画面へ移らず、見えた力と根拠、もう少し聞かせてほしいことが出る', async () => {
    setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.finish }))

    const seen = await screen.findByRole('region', { name: copy.insights.seenTitle })
    expect(within(seen).getByText('利害調整力')).toBeInTheDocument()
    expect(within(seen).getByText('「班の 2 家族の都合を聞きました」')).toBeInTheDocument()

    const more = screen.getByRole('region', { name: copy.insights.moreTitle })
    expect(within(more).getByText('優先順位設定力')).toBeInTheDocument()
    expect(within(more).getByText('「先に書類を仕上げました」')).toBeInTheDocument()
    expect(within(more).getByText(copy.insights.hintLead)).toBeInTheDocument()
    expect(within(more).getByText(FAKE_HINT)).toBeInTheDocument()


    expect(screen.getByRole('link', { name: copy.insights.seeAll })).toHaveAttribute('href', '/abilities')
    expect(screen.getByRole('navigation', { name: copy.menu.label })).toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 締めの返事のあとも、見えたことが出る', async () => {
    const api = setup()
    api.state.reply = replyEvents(['たくさん聞かせてくれて', 'ありがとうございました。'], [], 'finished')
    // 締めの返事で話し終えた場面を、裏側が読み直したときの姿
    api.state.episodes[0].insights = fakeInsights()

    await typeAndSend('最後に片づけをして寝ました')

    expect(await screen.findByRole('region', { name: copy.insights.seenTitle })).toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 添える手がかりがない力には、聞き返さずに続きを話せることだけを出す', async () => {
    const more = fakeInsights().moreToHear.map((ability) => ({ ...ability, hints: [] }))
    setup(finishedWithInsights(fakeInsights({ moreToHear: more })))

    const region = await screen.findByRole('region', { name: copy.insights.moreTitle })
    expect(within(region).getByText(copy.insights.noHint)).toBeInTheDocument()
    expect(within(region).queryByText(copy.insights.hintLead)).not.toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 中身のない見出しは出さない', async () => {
    setup(finishedWithInsights(fakeInsights({ seen: [], canResume: true })))

    expect(await screen.findByRole('region', { name: copy.insights.moreTitle })).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: copy.insights.seenTitle })).not.toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 見えた力に、核となる行動の文と本人の言葉を組にして出す', async () => {
    setup(finishedWithInsights())

    const seen = await screen.findByRole('region', { name: copy.insights.seenTitle })
    const item = within(seen).getByText('「班の 2 家族の都合を聞きました」').closest('li')!
    expect(within(item).getByText('関わる 2 者以上の、それぞれ違う都合をつかむ')).toBeInTheDocument()
    const chosen = within(seen).getByText('「私から声をかけた」').closest('li')!
    expect(within(chosen).getByText('自分から働きかける')).toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 行動が 2 つの力も、行動の文と本人の言葉の組で出し、同じ言葉は行動の文を「、」でつないで一度だけ出す', async () => {
    const quote = { text: '妹の話を、最後まで聞きました', fromChoice: false, linkedText: null }
    setup(
      finishedWithInsights(
        fakeInsights({
          seen: [
            {
              key: 'active-listening',
              name: '傾聴力',
              quotes: [
                { ...quote, action: '助言より先に、相手の話を聞く' },
                { ...quote, action: '相手の言いたいことをつかむ' },
              ],
            },
          ],
        }),
      ),
    )

    const seen = await screen.findByRole('region', { name: copy.insights.seenTitle })
    expect(within(seen).getAllByText('「妹の話を、最後まで聞きました」')).toHaveLength(1)
    expect(within(seen).getByText('助言より先に、相手の話を聞く、相手の言いたいことをつかむ')).toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 「まだ聞けていない力」の見出しと名前の一覧を出さず、代わりの一文だけを添える', async () => {
    setup(finishedWithInsights())

    await screen.findByRole('region', { name: copy.insights.seenTitle })
    expect(screen.queryByText('まだ聞けていない力')).not.toBeInTheDocument()
    expect(screen.getByText(copy.insights.moreNote)).toBeInTheDocument()
    expect(screen.queryByText(copy.insights.nothingYetNote)).not.toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 見えた力がないときは、話を重ねると見えてくる力があると伝える', async () => {
    setup(finishedWithInsights(fakeInsights({ seen: [], canResume: true })))

    await screen.findByRole('region', { name: copy.insights.moreTitle })
    expect(screen.getByText(copy.insights.nothingYetNote)).toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: もう少し聞かせてほしいことには行動の文を添えず、本人の言葉と手がかりを出す', async () => {
    const quote = { text: '先に書類を仕上げました', fromChoice: false, linkedText: null, action: '優先する理由を言葉にする' }
    const more = fakeInsights().moreToHear.map((ability) => ({ ...ability, quotes: [quote] }))
    setup(finishedWithInsights(fakeInsights({ moreToHear: more })))

    const region = await screen.findByRole('region', { name: copy.insights.moreTitle })
    expect(within(region).getByText('「先に書類を仕上げました」')).toBeInTheDocument()
    expect(within(region).queryByText('優先する理由を言葉にする')).not.toBeInTheDocument()
    expect(within(region).getByText(FAKE_HINT)).toBeInTheDocument()
  })

  it('validate-6（否定の言葉を使わない）: 見えたことに状態の呼び名、使わない言葉、点数・順位が出ない', async () => {
    setup(finishedWithInsights())

    await screen.findByRole('region', { name: copy.insights.seenTitle })
    // 「優先順位設定力」は PRD が決めた力の名前。使わない言葉の「順位」は人や仕事の順位づけのことなので、この言葉だけ除いて見る
    const text = (document.body.textContent ?? '').replaceAll('優先順位', '')
    for (const word of ['根拠あり', '要確認', '未確認', ...forbiddenWords]) {
      expect(text).not.toContain(word)
    }
    expect(text).not.toMatch(/[0-9０-９]+\s*(点|位)/)
    // 評価や格付けを思わせる星の印も付けない（本人の言葉より判定の結果に見えないように）
    expect(document.querySelector('.lucide-star')).toBeNull()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 見えたことの先頭に、話した言葉からの読み取りであることと、直せることを添える', async () => {
    setup(finishedWithInsights())

    const lead = await screen.findByText(copy.insights.lead)
    expect(lead.compareDocumentPosition(screen.getByRole('region', { name: copy.insights.seenTitle }))).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    )
    expect(screen.getByRole('button', { name: copy.insights.correct })).toBeInTheDocument()
  })

  it('validate-4（根拠は本人の言葉）: 引用は「」で一字一句、選んだ答えには（選んだ答え）と結びついた言葉', async () => {
    setup(finishedWithInsights())

    const seen = await screen.findByRole('region', { name: copy.insights.seenTitle })
    expect(within(seen).getByText('「班の 2 家族の都合を聞きました」')).toBeInTheDocument()
    const chosen = within(seen).getByText('「私から声をかけた」')
    const item = chosen.closest('li')!
    expect(within(item).getByText(copy.insights.chosen)).toBeInTheDocument()
    expect(within(item).getByText('「前の晩に、グループのメッセージで声をかけました」')).toBeInTheDocument()
    // 自分で書いた言葉には（選んだ答え）を付けない
    expect(within(within(seen).getByText('「順番を入れ替える案を出しました」').closest('li')!).queryByText(copy.insights.chosen)).toBeNull()
  })

  it('validate-4（根拠は本人の言葉）: 同じ言葉が複数の行動の根拠になっていても、一度だけ出す', async () => {
    const quote = { text: '書類を先に仕上げました', fromChoice: false, linkedText: null }
    setup(
      finishedWithInsights(
        fakeInsights({ seen: [{ key: 'setting-priorities', name: '優先順位設定力', quotes: [quote, quote, quote] }] }),
      ),
    )

    const seen = await screen.findByRole('region', { name: copy.insights.seenTitle })
    expect(within(seen).getAllByText('「書類を先に仕上げました」')).toHaveLength(1)
  })

  it('validate-8（訂正したら確かめ直す）: 読み取りを直すと入力欄が出て、送ると見えたことが新しくなる。window.confirm を使わない', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm')
    const api = setup(finishedWithInsights())

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.correct }))
    const input = screen.getByRole('textbox', { name: copy.insights.correctLabel })
    expect(input).toHaveAttribute('placeholder', copy.insights.correctPlaceholder)
    await userEvent.type(input, '声をかけたのは私ではなく、夫でした')
    await userEvent.click(screen.getByRole('button', { name: copy.insights.correctSend }))

    // 訂正のあとは、利害調整力が見えた力から外れる
    await waitFor(() => expect(screen.queryByRole('region', { name: copy.insights.seenTitle })).not.toBeInTheDocument())
    expect(screen.getByText('声をかけたのは私ではなく、夫でした')).toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: copy.insights.correctLabel })).not.toBeInTheDocument()
    const sent = api.calls.filter((c) => c.method === 'POST' && c.url === '/api/episodes/episode-1/corrections')
    expect(sent).toEqual([{ method: 'POST', url: '/api/episodes/episode-1/corrections', body: { text: '声をかけたのは私ではなく、夫でした' } }])
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('validate-8（訂正したら確かめ直す）: やりとりの中の訂正は、ふつうの答えと分けて「AI の読み取りを、あなたが直した言葉」として出る', async () => {
    setup(finishedWithInsights())

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.correct }))
    await userEvent.type(screen.getByRole('textbox', { name: copy.insights.correctLabel }), '声をかけたのは私ではなく、夫でした')
    await userEvent.click(screen.getByRole('button', { name: copy.insights.correctSend }))

    const log = await screen.findByRole('log', { name: copy.talk.logLabel })
    await waitFor(() => expect(within(log).getByText(copy.talk.correctionLabel)).toBeInTheDocument())
    const box = within(log).getByText(copy.talk.correctionLabel).parentElement!
    expect(within(box).getByText('声をかけたのは私ではなく、夫でした')).toBeInTheDocument()
    // 見出しだけで、本人が直した言葉だと分かる（読み上げでも、読み返しでも）
    expect(copy.talk.correctionLabel).toContain(copy.talk.you)
    // だれの読み取りを直したかも書く（自分の読み違いを直したと読まれないため）
    expect(copy.talk.correctionLabel).toContain('AI の読み取り')
    // 本人の答えの吹き出し（読み上げに「あなた」を持つもの）には、訂正が入らない
    const asAnswer = within(log)
      .getAllByText(copy.talk.you)
      .map((label) => label.parentElement!)
      .filter((bubble) => bubble.textContent?.includes('声をかけたのは私ではなく、夫でした'))
    expect(asAnswer).toHaveLength(0)
  })

  it('validate-8（訂正したら確かめ直す）: 訂正のある場面を開き直しても、訂正は分けて出る', async () => {
    const base = finishedWithInsights()
    setup({
      ...base,
      turns: [...base.turns, { role: 'user', text: '夫が声をかけました', answerKind: 'correction', at: '2026-11-03T04:00:00Z' }],
    })

    const log = await screen.findByRole('log', { name: copy.talk.logLabel })
    const label = within(log).getByText(copy.talk.correctionLabel)
    expect(within(label.parentElement!).getByText('夫が声をかけました')).toBeInTheDocument()
    expect(within(log).getByText('班の 2 家族の都合を聞きました')).toBeInTheDocument()
    expect(within(log).getAllByText(copy.talk.you)).toHaveLength(1)
  })

  it('validate-8（訂正したら確かめ直す）: 「やめる」で入力欄を閉じ、何も送らない', async () => {
    const api = setup(finishedWithInsights())

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.correct }))
    await userEvent.click(screen.getByRole('button', { name: copy.insights.correctCancel }))

    expect(screen.queryByRole('textbox', { name: copy.insights.correctLabel })).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.url.endsWith('/corrections'))).toHaveLength(0)
  })

  it('validate-8（訂正したら確かめ直す）: 読み直しに失敗したら穏やかな言葉を出し、書いた訂正を残す', async () => {
    const api = setup(finishedWithInsights())
    api.state.correction = { status: 503, body: { type: '/problems/ai-unavailable', status: 503, kind: 'failure' } }

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.correct }))
    await userEvent.type(screen.getByRole('textbox', { name: copy.insights.correctLabel }), '違いました')
    await userEvent.click(screen.getByRole('button', { name: copy.insights.correctSend }))

    // 訂正では返事を作らないので、返事の失敗の言葉ではなく、読み直しの言葉を出す
    expect(await screen.findByText(copy.insights.correctFailed)).toBeInTheDocument()
    expect(screen.queryByText(copy.talk.failure)).not.toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.insights.correctLabel })).toHaveValue('違いました')
    expect(screen.getByRole('region', { name: copy.insights.seenTitle })).toBeInTheDocument()
  })

  it('validate-8（訂正したら確かめ直す）: AI が断ったときは、飛ばす道のない言葉を出す', async () => {
    const api = setup(finishedWithInsights())
    const notice = { kind: 'support', text: '念のための窓口です。', linkUrl: FAKE_SUPPORT_URL, linkLabel: FAKE_SUPPORT_LABEL }
    api.state.correction = { status: 503, body: { type: '/problems/ai-unavailable', status: 503, kind: 'refusal', notice } }

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.correct }))
    await userEvent.type(screen.getByRole('textbox', { name: copy.insights.correctLabel }), '違いました')
    await userEvent.click(screen.getByRole('button', { name: copy.insights.correctSend }))

    expect(await screen.findByText(copy.insights.correctFailed)).toBeInTheDocument()
    // 読み直しの失敗は、つらい状態のサインを見落としているかもしれないので、窓口を添える
    expect(screen.getByText(/念のための窓口です。/)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })).toHaveAttribute('href', FAKE_SUPPORT_URL)
    expect(screen.queryByText(copy.talk.refusal)).not.toBeInTheDocument()
  })

  it('validate-8（訂正したら確かめ直す）: 訂正につらい状態のサインがあれば、決まった言葉と窓口が出る', async () => {
    const api = setup(finishedWithInsights())
    api.state.correctionDistress = true

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.correct }))
    await userEvent.type(screen.getByRole('textbox', { name: copy.insights.correctLabel }), 'もう消えたい')
    await userEvent.click(screen.getByRole('button', { name: copy.insights.correctSend }))

    expect(await screen.findByText(FAKE_DISTRESS_TEXT)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })).toHaveAttribute('href', FAKE_SUPPORT_URL)
    expect(screen.queryByRole('region', { name: copy.insights.seenTitle })).not.toBeInTheDocument()
  })

  it('validate-11（要確認の場面に戻れる）: 続きを話すと入力欄が戻り、続きの問いが出る', async () => {
    const api = setup(finishedWithInsights())

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.resume }))

    expect(await screen.findByText(FAKE_RESUME_QUESTION)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toBeInTheDocument()
    const choices = screen.getByRole('group', { name: copy.talk.choicesLabel })
    for (const choice of FAKE_RESUME_CHOICES) {
      expect(within(choices).getByRole('button', { name: choice })).toBeInTheDocument()
    }
    expect(screen.queryByRole('region', { name: copy.insights.moreTitle })).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST' && c.url === '/api/episodes/episode-1/resume')).toHaveLength(1)
  })

  it('validate-11（要確認の場面に戻れる）: 続きを話せない場面には、続きの道を出さない', async () => {
    setup(finishedWithInsights(fakeInsights({ moreToHear: [], canResume: false })))

    expect(await screen.findByRole('region', { name: copy.insights.seenTitle })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.insights.resume })).not.toBeInTheDocument()
  })

  it('validate-11（要確認の場面に戻れる）: ほかに途中の場面があれば（409）、その場面を開く', async () => {
    const other = fakeEpisode({ id: 'episode-9', turns: [{ role: 'assistant', text: 'ほかの場面の問いです。', move: 'opening', at: '2026-11-03T02:00:00Z' }] })
    const api = installFakeApi({ loggedIn: true, consented: true, episodes: [finishedWithInsights(), other] })
    api.state.resumeFindsInProgress = 'episode-9'
    renderApp('/talk/episode-1')

    await userEvent.click(await screen.findByRole('button', { name: copy.insights.resume }))

    expect(await screen.findByText('ほかの場面の問いです。')).toBeInTheDocument()
  })

  // ---- 区切ったとき（見えた力のカード、次の一手のボタン、今日はここまで） ----

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 区切ると、見えた力がトークの中のカードに出て、核となる行動と本人の言葉が組になっている', async () => {
    setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.finish }))

    // やりとりの最後に「ここで区切りました」の札を出す
    const log = await screen.findByRole('log', { name: copy.talk.logLabel })
    expect(await within(log).findByText(copy.talk.finishedChip)).toBeInTheDocument()

    const card = await screen.findByRole('region', { name: copy.insights.cardLabel })
    expect(card.tagName).toBe('SECTION')
    expect(within(card).getByText(copy.insights.lead)).toBeInTheDocument()
    const seen = within(card).getByRole('region', { name: copy.insights.seenTitle })
    expect(within(seen).getByText('利害調整力')).toBeInTheDocument()
    const item = within(seen).getByText('「班の 2 家族の都合を聞きました」').closest('li')!
    expect(within(item).getByText('関わる 2 者以上の、それぞれ違う都合をつかむ')).toBeInTheDocument()
    const more = within(card).getByRole('region', { name: copy.insights.moreTitle })
    expect(within(more).getByText(FAKE_HINT)).toBeInTheDocument()
    // カードの中から、まとめて見る画面へ行ける。続きを話せる場面なら、続きの道もカードの中
    expect(within(card).getByRole('link', { name: copy.insights.seeAll })).toHaveAttribute('href', '/abilities')
    expect(within(card).getByRole('button', { name: copy.insights.resume })).toBeInTheDocument()
    // チェックの印、点数、割合、「済」の数は出さない
    expect(card.textContent).not.toMatch(/[✓✔☑]|済|[0-9０-９]+\s*(点|%|％)|[0-9]+\s*\/\s*[0-9]+/)
  })

  it('validate-8（訂正したら確かめ直す）: カードの中から、読み取りを直せる', async () => {
    const api = setup(finishedWithInsights())

    const card = await screen.findByRole('region', { name: copy.insights.cardLabel })
    await userEvent.click(within(card).getByRole('button', { name: copy.insights.correct }))
    // 直す欄も、カードの中で開く
    const input = within(card).getByRole('textbox', { name: copy.insights.correctLabel })
    await userEvent.type(input, '声をかけたのは私ではなく、夫でした')
    await userEvent.click(within(card).getByRole('button', { name: copy.insights.correctSend }))

    await waitFor(() => expect(api.calls.filter((c) => c.url.endsWith('/corrections'))).toHaveLength(1))
  })

  it('common-3（次にできることを一つ示す）: 区切ったあと、次にできることのボタンと「別の日のことを話す」「今日はここまで」が出る', async () => {
    const api = setup()
    api.state.nextStep = { step: 'options', episodeId: null }

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.finish }))

    expect(await screen.findByText(copy.talk.afterQuestion)).toBeInTheDocument()
    const next = await screen.findByRole('group', { name: copy.talk.nextLabel })
    expect(within(next).getByRole('link', { name: copy.home.next.options })).toHaveAttribute('href', '/options')
    expect(within(next).getByRole('button', { name: copy.talk.anotherDay })).toBeInTheDocument()
    expect(within(next).getByRole('button', { name: copy.talk.doneForToday })).toBeInTheDocument()
    expect(within(next).getAllByRole('link')).toHaveLength(1)
    expect(within(next).getAllByRole('button')).toHaveLength(2)
    // 話す画面では、ほかの画面の下に出す「次にできること」の囲みを重ねない
    expect(screen.queryByRole('region', { name: copy.home.next.title })).not.toBeInTheDocument()
    expect(screen.getByRole('navigation', { name: copy.menu.label })).toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: 次にできることが talk のときは、「別の日のことを話す」を重ねない', async () => {
    const api = setup()
    api.state.nextStep = { step: 'talk', episodeId: null }

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.finish }))

    const next = await screen.findByRole('group', { name: copy.talk.nextLabel })
    expect(within(next).queryByRole('button', { name: copy.home.next.talk })).not.toBeInTheDocument()
    expect(within(next).queryByRole('link')).not.toBeInTheDocument()
    expect(within(next).getAllByRole('button', { name: copy.talk.anotherDay })).toHaveLength(1)
  })

  it('common-3（次にできることを一つ示す）: 次にできることを読めなかったときは、「別の日のことを話す」と「今日はここまで」だけを出す', async () => {
    const api = setup()
    api.state.nextStep = { status: 500, body: {} }

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.finish }))

    const next = await screen.findByRole('group', { name: copy.talk.nextLabel })
    expect(within(next).queryByRole('link')).not.toBeInTheDocument()
    expect(within(next).getByRole('button', { name: copy.talk.anotherDay })).toBeInTheDocument()
    expect(within(next).getByRole('button', { name: copy.talk.doneForToday })).toBeInTheDocument()
  })

  it('common-3（次にできることを一つ示す）: 「別の日のことを話す」で新しい場面を始め、最初の問いが出る', async () => {
    const api = setup(finishedWithInsights())
    api.state.nextStep = { step: 'options', episodeId: null }

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.anotherDay }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST' && c.url === '/api/episodes')).toHaveLength(1)
  })

  it('discover-12（開くとトークが出る）: 「今日はここまで」で、ボタンを閉じて一言を出し、何も送らない', async () => {
    const api = setup(finishedWithInsights())
    api.state.nextStep = { step: 'options', episodeId: null }

    await userEvent.click(await screen.findByRole('button', { name: copy.talk.doneForToday }))

    expect(await screen.findByText(copy.talk.doneForTodayReply)).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: copy.talk.nextLabel })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.talk.anotherDay })).not.toBeInTheDocument()
    const sent = api.calls.filter((c) => c.method !== 'GET')
    expect(sent).toHaveLength(0)
  })

  it('discover-10（つらい状態のサインに応える）: つらい状態のサインで終わった場面では、次の一手を勧めず、「別の日のことを話す」だけを出す', async () => {
    const api = setup(
      fakeEpisode({
        status: 'finished',
        finishedAt: '2026-11-03T01:10:00Z',
        turns: [
          ...fakeEpisode().turns,
          { role: 'user', text: '最近ずっと眠れなくて、つらい', answerKind: 'free', at: '2026-11-03T01:01:00Z' },
          { role: 'assistant', text: FAKE_DISTRESS_TEXT, move: 'distress', at: '2026-11-03T01:02:00Z' },
        ],
        notice: { kind: 'distress', text: FAKE_DISTRESS_TEXT, linkUrl: FAKE_SUPPORT_URL, linkLabel: FAKE_SUPPORT_LABEL, actions: FAKE_DISTRESS_ACTIONS },
        insights: null,
      }),
    )
    api.state.nextStep = { step: 'options', episodeId: null }

    expect(await screen.findByRole('link', { name: new RegExp(FAKE_SUPPORT_LABEL) })).toBeInTheDocument()
    expect(await screen.findAllByRole('button', { name: copy.talk.anotherDay })).toHaveLength(1)
    expect(screen.queryByText(copy.talk.afterQuestion)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.talk.doneForToday })).not.toBeInTheDocument()
    for (const key of ['conditions', 'options', 'deepen', 'report'] as const) {
      expect(screen.queryByText(copy.home.next[key])).not.toBeInTheDocument()
    }
    expect(api.calls.filter((c) => c.url === '/api/next-step')).toHaveLength(0)
  })

  it('discover-6（一場面ずつ区切り、続きから話せる）、common-4（どの画面からもトークへ戻れ、幅に収まる）: 話している途中でもメニュー板からほかの画面へ行け、トークに戻ると話していた場面の続きが出る', async () => {
    const api = setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.menu.open }))
    await userEvent.click(screen.getByRole('link', { name: copy.menu.episodes }))
    await screen.findByRole('heading', { level: 1, name: copy.episodes.title })
    await userEvent.click(screen.getByRole('link', { name: copy.nav.backToTalk }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(api.state.episodes[0].status).toBe('talking')
    expect(api.calls.filter((c) => c.method === 'POST')).toHaveLength(0)
  })

  it('discover-10（つらい状態のサインに応える）: 相談窓口を出しているあいだは、下の「ここで区切る」「この話は飛ばす」を出さず、窓口の 3 つの続け方で同じことができる（discover-5（つらい話は飛ばせる））', async () => {
    const api = setup()
    api.state.reply = distressEvents()

    await typeAndSend('最近ずっと眠れなくて、つらい')

    expect(await screen.findByText(FAKE_DISTRESS_TEXT)).toBeInTheDocument()
    for (const action of FAKE_DISTRESS_ACTIONS) {
      expect(screen.getByRole('button', { name: action })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: copy.talk.finish })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.talk.skip })).not.toBeInTheDocument()
    // 書く欄とメニュー板は残る（メニュー板は、入力欄から離れて少したってから戻る）
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toBeInTheDocument()
    expect(await screen.findByRole('navigation', { name: copy.menu.label })).toBeInTheDocument()

    // 窓口の「この話は残さずに、別の話にする」で、画面の中の確かめが出る
    await userEvent.click(screen.getByRole('button', { name: FAKE_DISTRESS_ACTIONS[2] }))
    expect(screen.getByText(copy.talk.skipQuestion)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.talk.skipYes })).toBeInTheDocument()

    // 続けて話して次の返事が来たら、いつもの「ここで区切る」「この話は飛ばす」に戻る
    await userEvent.click(screen.getByRole('button', { name: copy.talk.skipNo }))
    api.state.reply = replyEvents(['受け止めました。', 'そのとき何をしましたか？'], ['段取りを考えた', '人に頼んだ', '手を動かした'])
    await typeAndSend('少し落ち着きました')
    expect(await screen.findByRole('button', { name: copy.talk.finish })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.talk.skip })).toBeInTheDocument()
  })

  // ---- 話す画面の形（トーク、選択肢、入力の帯、書きかけ、メニュー板） ----

  it('discover-11（書きかけを残す）: 書いている途中で閉じても、開き直すと入力欄に戻り、残っていることを伝える', async () => {
    installFakeApi({ loggedIn: true, consented: true, episodes: [fakeEpisode()] })
    const first = renderApp('/talk/episode-1')
    const input = await screen.findByRole('textbox', { name: copy.talk.inputLabel })
    expect(screen.queryByText(copy.talk.draftKept)).not.toBeInTheDocument()
    await userEvent.type(input, 'パート先に電話して、')
    expect(screen.getByText(copy.talk.draftKept)).toBeInTheDocument()
    first.unmount()

    renderApp('/talk/episode-1')

    expect(await screen.findByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('パート先に電話して、')
    expect(screen.getByText(copy.talk.draftKept)).toBeInTheDocument()
  })

  it('discover-11（書きかけを残す）: 書きかけは場面ごとに分けて残す', async () => {
    writeDraft('episode-2', '別の場面の書きかけ')
    setup()

    expect(await screen.findByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('')
    expect(screen.queryByText(copy.talk.draftKept)).not.toBeInTheDocument()
  })

  it('discover-11（書きかけを残す）: 送れたら書きかけは消える', async () => {
    setup()

    await typeAndSend('パート先に電話して、休みをもらいました')

    expect(await screen.findByText('受け止めました。そのとき何をしましたか？')).toBeInTheDocument()
    expect(readDraft('episode-1')).toBe('')
    expect(screen.queryByText(copy.talk.draftKept)).not.toBeInTheDocument()
  })

  it('discover-11（書きかけを残す）: 送れなかったら（500）、入力欄にも保存にも残る', async () => {
    const api = setup()
    api.state.reply = { status: 500, body: {} }

    await typeAndSend('パート先に電話して、休みをもらいました')

    expect(await screen.findByText(copy.talk.failure)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('パート先に電話して、休みをもらいました')
    expect(readDraft('episode-1')).toBe('パート先に電話して、休みをもらいました')
  })

  it('discover-11（書きかけを残す）: 返事を待つあいだは入力欄に書き足せず、送れたあとに開き直しても、画面と残した書きかけがそろう', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, episodes: [fakeEpisode()] })
    api.state.manualStream = true
    const first = renderApp('/talk/episode-1')

    await typeAndSend('パート先に電話して、休みをもらいました')
    await waitFor(() => expect(api.streams).toHaveLength(1))

    // 待つあいだに書こうとしても、入力欄は読むだけ（送れたときに、書いた文を知らせずに消さないため）
    const input = screen.getByRole('textbox', { name: copy.talk.inputLabel })
    expect(input).toHaveAttribute('readonly')
    await userEvent.type(input, '次に書くつもりの下書き')
    expect(input).toHaveValue('')

    api.streams[0].send('delta', { text: '受け止めました。' })
    api.streams[0].send('choices', { choices: ['a', 'b', 'c'] })
    api.streams[0].send('done', { userTurnCount: 1, status: 'talking', move: 'askWhatYouDid' })
    api.streams[0].close()
    expect(await screen.findByText('受け止めました。')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).not.toHaveAttribute('readonly'))
    expect(readDraft('episode-1')).toBe('')

    // 返事のあとは、また書ける。書いた文は残り、開き直しても戻る
    await userEvent.type(screen.getByRole('textbox', { name: copy.talk.inputLabel }), '次の答え')
    first.unmount()
    renderApp('/talk/episode-1')
    expect(await screen.findByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('次の答え')
  })

  it('discover-11（書きかけを残す）: 返事を待つあいだに書こうとしても、送れなかったら（500）、送った答えが入力欄にも保存にも残り、開き直しても戻る', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, episodes: [fakeEpisode()] })
    const wait = gate()
    api.state.replyGate = wait.promise
    api.state.reply = { status: 500, body: {} }
    const first = renderApp('/talk/episode-1')

    await typeAndSend('送る答えA')
    expect(await screen.findByText(copy.talk.waiting)).toBeInTheDocument()
    await userEvent.type(screen.getByRole('textbox', { name: copy.talk.inputLabel }), '待つあいだに書いた下書きB')
    wait.open()

    expect(await screen.findByText(copy.talk.failure)).toBeInTheDocument()
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('送る答えA')
    expect(readDraft('episode-1')).toBe('送る答えA')
    first.unmount()

    renderApp('/talk/episode-1')
    expect(await screen.findByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('送る答えA')
  })

  it('discover-11（書きかけを残す）: 区切ったら書きかけは消える', async () => {
    setup()

    await userEvent.type(await screen.findByRole('textbox', { name: copy.talk.inputLabel }), '書きかけ')
    await userEvent.click(screen.getByRole('button', { name: copy.talk.finish }))

    expect(await screen.findByText(copy.talk.finishedChip)).toBeInTheDocument()
    expect(readDraft('episode-1')).toBe('')
  })

  it('discover-11（書きかけを残す）: 飛ばしたら、飛ばした場面の書きかけは消える', async () => {
    setup()

    await userEvent.type(await screen.findByRole('textbox', { name: copy.talk.inputLabel }), '書きかけ')
    await userEvent.click(screen.getByRole('button', { name: copy.talk.skip }))
    await userEvent.click(screen.getByRole('button', { name: copy.talk.skipYes }))

    expect(await screen.findByText(FAKE_AFTER_SKIP)).toBeInTheDocument()
    expect(readDraft('episode-1')).toBe('')
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveValue('')
  })

  it('discover-11（書きかけを残す）: 保存できないブラウザでも、話す画面が出て送れる', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    setup()

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    await typeAndSend('公園で子どもと遊んだ')

    expect(await screen.findByText('受け止めました。そのとき何をしましたか？')).toBeInTheDocument()
  })

  it('discover-3（選んでも書いてもよい）: 選択肢が 5 つ以上なら 2 列の格子に並べ、最後に「それ以外（自分で書く）」を置く', async () => {
    const nine = [
      'うれしかった・楽しかったこと',
      'できた・達成できたこと',
      'ほっとした・安心したこと',
      '困った・大変だったこと',
      '思いどおりにいかなかったこと',
      '迷った・悩んだこと',
      '腹が立った・納得できなかったこと',
      '気づいた・考えさせられたこと',
      '何気ない日常の出来事',
    ]
    setup(fakeEpisode({ turns: [{ role: 'assistant', text: FAKE_OPENING, choices: nine, move: 'opening', at: '2026-11-03T01:00:00Z' }] }))

    const group = await screen.findByRole('group', { name: copy.talk.choicesLabel })
    const buttons = within(group).getAllByRole('button')
    expect(buttons).toHaveLength(10)
    expect(buttons.at(-1)).toHaveTextContent(copy.talk.other)
    expect(copy.talk.other).toBe('それ以外（自分で書く）')
    expect(group.className).toContain('grid-cols-2')

    await userEvent.click(buttons.at(-1)!)
    expect(screen.getByRole('textbox', { name: copy.talk.inputLabel })).toHaveFocus()
  })

  it('discover-3（選んでも書いてもよい）: 選択肢が 4 つ以下なら、格子にせず折り返して並べる', async () => {
    setup()

    const group = await screen.findByRole('group', { name: copy.talk.choicesLabel })
    expect(within(group).getAllByRole('button')).toHaveLength(FAKE_OPENING_CHOICES.length + 1)
    expect(group.className).not.toContain('grid-cols-2')
    expect(group.className).toContain('flex-wrap')
  })

  it('discover-5（つらい話は飛ばせる）: 最初の問いのところでも「ここで区切る」と「この話は飛ばす」を押せる', async () => {
    setup()

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.talk.finish })).toBeEnabled()
    expect(screen.getByRole('button', { name: copy.talk.skip })).toBeEnabled()
  })

  it('discover-8（話した出来事が残る）: 場面の始まりに、始めた日（日本時間）の札を出す', async () => {
    setup()

    const log = await screen.findByRole('log', { name: copy.talk.logLabel })
    expect(within(log).getByText('11月3日（火）')).toBeInTheDocument()
  })

  it('discover-12（開くとトークが出る）: 上の帯に聞き手と「最近の一日の話」を出し、話す画面には「トークに戻る」を重ねない', async () => {
    setup()

    expect(await screen.findByRole('heading', { level: 1, name: copy.talk.title })).toBeInTheDocument()
    expect(screen.getAllByText(copy.talk.listener).length).toBeGreaterThan(0)
    expect(screen.queryByRole('link', { name: copy.nav.backToTalk })).not.toBeInTheDocument()
  })

  it('discover-12（開くとトークが出る）: メニュー板から、話したこと・見えた力・5 つの記録・仕事の選択肢・まとめ・設定へ行ける', async () => {
    setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.menu.open }))

    const nav = screen.getByRole('navigation', { name: copy.menu.label })
    expect(within(nav).getAllByRole('link').map((l) => l.getAttribute('href'))).toEqual([
      '/episodes',
      '/abilities',
      '/profile',
      '/options',
      '/report',
      '/settings',
    ])
  })

  it('discover-12（開くとトークが出る）: 入力欄に文字を打っているあいだは、メニュー板を隠す', async () => {
    setup()

    await userEvent.click(await screen.findByRole('button', { name: copy.menu.open }))
    await userEvent.click(screen.getByRole('textbox', { name: copy.talk.inputLabel }))
    expect(screen.queryByRole('navigation', { name: copy.menu.label })).not.toBeInTheDocument()

    await userEvent.tab()
    expect(await screen.findByRole('navigation', { name: copy.menu.label })).toBeInTheDocument()
  })

  it('discover-12（開くとトークが出る）: 返事を待つあいだは、聞き手の側の吹き出しで待っていることを出す', async () => {
    const api = setup()
    api.state.manualStream = true

    await typeAndSend('昨日は朝から子どもの支度をした')

    const waiting = await screen.findByText(copy.talk.waiting)
    const log = screen.getByRole('log', { name: copy.talk.logLabel })
    expect(log).toContainElement(waiting)
  })

  it('discover-7（返答が少しずつ流れる）: 送れなかったときの言葉は、やりとりの中のカードで出す', async () => {
    const api = setup()
    api.state.reply = [{ event: 'error', data: { kind: 'failure' } }]

    await typeAndSend('昨日のこと')

    const failure = await screen.findByText(copy.talk.failure)
    expect(failure.closest('[data-slot="talk-card"]')).not.toBeNull()
  })
})
