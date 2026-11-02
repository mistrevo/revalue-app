import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forbiddenWords from '../../../shared/forbidden-words.json'
import type { Profile } from '@/api'
import { copy } from '@/copy'
import {
  FAKE_PREFERENCE_CHOICES,
  FAKE_PREFERENCE_QUESTION,
  FAKE_WANT_CHOICES,
  FAKE_WANT_QUESTION,
  fakeProfile,
  installFakeApi,
  type FakeCall,
} from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** どの問いにも答え、条件も入れ終えた記録。 */
function answeredProfile(overrides: Partial<Profile> = {}): Profile {
  return fakeProfile({
    preferences: [
      { text: '自分のペースで進められる', source: 'chosen' },
      { text: '朝のうちに片づけたい', source: 'written' },
    ],
    wants: [{ text: '人の役に立つことをしたい', source: 'chosen' }],
    conditions: { timeSlots: ['morning', 'evening'], hoursPerWeek: 10, place: 'homeOnly', monthlyIncome: null },
    agency: '家族との時間を大事にしたい',
    asked: { preferences: true, wants: true, agency: true },
    ...overrides,
  })
}

function puts(calls: FakeCall[], path: string) {
  return calls.filter((c) => c.method === 'PUT' && c.url === `/api/profile/${path}`)
}

/** region の名前（aria-labelledby の見出し）を、画面の上から順に並べる。 */
function regionNames() {
  return screen
    .getAllByRole('region')
    .map((region) => document.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent ?? '')
}

describe('Profile', () => {
  it('profile-5（好みとやりたいことを一つずつ聞く）: いま聞きたいことには、まだ答えていない問いが一つだけ、好み、やりたいこと、条件、主体性の順で出る', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/profile')

    // 最初は好みの問いだけ。選択肢 3 つと「自分で書く」「いまは決めない」
    let next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    expect(within(next).getByText(FAKE_PREFERENCE_QUESTION)).toBeInTheDocument()
    expect(within(next).getAllByRole('button').map((b) => b.textContent)).toEqual([
      ...FAKE_PREFERENCE_CHOICES,
      copy.profile.writeOwn,
      copy.profile.notNow,
    ])
    expect(screen.queryByText(FAKE_WANT_QUESTION)).not.toBeInTheDocument()

    // 選択肢を選ぶと、選んだ答えとして送り、次にやりたいことの問いが出る
    await userEvent.click(within(next).getByRole('button', { name: FAKE_PREFERENCE_CHOICES[0] }))
    next = screen.getByRole('region', { name: copy.profile.nextTitle })
    expect(await within(next).findByText(FAKE_WANT_QUESTION)).toBeInTheDocument()
    expect(puts(api.calls, 'preferences').map((c) => c.body)).toEqual([
      { entries: [{ text: FAKE_PREFERENCE_CHOICES[0], source: 'chosen' }] },
    ])
    expect(within(next).queryByText(FAKE_PREFERENCE_QUESTION)).not.toBeInTheDocument()

    // 「いまは決めない」で、やりたいことを空のまま済ませ、条件の入力へ進む。条件には「いまは決めない」がない
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.notNow }))
    next = screen.getByRole('region', { name: copy.profile.nextTitle })
    expect(await within(next).findByRole('group', { name: copy.profile.timeSlots })).toBeInTheDocument()
    expect(puts(api.calls, 'wants').map((c) => c.body)).toEqual([{ entries: [] }])
    expect(within(next).queryByRole('button', { name: copy.profile.notNow })).not.toBeInTheDocument()
    // 条件にも、何のために聞くかを一文で添え、収入の目安は比べるためだけに使うと伝える
    expect(within(next).getByText(copy.profile.conditionsQuestion)).toBeInTheDocument()
    expect(within(next).getByRole('group', { name: copy.profile.monthlyIncome })).toHaveTextContent(copy.profile.incomeNote)

    // 条件を保存すると、主体性の欄と「いまは書かない」が出る
    await userEvent.click(within(next).getByRole('checkbox', { name: copy.profile.timeSlotValues.morning }))
    await userEvent.click(within(next).getByRole('radio', { name: '週 10 時間くらいまで' }))
    await userEvent.click(within(next).getByRole('radio', { name: copy.profile.placeValues.homeOnly }))
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))
    next = screen.getByRole('region', { name: copy.profile.nextTitle })
    expect(await within(next).findByRole('textbox', { name: copy.profile.agencyTitle })).toBeInTheDocument()
    expect(within(next).getByRole('button', { name: copy.profile.notNowAgency })).toBeInTheDocument()
    expect(puts(api.calls, 'conditions').map((c) => c.body)).toEqual([
      { timeSlots: ['morning'], hoursPerWeek: 10, place: 'homeOnly', monthlyIncome: null },
    ])

    // 主体性を保存すると、「いま聞きたいこと」は出なくなる
    await userEvent.type(within(next).getByRole('textbox', { name: copy.profile.agencyTitle }), '無理なく続けたい')
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))
    await screen.findByText('無理なく続けたい')
    expect(screen.queryByRole('region', { name: copy.profile.nextTitle })).not.toBeInTheDocument()
    expect(puts(api.calls, 'agency').map((c) => c.body)).toEqual([{ text: '無理なく続けたい' }])

    // あとにしたやりたいことの欄には「まだ決めていません」
    const wants = screen.getByRole('region', { name: copy.profile.wantsTitle })
    expect(within(wants).getByText(copy.profile.notDecided)).toBeInTheDocument()
  })

  it('profile-5（好みとやりたいことを一つずつ聞く）: 「自分で書く」で書いた答えは written で送る', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/profile')

    const next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.writeOwn }))
    await userEvent.type(within(next).getByRole('textbox', { name: copy.profile.writeOwn }), '  朝のうちに片づけたい ')
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))

    expect(await screen.findByText(FAKE_WANT_QUESTION)).toBeInTheDocument()
    expect(puts(api.calls, 'preferences').map((c) => c.body)).toEqual([
      { entries: [{ text: '朝のうちに片づけたい', source: 'written' }] },
    ])
  })

  it('profile-5（好みとやりたいことを一つずつ聞く）: 「自分で書く」は、見える文字を書くまで保存できない', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/profile')

    const next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.writeOwn }))
    const input = within(next).getByRole('textbox', { name: copy.profile.writeOwn })
    // 幅のない空白（U+200B）と全角の空白だけでは、空の項目になるので保存しない
    await userEvent.type(input, '\u200B\u3000\u200B')
    expect(within(next).getByRole('button', { name: copy.profile.save })).toBeDisabled()
    await userEvent.type(input, '{Enter}')
    expect(puts(api.calls, 'preferences')).toEqual([])

    await userEvent.type(input, '朝')
    expect(within(next).getByRole('button', { name: copy.profile.save })).toBeEnabled()
  })

  it('profile-5（好みとやりたいことを一つずつ聞く）: いま聞きたいことに出ている問いは、その記録の欄に入れる入口を出さず、同じ入力欄を 2 つ並べない', async () => {
    // 好みを聞いているあいだは、好みの欄に「足す」を出さない。ほかの欄の入口は出す
    installFakeApi({ loggedIn: true, consented: true })
    const first = renderApp('/profile')
    await screen.findByRole('region', { name: copy.profile.nextTitle })
    expect(screen.getAllByText(FAKE_PREFERENCE_QUESTION)).toHaveLength(1)
    const preferences = screen.getByRole('region', { name: copy.profile.preferencesTitle })
    expect(within(preferences).queryByRole('button', { name: copy.profile.add })).not.toBeInTheDocument()
    const wants = screen.getByRole('region', { name: copy.profile.wantsTitle })
    expect(within(wants).getByRole('button', { name: copy.profile.add })).toBeInTheDocument()
    expect(within(screen.getByRole('region', { name: copy.profile.conditionsTitle })).getByRole('button', { name: copy.profile.enter })).toBeInTheDocument()
    first.unmount()
    vi.unstubAllGlobals()

    // 条件を聞いているあいだは、条件の欄に「入れる」を出さず、条件の入力欄は一つだけ
    installFakeApi({
      loggedIn: true,
      consented: true,
      profile: answeredProfile({ conditions: null, agency: null, asked: { preferences: true, wants: true, agency: false } }),
    })
    renderApp('/profile')
    let next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    expect(within(next).getByRole('group', { name: copy.profile.timeSlots })).toBeInTheDocument()
    const conditions = screen.getByRole('region', { name: copy.profile.conditionsTitle })
    expect(within(conditions).queryByRole('button', { name: copy.profile.enter })).not.toBeInTheDocument()
    expect(screen.getAllByRole('group', { name: copy.profile.timeSlots })).toHaveLength(1)

    // 条件を保存すると、条件の欄は「直す」に変わり、こんどは主体性の欄に「書く」を出さない。主体性の入力欄も一つだけ
    await userEvent.click(within(next).getByRole('checkbox', { name: copy.profile.timeSlotValues.daytime }))
    await userEvent.click(within(next).getByRole('radio', { name: '週 1 時間くらいまで' }))
    await userEvent.click(within(next).getByRole('radio', { name: copy.profile.placeValues.homeOnly }))
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))
    next = screen.getByRole('region', { name: copy.profile.nextTitle })
    expect(await within(next).findByRole('textbox', { name: copy.profile.agencyTitle })).toBeInTheDocument()
    expect(within(conditions).getByRole('button', { name: copy.profile.edit })).toBeInTheDocument()
    const agency = screen.getByRole('region', { name: copy.profile.agencyTitle })
    expect(within(agency).queryByRole('button', { name: copy.profile.write })).not.toBeInTheDocument()
    expect(screen.getAllByRole('textbox', { name: copy.profile.agencyTitle })).toHaveLength(1)

    // 「いまは書かない」で済ませると、主体性の欄から書ける
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.notNowAgency }))
    expect(await within(agency).findByRole('button', { name: copy.profile.write })).toBeInTheDocument()
  })

  it('profile-2（できることは根拠とつなぐ）: できることに、見えた力と確かめ中の力を分けて、根拠の言葉と一緒に出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, profile: answeredProfile() })
    renderApp('/profile')

    const canDo = await screen.findByRole('region', { name: copy.profile.canDoTitle })
    const seen = within(canDo).getByRole('group', { name: copy.profile.seenTitle })
    expect(within(seen).getByRole('heading', { name: '調整する力' })).toBeInTheDocument()
    expect(within(seen).getByText('「班の 2 家族の都合を聞きました」')).toBeInTheDocument()
    expect(within(seen).getByText('「私から声をかけた」')).toBeInTheDocument()
    expect(within(seen).getByText(copy.insights.chosen)).toBeInTheDocument()
    expect(within(seen).getByText('「前の晩に、グループのメッセージで声をかけました」')).toBeInTheDocument()
    expect(within(seen).getByRole('link', { name: copy.profile.openEpisode })).toHaveAttribute('href', '/talk/episode-1')

    const checking = within(canDo).getByRole('group', { name: copy.profile.checkingTitle })
    expect(within(checking).getByRole('heading', { name: '優先順位をつける力' })).toBeInTheDocument()
    expect(within(checking).getByText('「先に書類を仕上げました」')).toBeInTheDocument()
    expect(within(seen).queryByText('優先順位をつける力')).not.toBeInTheDocument()

    // まだ聞けていない力は出さない
    expect(within(canDo).queryByText('見立てる力')).not.toBeInTheDocument()
    expect(within(canDo).getByRole('link', { name: copy.profile.openAbilities })).toHaveAttribute('href', '/abilities')
    expect(within(canDo).queryByText(copy.profile.excludedNote)).not.toBeInTheDocument()
    expect(api.calls.filter((c) => c.method !== 'GET')).toEqual([])
  })

  it('profile-2（できることは根拠とつなぐ）: 外した力しかないときは、まだないとは言わず、外した注記だけを出す', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      profile: answeredProfile({ canDo: { seen: [], checking: [], hasExcluded: true } }),
    })
    renderApp('/profile')

    const canDo = await screen.findByRole('region', { name: copy.profile.canDoTitle })
    expect(within(canDo).getByText(copy.profile.excludedNote)).toBeInTheDocument()
    expect(within(canDo).queryByText(copy.profile.canDoEmpty)).not.toBeInTheDocument()
    expect(within(canDo).queryByRole('group', { name: copy.profile.seenTitle })).not.toBeInTheDocument()
    expect(within(canDo).queryByRole('group', { name: copy.profile.checkingTitle })).not.toBeInTheDocument()
    // 外した力は見えた力の画面で戻せる
    expect(within(canDo).getByRole('link', { name: copy.profile.openAbilities })).toHaveAttribute('href', '/abilities')
  })

  it('profile-2（できることは根拠とつなぐ）: 見えた力も確かめ中の力もなければ、「ない」とは言わず、ここに何が入るかと、話す道を出す', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      profile: answeredProfile({ canDo: { seen: [], checking: [], hasExcluded: false } }),
    })
    renderApp('/profile')

    const canDo = await screen.findByRole('region', { name: copy.profile.canDoTitle })
    expect(within(canDo).getByText(copy.profile.canDoEmpty)).toBeInTheDocument()
    expect(canDo).not.toHaveTextContent('まだありません')
    expect(within(canDo).queryByText(copy.profile.excludedNote)).not.toBeInTheDocument()
    // 次にできることは話すこと。直す力がないので、見えた力の画面で直す道の代わりに、「話す」のあるホームへの道を置く
    expect(within(canDo).getByRole('link', { name: copy.profile.canDoTalk })).toHaveAttribute('href', '/home')
    expect(within(canDo).queryByRole('link', { name: copy.profile.openAbilities })).not.toBeInTheDocument()
  })

  it('profile-4（本人が直せる）: 記録の欄から、好みの項目を消し、やりたいことを足し、条件を書き直せる', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, profile: answeredProfile() })
    renderApp('/profile')

    // 好みの項目を消す
    const preferences = await screen.findByRole('region', { name: copy.profile.preferencesTitle })
    await userEvent.click(
      within(preferences).getByRole('button', { name: copy.profile.removeLabel.replace('{text}', '自分のペースで進められる') }),
    )
    expect(await within(preferences).findAllByRole('listitem')).toHaveLength(1)
    expect(puts(api.calls, 'preferences').map((c) => c.body)).toEqual([
      { entries: [{ text: '朝のうちに片づけたい', source: 'written' }] },
    ])

    // やりたいことを、問いの選択肢から足す。もう入っている選択肢は出さない
    const wants = screen.getByRole('region', { name: copy.profile.wantsTitle })
    await userEvent.click(within(wants).getByRole('button', { name: copy.profile.add }))
    expect(within(wants).getByText(FAKE_WANT_QUESTION)).toBeInTheDocument()
    expect(within(wants).queryByRole('button', { name: '人の役に立つことをしたい' })).not.toBeInTheDocument()
    await userEvent.click(within(wants).getByRole('button', { name: FAKE_WANT_CHOICES[2] }))
    expect(await within(wants).findByText(FAKE_WANT_CHOICES[2])).toBeInTheDocument()
    expect(puts(api.calls, 'wants').map((c) => c.body)).toEqual([
      {
        entries: [
          { text: '人の役に立つことをしたい', source: 'chosen' },
          { text: FAKE_WANT_CHOICES[2], source: 'chosen' },
        ],
      },
    ])
    expect(within(wants).queryByText(FAKE_WANT_QUESTION)).not.toBeInTheDocument()

    // 条件を直す。いまの値が入った状態から始まる
    const conditions = screen.getByRole('region', { name: copy.profile.conditionsTitle })
    expect(within(conditions).getByText(copy.profile.placeValues.homeOnly)).toBeInTheDocument()
    await userEvent.click(within(conditions).getByRole('button', { name: copy.profile.edit }))
    expect(within(conditions).getByRole('checkbox', { name: copy.profile.timeSlotValues.evening })).toBeChecked()
    expect(within(conditions).getByRole('radio', { name: copy.profile.incomeUndecided })).toBeChecked()
    await userEvent.click(within(conditions).getByRole('radio', { name: copy.profile.placeValues.canGoOut }))
    await userEvent.click(within(conditions).getByRole('radio', { name: '月 5 万円くらい' }))
    await userEvent.click(within(conditions).getByRole('button', { name: copy.profile.save }))

    expect(await within(conditions).findByText(copy.profile.placeValues.canGoOut)).toBeInTheDocument()
    expect(within(conditions).getByText('月 5 万円くらい')).toBeInTheDocument()
    expect(puts(api.calls, 'conditions').map((c) => c.body)).toEqual([
      { timeSlots: ['morning', 'evening'], hoursPerWeek: 10, place: 'canGoOut', monthlyIncome: 5 },
    ])
  })

  it('profile-6（主体性は本人が書く）: 主体性の欄は、本人が書いた言葉だけを出し、空なら「まだ書いていません」', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      profile: answeredProfile({ agency: null, asked: { preferences: true, wants: true, agency: false } }),
    })
    renderApp('/profile')

    const agency = await screen.findByRole('region', { name: copy.profile.agencyTitle })
    expect(within(agency).getByText(copy.profile.notWritten)).toBeInTheDocument()

    // 書く欄は空で始まり、例文を入れていない
    const next = screen.getByRole('region', { name: copy.profile.nextTitle })
    const input = within(next).getByRole('textbox', { name: copy.profile.agencyTitle })
    expect(input).toHaveValue('')
    expect(input).toHaveAttribute('placeholder', copy.profile.agencyPlaceholder)
    expect(copy.profile.agencyPlaceholder).not.toMatch(/^例/)

    await userEvent.type(input, '子どもとの時間を削らずに始めたい')
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))

    expect(await within(agency).findByText('子どもとの時間を削らずに始めたい')).toBeInTheDocument()
    expect(within(agency).queryByText(copy.profile.notWritten)).not.toBeInTheDocument()
    expect(puts(api.calls, 'agency').map((c) => c.body)).toEqual([{ text: '子どもとの時間を削らずに始めたい' }])
  })

  it('profile-5（好みとやりたいことを一つずつ聞く）: 答えると、本人の答えを映し返す受け止めの一文を出してから、次の問いを出す', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/profile')

    let next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    expect(within(next).queryByRole('status')).not.toBeInTheDocument()

    await userEvent.click(within(next).getByRole('button', { name: FAKE_PREFERENCE_CHOICES[0] }))
    next = screen.getByRole('region', { name: copy.profile.nextTitle })
    expect(await within(next).findByRole('status')).toHaveTextContent(`「${FAKE_PREFERENCE_CHOICES[0]}」を好みに入れました。`)
    // 受け止めの一文は、次の問いより前に出る
    const status = within(next).getByRole('status')
    const question = within(next).getByText(FAKE_WANT_QUESTION)
    expect(status.compareDocumentPosition(question) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()

    await userEvent.click(within(next).getByRole('button', { name: copy.profile.notNow }))
    next = screen.getByRole('region', { name: copy.profile.nextTitle })
    await vi.waitFor(() =>
      expect(within(next).getByRole('status')).toHaveTextContent('やりたいことは、決めずにおきました。下の欄から、いつでも足せます。'),
    )
  })

  it('profile-6（主体性は本人が書く）: 主体性の入力欄には、見出しのほかに、答えを誘わない問いの一文を添える', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      profile: answeredProfile({ agency: null, asked: { preferences: true, wants: true, agency: false } }),
    })
    renderApp('/profile')

    const next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    const input = within(next).getByRole('textbox', { name: copy.profile.agencyTitle })
    expect(input).toHaveAccessibleDescription(copy.profile.agencyQuestion)
    expect(copy.profile.agencyQuestion).not.toMatch(/例/)

    // 問いがすべて済んだら、「いま聞きたいこと」は出さず、受け止めの一文だけを出す
    await userEvent.type(input, '無理なく続けたい')
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))
    expect(await screen.findByRole('status')).toHaveTextContent(copy.profile.ackAgency)
    expect(screen.queryByRole('region', { name: copy.profile.nextTitle })).not.toBeInTheDocument()
  })

  it('profile-4（本人が直せる）: ほかの欄で保存しても、書きかけの入力は消えない', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/profile')

    // 好みを聞いているあいだに、主体性の欄で書き始める
    const agency = await screen.findByRole('region', { name: copy.profile.agencyTitle })
    await userEvent.click(within(agency).getByRole('button', { name: copy.profile.write }))
    await userEvent.type(within(agency).getByRole('textbox', { name: copy.profile.agencyTitle }), '子どもとの時間を守りたい')

    // 「いま聞きたいこと」で好みを選んで保存しても、主体性の書きかけは残る
    const next = screen.getByRole('region', { name: copy.profile.nextTitle })
    await userEvent.click(within(next).getByRole('button', { name: FAKE_PREFERENCE_CHOICES[0] }))
    expect(await within(next).findByText(FAKE_WANT_QUESTION)).toBeInTheDocument()
    expect(within(agency).getByRole('textbox', { name: copy.profile.agencyTitle })).toHaveValue('子どもとの時間を守りたい')
  })

  it('profile-6（主体性は本人が書く）: 「いまは書かない」を選ぶと、空のまま済ませ、「まだ書いていません」と出す', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      profile: answeredProfile({ agency: null, asked: { preferences: true, wants: true, agency: false } }),
    })
    renderApp('/profile')

    const next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.notNowAgency }))

    await vi.waitFor(() => expect(screen.queryByRole('region', { name: copy.profile.nextTitle })).not.toBeInTheDocument())
    const agency = screen.getByRole('region', { name: copy.profile.agencyTitle })
    expect(within(agency).getByText(copy.profile.notWritten)).toBeInTheDocument()
    expect(puts(api.calls, 'agency').map((c) => c.body)).toEqual([{ text: '' }])
  })

  it('profile-1（5 つを分けて残す）: 5 つの記録を、できること、好み、やりたいこと、条件、主体性の順に、別々の欄で出す', async () => {
    installFakeApi({ loggedIn: true, consented: true, profile: answeredProfile() })
    renderApp('/profile')

    await screen.findByRole('region', { name: copy.profile.canDoTitle })
    expect(regionNames()).toEqual([
      copy.profile.canDoTitle,
      copy.profile.preferencesTitle,
      copy.profile.wantsTitle,
      copy.profile.conditionsTitle,
      copy.profile.agencyTitle,
    ])
    expect(screen.getByText(copy.profile.lead)).toBeInTheDocument()

    // 選んだ答えには「（選んだ答え）」、書いた答えには付けない
    const preferences = screen.getByRole('region', { name: copy.profile.preferencesTitle })
    const items = within(preferences).getAllByRole('listitem')
    expect(items[0]).toHaveTextContent(`自分のペースで進められる${copy.profile.chosen}`)
    expect(items[1]).toHaveTextContent('朝のうちに片づけたい')
    expect(items[1]).not.toHaveTextContent(copy.profile.chosen)

    // ある記録の言葉は、ほかの記録の欄に出ない
    const wants = screen.getByRole('region', { name: copy.profile.wantsTitle })
    expect(within(wants).queryByText(/朝のうちに片づけたい/)).not.toBeInTheDocument()
    const conditions = screen.getByRole('region', { name: copy.profile.conditionsTitle })
    expect(conditions).toHaveTextContent(`${copy.profile.timeSlotValues.morning}、${copy.profile.timeSlotValues.evening}`)
    expect(conditions).toHaveTextContent('週 10 時間くらいまで')
    expect(conditions).toHaveTextContent(copy.profile.incomeUndecided)
    const agency = screen.getByRole('region', { name: copy.profile.agencyTitle })
    expect(within(agency).getByText('家族との時間を大事にしたい')).toBeInTheDocument()
  })

  it('common-1（使わない言葉を出さない）: 5 つの記録の画面に、使わない言葉、状態の呼び名、点数、順位が出ない', async () => {
    for (const profile of [fakeProfile(), answeredProfile()]) {
      installFakeApi({ loggedIn: true, consented: true, profile })
      const { unmount } = renderApp('/profile')
      await screen.findByRole('region', { name: copy.profile.canDoTitle })

      // 「優先順位をつける力」は PRD が決めた力の名前。使わない言葉の「順位」は人や仕事の順位づけのことなので、この言葉だけ除いて見る
      const text = (document.body.textContent ?? '').replaceAll('優先順位', '')
      for (const word of ['根拠あり', '要確認', '未確認', ...forbiddenWords]) {
        expect(text).not.toContain(word)
      }
      expect(text).not.toMatch(/[0-9０-９]+\s*(点|位)/)
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('profile-4（本人が直せる）: 保存に失敗したら、穏やかな言葉を出し、入れた内容を残す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    api.state.profileSaveFails = true
    renderApp('/profile')

    const next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.writeOwn }))
    await userEvent.type(within(next).getByRole('textbox', { name: copy.profile.writeOwn }), '朝のうちに片づけたい')
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))

    expect(await within(next).findByRole('alert')).toHaveTextContent(copy.profile.saveFailed)
    expect(within(next).getByRole('textbox', { name: copy.profile.writeOwn })).toHaveValue('朝のうちに片づけたい')
    expect(within(next).getByText(FAKE_PREFERENCE_QUESTION)).toBeInTheDocument()

    // もう一度保存できる
    api.state.profileSaveFails = false
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.save }))
    expect(await screen.findByText(FAKE_WANT_QUESTION)).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('profile-4（本人が直せる）: 選択肢や「消す」で保存に失敗したら、入れた内容を残したとは言わず、もう一度選ぶよう伝える', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      profile: answeredProfile({ asked: { preferences: false, wants: true, agency: true } }),
    })
    api.state.profileSaveFails = true
    renderApp('/profile')

    // 「いま聞きたいこと」の選択肢
    const next = await screen.findByRole('region', { name: copy.profile.nextTitle })
    await userEvent.click(within(next).getByRole('button', { name: FAKE_PREFERENCE_CHOICES[2] }))
    expect(await within(next).findByRole('alert')).toHaveTextContent(copy.profile.saveFailedRetry)
    expect(within(next).getByRole('alert')).not.toHaveTextContent(copy.profile.saveFailed)

    // 「いまは決めない」
    await userEvent.click(within(next).getByRole('button', { name: copy.profile.notNow }))
    expect(await within(next).findByRole('alert')).toHaveTextContent(copy.profile.saveFailedRetry)

    // 記録の欄の「消す」
    const preferences = screen.getByRole('region', { name: copy.profile.preferencesTitle })
    await userEvent.click(
      within(preferences).getByRole('button', { name: copy.profile.removeLabel.replace('{text}', '朝のうちに片づけたい') }),
    )
    expect(await within(preferences).findByRole('alert')).toHaveTextContent(copy.profile.saveFailedRetry)
    expect(within(preferences).getAllByRole('listitem')).toHaveLength(2)
    expect(screen.getAllByRole('alert')).toHaveLength(1)

    // 書いて保存したときは、入れた内容を残したと伝える
    const wants = screen.getByRole('region', { name: copy.profile.wantsTitle })
    await userEvent.click(within(wants).getByRole('button', { name: copy.profile.add }))
    await userEvent.click(within(wants).getByRole('button', { name: copy.profile.writeOwn }))
    await userEvent.type(within(wants).getByRole('textbox', { name: copy.profile.writeOwn }), '近所の人と話したい')
    await userEvent.click(within(wants).getByRole('button', { name: copy.profile.save }))
    expect(await within(wants).findByRole('alert')).toHaveTextContent(copy.profile.saveFailed)
    expect(within(wants).getByRole('textbox', { name: copy.profile.writeOwn })).toHaveValue('近所の人と話したい')
  })
})
