import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

    const coordinating = await screen.findByRole('region', { name: '調整する力' })
    expect(within(coordinating).getByText(copy.abilities.life)).toBeInTheDocument()
    expect(within(coordinating).getByText(copy.abilities.states.confirmed)).toBeInTheDocument()
    expect(within(coordinating).getByText('「班の 2 家族の都合を聞きました」')).toBeInTheDocument()
    expect(within(coordinating).getByRole('link', { name: copy.abilities.openEpisode })).toHaveAttribute('href', '/talk/episode-1')
    expect(within(coordinating).getByText(copy.abilities.work)).toBeInTheDocument()
    expect(within(coordinating).getByText(copy.abilities.workNotChecked)).toBeInTheDocument()

    // 確かめ中の力には、手がかりを出す
    const prioritizing = screen.getByRole('region', { name: '優先順位をつける力' })
    expect(within(prioritizing).getByText(copy.abilities.states.needsCheck)).toBeInTheDocument()
    expect(within(prioritizing).getByText(FAKE_HINT)).toBeInTheDocument()

    // まだ聞けていない力は、根拠も場面へのリンクも出さない
    const noticing = screen.getByRole('region', { name: '見立てる力' })
    expect(within(noticing).getByText(copy.abilities.states.notYet)).toBeInTheDocument()
    expect(within(noticing).queryByRole('link', { name: copy.abilities.openEpisode })).not.toBeInTheDocument()
    expect(within(noticing).getByText(copy.abilities.workNotChecked)).toBeInTheDocument()
  })

  it('validate-12（本人が見立てを外せる）: 外す・戻すと表示と履歴が変わる', async () => {
    const api = setup()

    const coordinating = await screen.findByRole('region', { name: '調整する力' })
    await userEvent.click(within(coordinating).getByRole('button', { name: copy.abilities.exclude }))

    expect(await within(coordinating).findByText(copy.abilities.excludedNote)).toBeInTheDocument()
    const history = screen.getByRole('region', { name: copy.abilities.historyTitle })
    const items = within(history).getAllByRole('listitem')
    // 新しい順
    expect(items[0]).toHaveTextContent(`調整する力: ${copy.abilities.reasons.exclude}`)
    expect(items[1]).toHaveTextContent(
      `調整する力: ${copy.abilities.stateWords.needsCheck} → ${copy.abilities.stateWords.confirmed}（${copy.abilities.reasons.talk}）`,
    )
    expect(items[1]).toHaveTextContent('11 月 3 日 12:00')

    await userEvent.click(within(coordinating).getByRole('button', { name: copy.abilities.restore }))
    expect(await within(history).findByText(new RegExp(copy.abilities.reasons.restore))).toBeInTheDocument()
    expect(within(coordinating).queryByText(copy.abilities.excludedNote)).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST').map((c) => c.url)).toEqual([
      '/api/abilities/coordinating/exclude',
      '/api/abilities/coordinating/restore',
    ])
  })

  it('discover-10（つらい状態のサインに応える）: 確かめに使わなくなった場面の履歴は、状態の移り変わりを書かず、理由だけを出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    api.state.abilities = {
      ...api.state.abilities,
      history: [
        {
          at: '2026-11-03T04:00:00Z',
          key: 'coordinating',
          name: '調整する力',
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
    expect(item).toHaveTextContent(`調整する力: ${copy.abilities.reasons.setAside}`)
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

  it('validate-6（否定の言葉を使わない）: 状態の呼び名（根拠あり、要確認、未確認）、点数、順位が画面に出ない', async () => {
    setup()

    await screen.findByRole('region', { name: '調整する力' })
    const text = document.body.textContent ?? ''
    for (const word of ['根拠あり', '要確認', '未確認', '根拠なし', '不得意', 'スコア']) {
      expect(text).not.toContain(word)
    }
    // 「優先順位をつける力」の名前には「位」が入るので、数字と並んだ点数・順位の形で見る
    expect(text).not.toMatch(/[0-9０-９]+\s*(点|位)/)
    expect(text).not.toContain('第 1 位')
  })

  it('validate-6（否定の言葉を使わない）: まだ聞けていない力は、力がないという意味ではないと添える', async () => {
    setup()

    const noticing = await screen.findByRole('region', { name: '見立てる力' })
    expect(within(noticing).getByText(copy.insights.notYetNote)).toBeInTheDocument()
  })
})
