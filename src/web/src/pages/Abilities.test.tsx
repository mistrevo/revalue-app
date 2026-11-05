import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forbiddenWords from '../../../shared/forbidden-words.json'
import { copy } from '@/copy'
import { FAKE_HINT, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

function setup() {
  const api = installFakeApi({ loggedIn: true, consented: true })
  renderApp('/abilities')
  return api
}

describe('Abilities', () => {
  it('validate-9（生活での根拠と仕事での発揮を分ける）: 生活の中でと仕事でを分けて出し、仕事はまだ確かめていません', async () => {
    setup()

    const balancingInterests = await screen.findByRole('region', { name: '利害調整力' })
    expect(within(balancingInterests).getByText(copy.abilities.life)).toBeInTheDocument()
    expect(within(balancingInterests).getByText(copy.abilities.states.confirmed)).toBeInTheDocument()
    expect(within(balancingInterests).getByText('「班の 2 家族の都合を聞きました」')).toBeInTheDocument()
    expect(within(balancingInterests).getByRole('link', { name: copy.abilities.openEpisode })).toHaveAttribute('href', '/talk/episode-1')
    expect(within(balancingInterests).getByText(copy.abilities.work)).toBeInTheDocument()
    expect(within(balancingInterests).getByText(copy.abilities.workNotChecked)).toBeInTheDocument()

    // 確かめ中の力には、手がかりを出す
    const settingPriorities = screen.getByRole('region', { name: '優先順位設定力' })
    expect(within(settingPriorities).getByText(copy.abilities.states.needsCheck)).toBeInTheDocument()
    expect(within(settingPriorities).getByText(FAKE_HINT)).toBeInTheDocument()

    // API が返さなかった力は、並べない
    expect(screen.queryByRole('region', { name: '変化への気づき' })).not.toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 見えた力の画面は API が返した力だけを出し、ないときは話を重ねると見えてくると伝える', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    api.state.abilities = { abilities: [], history: [] }
    renderApp('/abilities')

    expect(await screen.findByText(copy.abilities.noneYet)).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: '利害調整力' })).not.toBeInTheDocument()
    expect(screen.queryByText('まだ聞けていない力')).not.toBeInTheDocument()
  })

  it('validate-7（見えた力と、もう少し聞きたいことを示す）: 見えた力には行動の文と本人の言葉を組にして出し、確かめ中の力には出さない', async () => {
    setup()

    const balancingInterests = await screen.findByRole('region', { name: '利害調整力' })
    expect(within(balancingInterests).getByText('関わる 2 者以上の、それぞれ違う都合をつかむ')).toBeInTheDocument()
    const settingPriorities = screen.getByRole('region', { name: '優先順位設定力' })
    expect(settingPriorities.querySelector('li .block')).toBeNull()
  })

  it('validate-12（本人が見立てを外せる）: 外す・戻すと表示と履歴が変わる', async () => {
    const api = setup()

    const balancingInterests = await screen.findByRole('region', { name: '利害調整力' })
    await userEvent.click(within(balancingInterests).getByRole('button', { name: copy.abilities.exclude }))

    expect(await within(balancingInterests).findByText(copy.abilities.excludedNote)).toBeInTheDocument()
    const history = screen.getByRole('region', { name: copy.abilities.historyTitle })
    const items = within(history).getAllByRole('listitem')
    // 新しい順
    expect(items[0]).toHaveTextContent(`利害調整力: ${copy.abilities.reasons.exclude}`)
    expect(items[1]).toHaveTextContent(
      `利害調整力: ${copy.abilities.stateWords.needsCheck} → ${copy.abilities.stateWords.confirmed}（${copy.abilities.reasons.talk}）`,
    )
    expect(items[1]).toHaveTextContent('11 月 3 日 12:00')

    await userEvent.click(within(balancingInterests).getByRole('button', { name: copy.abilities.restore }))
    expect(await within(history).findByText(new RegExp(copy.abilities.reasons.restore))).toBeInTheDocument()
    expect(within(balancingInterests).queryByText(copy.abilities.excludedNote)).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      '/api/abilities/balancing-interests/exclude',
      '/api/abilities/balancing-interests/restore',
    ])
  })

  it('discover-10（つらい状態のサインに応える）: 確かめに使わなくなった場面の履歴は、状態の移り変わりを書かず、理由だけを出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    api.state.abilities = {
      ...api.state.abilities,
      history: [
        {
          at: '2026-11-03T04:00:00Z',
          key: 'balancing-interests',
          name: '利害調整力',
          from: 'confirmed',
          to: 'notYet',
          reason: 'setAside',
          episodeId: 'episode-1',
        },
      ],
    }
    renderApp('/abilities')

    const history = await screen.findByRole('region', { name: copy.abilities.historyTitle })
    const item = within(history).getByRole('listitem')
    expect(item).toHaveTextContent(`利害調整力: ${copy.abilities.reasons.setAside}`)
    expect(item).not.toHaveTextContent('→')
    expect(item).not.toHaveTextContent(copy.abilities.stateWords.notYet)
  })

  it('validate-12（本人が見立てを外せる）: 履歴がなければ、まだありませんと出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    api.state.abilities = { ...api.state.abilities, history: [] }
    renderApp('/abilities')

    const history = await screen.findByRole('region', { name: copy.abilities.historyTitle })
    expect(within(history).getByText(copy.abilities.historyEmpty)).toBeInTheDocument()
  })

  it('validate-6（否定の言葉を使わない）: 状態の呼び名（根拠あり、要確認、未確認）、使わない言葉、点数、順位が画面に出ない', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    // 外した力、戻した力、確かめに使わなくなった場面も含め、この画面に出る文言をすべて出してから見る
    api.state.abilities = {
      ...api.state.abilities,
      abilities: api.state.abilities.abilities.map((a) => (a.key === 'balancing-interests' ? { ...a, excluded: true } : a)),
      history: [
        ...api.state.abilities.history,
        { at: '2026-11-03T04:00:00Z', key: 'noticing-changes', name: '変化への気づき', from: 'notYet', to: 'notYet', reason: 'exclude', episodeId: null },
        { at: '2026-11-03T05:00:00Z', key: 'noticing-changes', name: '変化への気づき', from: 'notYet', to: 'notYet', reason: 'restore', episodeId: null },
        { at: '2026-11-03T06:00:00Z', key: 'balancing-interests', name: '利害調整力', from: 'confirmed', to: 'notYet', reason: 'setAside', episodeId: 'episode-1' },
        { at: '2026-11-03T07:00:00Z', key: 'balancing-interests', name: '利害調整力', from: 'needsCheck', to: 'notYet', reason: 'skip', episodeId: 'episode-2' },
        { at: '2026-11-03T08:00:00Z', key: 'balancing-interests', name: '利害調整力', from: 'notYet', to: 'needsCheck', reason: 'correction', episodeId: 'episode-1' },
      ],
    }
    renderApp('/abilities')

    await screen.findByRole('region', { name: '利害調整力' })
    expect(screen.getByText(copy.abilities.excludedNote)).toBeInTheDocument()
    // 「優先順位設定力」は PRD が決めた力の名前。使わない言葉の「順位」は人や仕事の順位づけのことなので、この言葉だけ除いて見る
    const text = (document.body.textContent ?? '').replaceAll('優先順位', '')
    for (const word of ['根拠あり', '要確認', '未確認', ...forbiddenWords]) {
      expect(text).not.toContain(word)
    }
    expect(text).not.toMatch(/[0-9０-９]+\s*(点|位)/)
    expect(text).not.toContain('第 1 位')
  })

  it('validate-6（否定の言葉を使わない）: 代わりの一文は、力がないと読める言い方をしない', async () => {
    setup()

    expect(await screen.findByText(copy.insights.moreNote)).toBeInTheDocument()
    for (const text of [copy.insights.moreNote, copy.insights.nothingYetNote, copy.abilities.noneYet]) {
      expect(text).not.toMatch(/ない|足りな|あと/)
    }
  })

  it('common-3（次にできることを一つ示す）: 見えた力の画面の下に、次にできることへの道が一つ出る', async () => {
    installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'options', episodeId: null } })
    renderApp('/abilities')

    const next = await screen.findByRole('region', { name: copy.home.next.title })
    expect(within(next).getByRole('link', { name: copy.home.next.options })).toHaveAttribute('href', '/options')
  })

  it('common-3（次にできることを一つ示す）: 外す・戻すと、次にできることを読み直す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, nextStep: { step: 'options', episodeId: null } })
    renderApp('/abilities')
    await screen.findByRole('link', { name: copy.home.next.options })

    // 外して、使える力が本人の外した力だけになった。次にできることは、外した見立てに戻すことではなく、別の一日を話すこと
    api.state.nextStep = { step: 'talk', episodeId: null }
    const balancingInterests = screen.getByRole('region', { name: '利害調整力' })
    await userEvent.click(within(balancingInterests).getByRole('button', { name: copy.abilities.exclude }))

    const next = await screen.findByRole('region', { name: copy.home.next.title })
    expect(await within(next).findByRole('button', { name: copy.home.next.talk })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: copy.home.next.options })).not.toBeInTheDocument()
  })
})
