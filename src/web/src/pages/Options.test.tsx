import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forbiddenWords from '../../../shared/forbidden-words.json'
import { AppRoutes } from '@/App'
import type { Options } from '@/api'
import { copy } from '@/copy'
import { FAKE_SOURCE, fakeOptionCards, fakeOptions, installFakeApi, type FakeCall } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

const LABELS: string[] = [copy.options.kinds.choose.label, copy.options.kinds.combine.label, copy.options.kinds.create.label]

/** region の名前（aria-labelledby の見出し）を、画面の上から順に並べる。 */
function regionNames() {
  return screen
    .getAllByRole('region')
    .map((region) => document.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent ?? '')
}

function card(label: string) {
  return screen.getByRole('region', { name: label })
}

function withCards(overrides: Partial<Options> = {}): Options {
  return fakeOptions({ cards: fakeOptionCards(), ...overrides })
}

function posts(calls: FakeCall[]) {
  return calls.filter((c) => c.method === 'POST' && c.url === '/api/options')
}

/** 文言の木をたどって、文字列をすべて取り出す。 */
function flatten(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(flatten)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(flatten)
  return []
}

/** 待たせた応答を、テストが好きなときに返させる。 */
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

describe('Options', () => {
  it('options-1（3 枚を同じ重さで示す）: 3 枚が同じ部品で決まった順に並び、順番がないと伝える', async () => {
    installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    renderApp('/options')

    await screen.findByRole('region', { name: copy.options.kinds.choose.label })
    expect(regionNames().filter((name) => LABELS.includes(name))).toEqual(LABELS)
    const classes = LABELS.map((label) => card(label).className)
    expect(new Set(classes).size).toBe(1)
    expect(screen.getByText(copy.options.noOrder)).toBeInTheDocument()
    expect(screen.getByText(copy.options.lead)).toBeInTheDocument()
    // 各カードの見出しに種類の短い説明。どのカードにも「この案を選ぶ」
    for (const kind of ['choose', 'combine', 'create'] as const) {
      const region = card(copy.options.kinds[kind].label)
      expect(within(region).getByText(copy.options.kinds[kind].note)).toBeInTheDocument()
      expect(within(region).getByRole('button', { name: copy.options.chooseThis })).toBeInTheDocument()
    }
    // 中身: 選ぶは職種と業務、組み合わせるは役割の名前と業務と職種、創るは題と誰の、どんな困りごとを
    expect(card(LABELS[0])).toHaveTextContent('オンライン秘書')
    expect(card(LABELS[0])).toHaveTextContent('日程の調整')
    expect(card(LABELS[1])).toHaveTextContent('小さな事務所の段取り係')
    expect(card(LABELS[1])).toHaveTextContent('面接の日程の連絡')
    expect(card(LABELS[1])).toHaveTextContent('採用事務')
    expect(card(LABELS[2])).toHaveTextContent('習い事の送り迎えの調整の手伝い')
    expect(card(LABELS[2])).toHaveTextContent('共働きで、子どもの習い事の送り迎えに困っている家族')
    expect(card(LABELS[2])).toHaveTextContent('家族どうしの送り迎えの当番が決まらない')
  })

  it('options-1（3 枚を同じ重さで示す）: 出せないカードも同じ部品で、理由を伝える', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      options: withCards({
        cards: fakeOptionCards({
          combine: null,
          create: null,
          missing: [
            { kind: 'combine', reason: 'noFit' },
            { kind: 'create', reason: 'changed' },
          ],
        }),
      }),
    })
    renderApp('/options')

    await screen.findByRole('region', { name: LABELS[0] })
    expect(regionNames().filter((name) => LABELS.includes(name))).toEqual(LABELS)
    expect(new Set(LABELS.map((label) => card(label).className)).size).toBe(1)

    const combine = card(LABELS[1])
    expect(combine).toHaveTextContent(copy.options.missing.noFit)
    expect(within(combine).getByRole('link', { name: copy.options.toConditions })).toHaveAttribute('href', '/profile')
    expect(within(combine).queryByRole('button', { name: copy.options.chooseThis })).not.toBeInTheDocument()

    // 力の状態か根拠の言葉が変わったカードは、開いたときに作り直すので、ほかの道は置かない
    const create = card(LABELS[2])
    expect(create).toHaveTextContent(copy.options.missing.changed)
    expect(within(create).queryByRole('button', { name: copy.options.chooseThis })).not.toBeInTheDocument()
    expect(within(create).queryByRole('link')).not.toBeInTheDocument()
  })

  it('options-1（3 枚を同じ重さで示す）: 条件に収まる業務はあるが話した力を生かせないカードは、条件を直す道ではなく、話す道を出す', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      options: withCards({ cards: fakeOptionCards({ choose: null, missing: [{ kind: 'choose', reason: 'noAbilityMatch' }] }) }),
    })
    renderApp('/options')

    const choose = await screen.findByRole('region', { name: LABELS[0] })
    expect(choose).toHaveTextContent(copy.options.missing.noAbilityMatch)
    expect(within(choose).getByRole('link', { name: copy.options.toTalk })).toHaveAttribute('href', '/home')
    expect(within(choose).queryByRole('link', { name: copy.options.toConditions })).not.toBeInTheDocument()
  })

  it('options-1（3 枚を同じ重さで示す）: 照らし合わせに通らなかったカードには、同じ記録のまま作り直す道を置かない', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      options: withCards({ cards: fakeOptionCards({ choose: null, missing: [{ kind: 'choose', reason: 'rejected' }] }) }),
    })
    renderApp('/options')

    const choose = await screen.findByRole('region', { name: LABELS[0] })
    expect(choose).toHaveTextContent(copy.options.missing.rejected)
    expect(screen.queryByRole('button', { name: copy.options.retry })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.options.generate })).not.toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(0)
  })

  it('options-4（創るは根拠を引けるときだけ）: 創るには、いつも需要をまだ確かめていないと出し、収入の目安の数字を出さない', async () => {
    installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    renderApp('/options')

    const create = await screen.findByRole('region', { name: LABELS[2] })
    expect(create).toHaveTextContent(copy.options.createNotice)
    expect(create).toHaveTextContent(copy.options.createIncome)
    expect(create).toHaveTextContent('週 3 時間くらい')
    expect(create.textContent).not.toContain('万円')
  })

  it('options-5（条件の範囲だけ）: 時間と収入の目安を、本人の目安と並べて出す', async () => {
    installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    const { unmount } = renderApp('/options')

    const choose = await screen.findByRole('region', { name: LABELS[0] })
    expect(choose).toHaveTextContent('週 3〜10 時間くらい')
    expect(choose).toHaveTextContent('月 1.5〜8 万円くらい')
    expect(choose).toHaveTextContent('あなたの目安: 月 5 万円くらい')
    expect(choose).toHaveTextContent(copy.options.placeValues.home)
    const combine = card(LABELS[1])
    expect(combine).toHaveTextContent('週 6〜10 時間くらい')
    expect(combine).toHaveTextContent('月 3.1〜7.6 万円くらい')
    expect(combine).toHaveTextContent('あなたの目安: 月 5 万円くらい')
    unmount()
    vi.unstubAllGlobals()

    // 本人の目安が「まだ決めていない」なら、並べない
    installFakeApi({ loggedIn: true, consented: true, options: withCards({ monthlyIncome: null }) })
    renderApp('/options')
    const again = await screen.findByRole('region', { name: LABELS[0] })
    expect(again).toHaveTextContent('月 1.5〜8 万円くらい')
    expect(document.body.textContent).not.toContain('あなたの目安')
  })

  it('options-6（本人が選ぶ、保留する、自分で書く）: カードを選ぶと選んだ案として上に出て、選び直せる', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    renderApp('/options')

    const choose = await screen.findByRole('region', { name: LABELS[0] })
    await userEvent.click(within(choose).getByRole('button', { name: copy.options.chooseThis }))

    const chosen = await screen.findByRole('region', { name: copy.options.chosenTitle })
    expect(chosen).toHaveTextContent('オンライン秘書')
    expect(chosen).toHaveTextContent(LABELS[0])
    expect(regionNames().indexOf(copy.options.chosenTitle)).toBeLessThan(regionNames().indexOf(LABELS[0]))
    expect(api.calls.filter((c) => c.method === 'PUT' && c.url === '/api/options/choice').map((c) => c.body)).toEqual([
      { kind: 'card', card: 'choose', generatedAt: '2026-11-03T06:00:00Z' },
    ])
    // 選んでいるあいだは、保留の道は出さない
    expect(screen.queryByRole('button', { name: copy.options.hold })).not.toBeInTheDocument()

    await userEvent.click(within(chosen).getByRole('button', { name: copy.options.rechoose }))
    await waitFor(() => expect(screen.queryByRole('region', { name: copy.options.chosenTitle })).not.toBeInTheDocument())
    expect(api.calls.filter((c) => c.method === 'DELETE' && c.url === '/api/options/choice')).toHaveLength(1)
    expect(screen.getByRole('button', { name: copy.options.hold })).toBeInTheDocument()

    // 別のカードを選べる
    await userEvent.click(within(card(LABELS[2])).getByRole('button', { name: copy.options.chooseThis }))
    expect(await screen.findByRole('region', { name: copy.options.chosenTitle })).toHaveTextContent('習い事の送り迎えの調整の手伝い')
  })

  it('options-8（理由は本人の言葉とつなぐ）: 選んだ案の力をあとで外していたら、選んだ案は残し、理由と力は出さない', async () => {
    const base = fakeOptionCards()
    installFakeApi({
      loggedIn: true,
      consented: true,
      options: withCards({
        choice: {
          kind: 'card',
          at: '2026-11-03T07:00:00Z',
          card: {
            kind: 'create',
            choose: null,
            combine: null,
            create: { ...base.create!, reason: null, ability: null },
            abilityExcluded: true,
            abilityChanged: false,
          },
          ownJob: null,
        },
      }),
    })
    renderApp('/options')

    const chosen = await screen.findByRole('region', { name: copy.options.chosenTitle })
    expect(chosen).toHaveTextContent('習い事の送り迎えの調整の手伝い')
    expect(chosen).toHaveTextContent(copy.options.chosenExcluded)
    expect(chosen).not.toHaveTextContent(copy.options.chosenChanged)
    expect(chosen).not.toHaveTextContent(copy.options.reasonTitle)
    expect(chosen).not.toHaveTextContent(copy.options.abilityTitle)
    expect(chosen).not.toHaveTextContent(copy.options.createLabels.ability)
    expect(within(chosen).getByRole('button', { name: copy.options.rechoose })).toBeInTheDocument()
  })

  it('options-8（理由は本人の言葉とつなぐ）: 選んだあとで力の状態か根拠の言葉が変わっていたら、選んだ案は残し、理由と力は出さない', async () => {
    const base = fakeOptionCards()
    installFakeApi({
      loggedIn: true,
      consented: true,
      options: withCards({
        choice: {
          kind: 'card',
          at: '2026-11-03T07:00:00Z',
          card: {
            kind: 'choose',
            choose: { ...base.choose!, reason: null, ability: null },
            combine: null,
            create: null,
            abilityExcluded: false,
            abilityChanged: true,
          },
          ownJob: null,
        },
      }),
    })
    renderApp('/options')

    const chosen = await screen.findByRole('region', { name: copy.options.chosenTitle })
    expect(chosen).toHaveTextContent('オンライン秘書')
    expect(chosen).toHaveTextContent('日程の調整')
    expect(chosen).toHaveTextContent(copy.options.chosenChanged)
    expect(chosen).not.toHaveTextContent(copy.options.chosenExcluded)
    expect(chosen).not.toHaveTextContent(copy.options.reasonTitle)
    expect(chosen).not.toHaveTextContent(copy.options.abilityTitle)
    expect(chosen).not.toHaveTextContent('班の 2 家族の都合を聞きました')
    expect(within(chosen).getByRole('button', { name: copy.options.rechoose })).toBeInTheDocument()
  })

  it('options-6（本人が選ぶ、保留する、自分で書く）: 保留できる。自分で考えた仕事を書いて選べ、3 つまで書ける', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    renderApp('/options')

    // 保留する → 保留していることと、やめる道
    await userEvent.click(await screen.findByRole('button', { name: copy.options.hold }))
    expect(await screen.findByText(copy.options.holding)).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: copy.options.stopHold }))
    await waitFor(() => expect(screen.queryByText(copy.options.holding)).not.toBeInTheDocument())

    // 自分で考えた仕事を書く。見える文字のない名前は保存できない
    const own = screen.getByRole('region', { name: copy.options.ownTitle })
    await userEvent.click(within(own).getByRole('button', { name: copy.options.ownAdd }))
    await userEvent.type(within(own).getByRole('textbox', { name: copy.options.ownTitleLabel }), '　 ')
    expect(within(own).getByRole('button', { name: copy.options.save })).toBeDisabled()
    await userEvent.clear(within(own).getByRole('textbox', { name: copy.options.ownTitleLabel }))
    await userEvent.type(within(own).getByRole('textbox', { name: copy.options.ownTitleLabel }), '地域の子ども食堂の手伝い')
    await userEvent.type(within(own).getByRole('textbox', { name: copy.options.ownNoteLabel }), '週末だけ')
    await userEvent.click(within(own).getByRole('button', { name: copy.options.save }))
    expect(await within(own).findByText('地域の子ども食堂の手伝い')).toBeInTheDocument()
    expect(within(own).getByText('週末だけ')).toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'POST' && c.url === '/api/options/own').map((c) => c.body)).toEqual([
      { title: '地域の子ども食堂の手伝い', note: '週末だけ' },
    ])

    // 書いた仕事を選ぶ
    await userEvent.click(
      within(own).getByRole('button', { name: copy.options.chooseOwnLabel.replace('{text}', '地域の子ども食堂の手伝い') }),
    )
    expect(await screen.findByRole('region', { name: copy.options.chosenTitle })).toHaveTextContent('地域の子ども食堂の手伝い')

    // 直せる
    await userEvent.click(within(own).getByRole('button', { name: copy.options.editLabel.replace('{text}', '地域の子ども食堂の手伝い') }))
    const title = within(own).getByRole('textbox', { name: copy.options.ownTitleLabel })
    await userEvent.clear(title)
    await userEvent.type(title, '子ども食堂の手伝い')
    await userEvent.click(within(own).getByRole('button', { name: copy.options.save }))
    expect(await within(own).findByText('子ども食堂の手伝い')).toBeInTheDocument()

    // 3 つまで書ける
    for (const name of ['近所の見守り', '手作りの品の販売']) {
      await userEvent.click(within(own).getByRole('button', { name: copy.options.ownAdd }))
      await userEvent.type(within(own).getByRole('textbox', { name: copy.options.ownTitleLabel }), name)
      await userEvent.click(within(own).getByRole('button', { name: copy.options.save }))
      await within(own).findByText(name)
    }
    expect(within(own).queryByRole('button', { name: copy.options.ownAdd })).not.toBeInTheDocument()
    expect(within(own).getByText(copy.options.ownMax)).toBeInTheDocument()

    // 選んだ案にしていた仕事を消すと、選んだ案も外れる
    await userEvent.click(within(own).getByRole('button', { name: copy.options.removeLabel.replace('{text}', '子ども食堂の手伝い') }))
    await waitFor(() => expect(screen.queryByRole('region', { name: copy.options.chosenTitle })).not.toBeInTheDocument())
    expect(within(own).queryByText('子ども食堂の手伝い')).not.toBeInTheDocument()
    expect(within(own).getByRole('button', { name: copy.options.ownAdd })).toBeInTheDocument()
  })

  it('options-6（本人が選ぶ、保留する、自分で書く）: 作り直されたあとに選ぶと、読み直して、新しい案から選び直すことも保留することもできると伝える', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    renderApp('/options')
    const choose = await screen.findByRole('region', { name: LABELS[0] })

    // 別の画面で作り直されていた
    api.state.options = withCards({
      cards: fakeOptionCards({
        generatedAt: '2026-11-03T08:00:00Z',
        choose: { ...fakeOptionCards().choose!, occupationName: '経理事務', summary: '会社のお金の出入りを記録する仕事' },
      }),
    })
    await userEvent.click(within(choose).getByRole('button', { name: copy.options.chooseThis }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.options.changed)
    expect(await screen.findByText('経理事務')).toBeInTheDocument()
    expect(screen.queryByRole('region', { name: copy.options.chosenTitle })).not.toBeInTheDocument()
    // 選ぶことを求めず、保留の道もそのまま出す
    expect(screen.getByRole('button', { name: copy.options.hold })).toBeInTheDocument()
    expect(api.calls.filter((c) => c.method === 'GET' && c.url === '/api/options')).toHaveLength(2)
  })

  it('options-6（本人が選ぶ、保留する、自分で書く）: 選ぶのに失敗したら、穏やかな言葉を出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    api.state.optionsSaveFails = true
    renderApp('/options')

    await userEvent.click(await screen.findByRole('button', { name: copy.options.hold }))
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.options.saveFailed)
    expect(screen.queryByText(copy.options.holding)).not.toBeInTheDocument()
  })

  it('options-5（条件の範囲だけ）: 元の記録が変わっていたら、開いたときに 1 回だけ作り直し、作り直していることを伝える', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, options: withCards({ cards: fakeOptionCards({ stale: true }) }) })
    const wait = gate()
    api.state.generateGate = wait.promise
    api.state.generate = fakeOptionCards({
      generatedAt: '2026-11-03T09:00:00Z',
      choose: { ...fakeOptionCards().choose!, occupationName: '経理事務' },
    })
    // React の StrictMode で、画面を開く処理が 2 回走っても作り直しは 1 回
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/options']}>
          <AppRoutes />
        </MemoryRouter>
      </StrictMode>,
    )

    expect(await screen.findByText(copy.options.regenerating)).toBeInTheDocument()
    // 作り直すあいだも、いま見せられるカードは出しておく
    expect(card(LABELS[0])).toHaveTextContent('オンライン秘書')

    wait.open()
    expect(await screen.findByText('経理事務')).toBeInTheDocument()
    expect(screen.queryByText(copy.options.regenerating)).not.toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(1)
  })

  it('options-5（条件の範囲だけ）: 作り直しに失敗したら自動ではやり直さず、「もう一度作る」を出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, options: withCards({ cards: fakeOptionCards({ stale: true }) }) })
    api.state.generate = { status: 503, body: { type: '/problems/ai-unavailable', status: 503, kind: 'failure' } }
    renderApp('/options')

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.options.generateFailed)
    expect(card(LABELS[0])).toHaveTextContent('オンライン秘書')
    expect(posts(api.calls)).toHaveLength(1)

    api.state.generate = fakeOptionCards({ choose: { ...fakeOptionCards().choose!, occupationName: '経理事務' } })
    await userEvent.click(screen.getByRole('button', { name: copy.options.retry }))
    expect(await screen.findByText('経理事務')).toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(2)
  })

  it('options-7（1 場面で進める）: 足りないものに合わせて、一つだけ道を出す', async () => {
    const cases = [
      { readiness: 'needsConditions', text: copy.options.needsConditions, link: copy.options.toProfile, href: '/profile' },
      { readiness: 'needsFinishedEpisode', text: copy.options.needsFinishedEpisode, link: copy.options.toTalk, href: '/home' },
      { readiness: 'needsAbility', text: copy.options.needsAbility, link: copy.options.toTalk, href: '/home' },
      // 見えた力をすべて外したときは、話が足りないとは言わず、外した見立てを戻せる見えた力の画面への道を出す
      { readiness: 'onlyExcluded', text: copy.options.onlyExcluded, link: copy.options.toAbilities, href: '/abilities' },
    ] as const
    for (const c of cases) {
      const api = installFakeApi({ loggedIn: true, consented: true, options: fakeOptions({ readiness: c.readiness }) })
      const { unmount } = renderApp('/options')

      expect(await screen.findByText(c.text)).toBeInTheDocument()
      // 画面の頭の名前とホームへ戻る道のほかに、出す道は一つだけ
      const others = screen.getAllByRole('link').filter((l) => l.textContent !== copy.nav.appName && l.textContent !== copy.options.backHome)
      expect(others).toEqual([
        screen.getByRole('link', { name: c.link }),
      ])
      expect(screen.getByRole('link', { name: c.link })).toHaveAttribute('href', c.href)
      expect(screen.queryByRole('button', { name: copy.options.generate })).not.toBeInTheDocument()
      expect(screen.queryByRole('region', { name: LABELS[0] })).not.toBeInTheDocument()
      expect(posts(api.calls)).toHaveLength(0)
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('options-7（1 場面で進める）: 「仕事の選択肢を出す」で、待っている表示を出してから 3 枚を出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    const wait = gate()
    api.state.generateGate = wait.promise
    renderApp('/options')

    await userEvent.click(await screen.findByRole('button', { name: copy.options.generate }))
    expect(await screen.findByText(copy.options.generating)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: copy.options.generate })).toBeDisabled()

    wait.open()
    expect(await screen.findByRole('region', { name: LABELS[0] })).toBeInTheDocument()
    expect(screen.queryByText(copy.options.generating)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.options.generate })).not.toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(1)
  })

  it('options-7（1 場面で進める）: 確かめ中の力は「確かめ中」と示す', async () => {
    const base = fakeOptionCards()
    const checking = {
      key: 'prioritizing' as const,
      name: '優先順位をつける力',
      state: 'needsCheck' as const,
      quotes: [{ text: '先に書類を仕上げました', fromChoice: false, linkedText: null }],
    }
    installFakeApi({
      loggedIn: true,
      consented: true,
      options: withCards({ cards: { ...base, choose: { ...base.choose!, ability: checking } } }),
    })
    renderApp('/options')

    const choose = await screen.findByRole('region', { name: LABELS[0] })
    expect(choose).toHaveTextContent(copy.options.abilityStates.needsCheck)
    expect(choose).not.toHaveTextContent(copy.options.abilityStates.confirmed)
    expect(choose).toHaveTextContent('優先順位をつける力')
    expect(card(LABELS[1])).toHaveTextContent(copy.options.abilityStates.confirmed)
  })

  it('options-8（理由は本人の言葉とつなぐ）: 理由に、使った力と根拠の本人の言葉を「」で添える', async () => {
    installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    renderApp('/options')

    const choose = await screen.findByRole('region', { name: LABELS[0] })
    expect(choose).toHaveTextContent(copy.options.reasonTitle)
    expect(choose).toHaveTextContent('班の家族の都合を聞いて集合を決めた動きは、日程の調整に生かせそうです。')
    expect(choose).toHaveTextContent('調整する力')
    expect(within(choose).getByText('「班の 2 家族の都合を聞きました」')).toBeInTheDocument()
    expect(within(choose).getByText('「私から声をかけた」')).toBeInTheDocument()
    expect(within(choose).getByText(copy.insights.chosen)).toBeInTheDocument()
    expect(within(choose).getByText('「前の晩に、グループのメッセージで声をかけました」')).toBeInTheDocument()
    for (const label of LABELS.slice(1)) {
      expect(within(card(label)).getByText('「班の 2 家族の都合を聞きました」')).toBeInTheDocument()
    }
  })

  it('options-1（3 枚を同じ重さで示す）: 作るのに失敗したら穏やかな言葉を出し、送信回数の上限なら上限の言葉を出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    api.state.generate = { status: 503, body: { type: '/problems/ai-unavailable', status: 503, kind: 'refusal' } }
    const { unmount } = renderApp('/options')

    await userEvent.click(await screen.findByRole('button', { name: copy.options.generate }))
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.options.generateFailed)
    expect(screen.getByRole('button', { name: copy.options.retry })).toBeInTheDocument()
    unmount()
    vi.unstubAllGlobals()

    const limited = installFakeApi({ loggedIn: true, consented: true })
    limited.state.generate = { status: 429, body: { type: '/problems/daily-limit', status: 429, resetAt: '2026-11-03T15:00:00Z' } }
    renderApp('/options')
    await userEvent.click(await screen.findByRole('button', { name: copy.options.generate }))
    expect(await screen.findByText(copy.limit.title)).toBeInTheDocument()
    expect(screen.queryByText(copy.options.generateFailed)).not.toBeInTheDocument()
  })

  it('options-2（選ぶは登録した職種から）: 画面の下に、職種と業務のデータの出典と job tag へのリンクを出す', async () => {
    installFakeApi({ loggedIn: true, consented: true, options: withCards() })
    renderApp('/options')

    const source = await screen.findByRole('region', { name: copy.options.sourceTitle })
    expect(source).toHaveTextContent(copy.options.sourceLead)
    expect(source).toHaveTextContent(FAKE_SOURCE.text)
    expect(within(source).getByRole('link', { name: new RegExp(copy.options.sourceLink) })).toHaveAttribute('href', FAKE_SOURCE.url)
    expect(regionNames().at(-1)).toBe(copy.options.sourceTitle)
  })

  it('common-1（使わない言葉を出さない）: 仕事の選択肢の画面の言葉に使わない言葉、状態の呼び名、点数、順位がない', async () => {
    const texts = flatten(copy.options)
    const found = ['根拠あり', '要確認', '未確認', ...forbiddenWords].flatMap((word) =>
      texts.filter((text) => text.includes(word)).map((text) => `${word}: ${text}`),
    )
    expect(found).toEqual([])

    installFakeApi({
      loggedIn: true,
      consented: true,
      options: withCards({ ownJobs: [{ id: 'own-1', title: '近所の見守り', note: null }] }),
    })
    renderApp('/options')
    await screen.findByRole('region', { name: LABELS[0] })
    // 「優先順位をつける力」は PRD が決めた力の名前なので、この言葉だけ除いて見る
    const page = (document.body.textContent ?? '').replaceAll('優先順位', '')
    for (const word of ['根拠あり', '要確認', '未確認', ...forbiddenWords]) {
      expect(page).not.toContain(word)
    }
    expect(page).not.toMatch(/[0-9０-９]+\s*(点|位)/)
  })
})
