import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forbiddenWords from '../../../shared/forbidden-words.json'
import { copy } from '@/copy'
import {
  fakeDeepen,
  fakeDeepenContent,
  fakeReport,
  fakeReportContent,
  fakeReportSnapshot,
  installFakeApi,
  type FakeCall,
} from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

/** 言い切りと順位の言葉（裏側の OptionsValidator.AssertiveWords と同じ一覧）。 */
const ASSERTIVE_WORDS = [
  '向いています', '向いている', '向いてる', '向いていそう', '向いてそう', 'ぴったり', '最適', '適任', '最良', 'ベスト',
  'いちばん', '一番', 'おすすめ', 'オススメ', 'お勧め', 'お薦め', 'イチオシ', '一押し', '最も',
]

const SECTION_TITLES = [
  copy.report.sections.abilities,
  copy.report.sections.notYet,
  copy.report.sections.records,
  copy.report.sections.choice,
  copy.report.sections.thinking,
  copy.report.sections.steps,
]

function gets(calls: FakeCall[]) {
  return calls.filter((c) => c.method === 'GET' && c.url === '/api/report')
}

function puts(calls: FakeCall[], url: string) {
  return calls.filter((c) => c.method === 'PUT' && c.url === url).map((c) => c.body)
}

/** region の名前（aria-labelledby の見出し）を、画面の上から順に並べる。 */
function regionNames() {
  return screen
    .getAllByRole('region')
    .map((region) => document.getElementById(region.getAttribute('aria-labelledby') ?? '')?.textContent ?? '')
}

/** 文言の木をたどって、文字列をすべて取り出す。 */
function flatten(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(flatten)
  if (value !== null && typeof value === 'object') return Object.values(value).flatMap(flatten)
  return []
}

describe('Report', () => {
  it('report-5（保留しても開ける）: 話し終えた場面がなければ、ホームへの道だけを出す', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/report')

    const text = await screen.findByText(copy.report.notReady)
    const links = within(text.parentElement!).getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveTextContent(copy.report.toTalk)
    expect(links[0]).toHaveAttribute('href', '/home')
    expect(screen.queryAllByRole('region')).toHaveLength(0)
    expect(screen.queryByRole('link', { name: copy.report.backHome })).not.toBeInTheDocument()
  })

  it('report-1（一つにまとめて示す）: 6 つの欄を決めた順に並べ、根拠の言葉と（選んだ答え）を出し、状態の呼び名を出さない', async () => {
    installFakeApi({ loggedIn: true, consented: true, report: fakeReport() })
    renderApp('/report')

    const abilities = await screen.findByRole('region', { name: copy.report.sections.abilities })
    expect(screen.getByText(copy.report.lead)).toBeInTheDocument()
    expect(regionNames()).toEqual(SECTION_TITLES)
    // 版の番号と日時（日本時間）
    expect(screen.getByText(copy.report.version.replace('{n}', '1').replace('{at}', '11 月 3 日 18:00'))).toBeInTheDocument()
    expect(screen.queryByText(/前の版から変わったところ/)).not.toBeInTheDocument()

    // 確かめた力: 欄の見出しは根拠ありの呼び名にせず、中を「あなたの話から見えた力」と「確かめ中」に分ける（芯 1。5 つの記録の画面と同じ分け方）
    expect(copy.report.sections.abilities).not.toBe(copy.report.seenTitle)
    expect(copy.report.sections.abilities).not.toContain('見えた力')
    const seen = within(abilities).getByRole('group', { name: copy.report.seenTitle })
    const checking = within(abilities).getByRole('group', { name: copy.report.checkingTitle })
    const balancingInterests = within(seen).getByRole('article', { name: '利害調整力' })
    expect(balancingInterests).toHaveTextContent('「班の 2 家族の都合を聞きました」')
    expect(balancingInterests).toHaveTextContent(`「私から声をかけた」${copy.insights.chosen}「前の晩に、グループのメッセージで声をかけました」`)
    expect(within(seen).queryByRole('article', { name: '優先順位設定力' })).not.toBeInTheDocument()
    expect(within(checking).getByRole('article', { name: '優先順位設定力' })).toBeInTheDocument()
    expect(within(checking).queryByRole('article', { name: '利害調整力' })).not.toBeInTheDocument()

    // まだ確かめていないこと
    const notYet = screen.getByRole('region', { name: copy.report.sections.notYet })
    expect(notYet).not.toHaveTextContent('まだ聞けていない力')
    expect(notYet).not.toHaveTextContent('変化への気づき: ')
    expect(notYet).toHaveTextContent(copy.report.checking.replace('{names}', '優先順位設定力'))
    expect(notYet).toHaveTextContent(copy.report.taskAbility.replace('{task}', '出張や会食の手配').replace('{name}', '変化への気づき'))
    expect(notYet).toHaveTextContent(copy.report.taskKnowledge.replace('{task}', '日程の調整').replace('{items}', '表計算'))
    expect(notYet).toHaveTextContent(copy.insights.moreNote)
    expect(notYet).toHaveTextContent(copy.deepen.workNote)
    expect(notYet).not.toHaveTextContent(copy.profile.excludedNote)

    // 5 つの記録
    const records = screen.getByRole('region', { name: copy.report.sections.records })
    // できることは、確かめた力の欄を見出しの名前で指す
    expect(records).toHaveTextContent(copy.report.canDoNote.replace('{title}', copy.report.sections.abilities))
    expect(records).toHaveTextContent(`自分のペースで進められる${copy.profile.chosen}`)
    expect(within(records).getByRole('heading', { name: copy.profile.wantsTitle }).nextElementSibling).toHaveTextContent(
      copy.profile.notDecided,
    )
    expect(records).toHaveTextContent(copy.profile.timeSlotValues.daytime)
    expect(records).toHaveTextContent(copy.profile.hoursValue.replace('{n}', '10'))
    expect(records).toHaveTextContent(copy.profile.placeValues.homeOnly)
    expect(records).toHaveTextContent(copy.profile.incomeValue.replace('{n}', '5'))
    expect(records).toHaveTextContent('家族の予定を先に決めてから動きたい')

    // あなたが選んだ案
    const choice = screen.getByRole('region', { name: copy.report.sections.choice })
    expect(choice).toHaveTextContent(copy.options.kinds.choose.label)
    expect(choice).toHaveTextContent('オンライン秘書')
    expect(choice).toHaveTextContent('連絡や予定の段取りを、オンラインで手伝う仕事')
    expect(choice).toHaveTextContent('出張や会食の手配')
    expect(choice).toHaveTextContent('班の家族の都合を聞いて集合を決めた動きは、日程の調整に生かせそうです。')
    expect(choice).toHaveTextContent('「班の 2 家族の都合を聞きました」')
    expect(choice).not.toHaveTextContent(copy.options.createNotice)
    expect(choice).not.toHaveTextContent(copy.report.cardsStale)

    // 考え方と一歩
    const thinking = screen.getByRole('region', { name: copy.report.sections.thinking })
    expect(thinking).toHaveTextContent('3 人の会議の日程を決めてほしいと頼まれましたが、1 人から返事が来ません。')
    expect(thinking).toHaveTextContent(copy.deepen.yourAnswer.replace('{text}', '先に全員の都合を聞いてから決める'))
    expect(thinking).toHaveTextContent(copy.report.thinkingNote)
    const steps = screen.getByRole('region', { name: copy.report.sections.steps })
    expect(steps).toHaveTextContent('オンライン秘書の体験談を 2 つ読む')
    expect(steps).toHaveTextContent(`近所の図書館で本を借りる${copy.report.ownStep}`)
    expect(steps).not.toHaveTextContent(copy.deepen.stepOutside)

    for (const word of ['根拠あり', '要確認', '未確認']) {
      expect(document.body.textContent).not.toContain(word)
    }
  })

  it('report-1（一つにまとめて示す）: 選んだ案の力を外したとき、条件に収まらないとき、「創る」のとき、カードが古いときは、05 と同じ一言を添える', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({
        content: fakeReportContent({
          notYet: { checking: [], taskGaps: [], hasExcluded: true },
          choice: {
            kind: 'card',
            card: 'create',
            title: '習い事の送り迎えの調整の手伝い',
            summary: '共働きで、子どもの習い事の送り迎えに困っている家族の、家族どうしの送り迎えの当番が決まらない困りごとに',
            tasks: [],
            reason: null,
            ability: null,
            problem: 'excluded',
            outsideConditions: true,
            demandNotChecked: true,
            cardsStale: true,
            scenes: [],
          },
        }),
      }),
    })
    renderApp('/report')

    const choice = await screen.findByRole('region', { name: copy.report.sections.choice })
    expect(choice).toHaveTextContent(copy.options.kinds.create.label)
    expect(choice).toHaveTextContent(copy.options.chosenExcluded)
    expect(choice).toHaveTextContent(copy.options.chosenOutside)
    expect(choice).toHaveTextContent(copy.options.createNotice)
    expect(choice).toHaveTextContent(copy.report.cardsStale)
    expect(within(choice).queryByText(copy.options.reasonTitle)).not.toBeInTheDocument()

    const notYet = screen.getByRole('region', { name: copy.report.sections.notYet })
    expect(notYet).toHaveTextContent(copy.profile.excludedNote)
  })

  it('report-1（一つにまとめて示す）: 確かめた力の欄に力がないときは、「ほかの力も」と言わず、話を重ねると見えてくると添える', async () => {
    installFakeApi({ loggedIn: true, consented: true, report: fakeReport({ content: fakeReportContent({ abilities: [] }) }) })
    renderApp('/report')

    const notYet = await screen.findByRole('region', { name: copy.report.sections.notYet })
    expect(notYet).toHaveTextContent(copy.insights.nothingYetNote)
    expect(notYet).not.toHaveTextContent(copy.insights.moreNote)
  })

  it('report-1（一つにまとめて示す）: まだ聞けていない力の名前を並べず、代わりの一文を添える', async () => {
    installFakeApi({ loggedIn: true, consented: true, report: fakeReport() })
    renderApp('/report')

    const notYet = await screen.findByRole('region', { name: copy.report.sections.notYet })
    expect(notYet).not.toHaveTextContent('まだ聞けていない力')
    expect(notYet).toHaveTextContent(copy.insights.moreNote)
    const seen = within(screen.getByRole('region', { name: copy.report.sections.abilities })).getByRole('group', { name: copy.report.seenTitle })
    expect(within(seen).getByText('自分から働きかける')).toBeInTheDocument()
    const checking = within(screen.getByRole('region', { name: copy.report.sections.abilities })).getByRole('group', { name: copy.report.checkingTitle })
    expect(checking.querySelector('li .block')).toBeNull()
  })

  it('report-1（一つにまとめて示す）: 深めていないときは、考え方と一歩の欄に深める画面への道を出す', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({ content: fakeReportContent({ thinking: null, steps: null }) }),
      deepen: fakeDeepen(),
    })
    renderApp('/report')

    const thinking = await screen.findByRole('region', { name: copy.report.sections.thinking })
    expect(thinking).toHaveTextContent(copy.report.thinkingNotDeepened)
    expect(within(thinking).getByRole('link', { name: copy.report.toDeepen })).toHaveAttribute('href', '/deepen')
    const steps = screen.getByRole('region', { name: copy.report.sections.steps })
    expect(steps).toHaveTextContent(copy.report.stepsNotDeepened)
    expect(within(steps).getByRole('link', { name: copy.report.toDeepen })).toHaveAttribute('href', '/deepen')
    expect(within(steps).queryByRole('button', { name: copy.report.editSteps })).not.toBeInTheDocument()
  })

  it('report-2（直す、保留する、次の一歩を選ぶ）: 欄ごとに直す画面への道を出し、保留でき、深めた中身があれば一歩を選び直して保存できる', async () => {
    const deepenContent = fakeDeepenContent({
      steps: fakeDeepenContent().steps.map((s) => ({ ...s, chosen: s.id === 's1' })),
      ownSteps: ['近所の図書館で本を借りる'],
    })
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport(),
      deepen: fakeDeepen({ content: deepenContent }),
    })
    renderApp('/report')

    // 直す画面への道
    const links: [string, string, string][] = [
      [copy.report.sections.abilities, copy.report.edit.abilities, '/abilities'],
      [copy.report.sections.notYet, copy.report.edit.notYet, '/abilities'],
      [copy.report.sections.records, copy.report.edit.records, '/profile'],
      [copy.report.sections.choice, copy.report.edit.choice, '/options'],
      [copy.report.sections.thinking, copy.report.edit.thinking, '/deepen'],
    ]
    for (const [section, label, href] of links) {
      const region = await screen.findByRole('region', { name: section })
      expect(within(region).getByRole('link', { name: label })).toHaveAttribute('href', href)
    }
    // まだ確かめていないことは、本人の誤りや欠けではないので、「直す」とは書かない（芯 2）
    expect(copy.report.edit.notYet).not.toContain('直す')

    // 一歩を選び直す・書く
    const steps = screen.getByRole('region', { name: copy.report.sections.steps })
    await userEvent.click(await within(steps).findByRole('button', { name: copy.report.editSteps }))
    expect(within(steps).getByRole('checkbox', { name: /オンライン秘書の体験談を 2 つ読む/ })).toBeChecked()
    expect(within(steps).getByLabelText(copy.deepen.ownStepLabel.replace('{n}', '1'))).toHaveValue('近所の図書館で本を借りる')
    await userEvent.click(within(steps).getByRole('checkbox', { name: /募集を 3 つ読み/ }))
    await userEvent.click(within(steps).getByRole('button', { name: copy.deepen.stepsSave }))

    expect(await within(steps).findByText(copy.deepen.stepsSaved)).toBeInTheDocument()
    expect(puts(api.calls, '/api/deepen/steps')).toEqual([
      { chosen: ['s1', 's3'], own: ['近所の図書館で本を借りる'], generatedAt: deepenContent.generatedAt },
    ])
    // 保存したら、レポートを読み直す
    await waitFor(() => expect(gets(api.calls)).toHaveLength(2))
    // 選び直した一歩が、レポートの一歩の並び（と、開いている選ぶ欄）に出る
    await waitFor(() => expect(within(steps).getAllByText('募集を 3 つ読み、業務と時間の条件を書き出す')).toHaveLength(2))

    // 保留する
    const choice = screen.getByRole('region', { name: copy.report.sections.choice })
    await userEvent.click(within(choice).getByRole('button', { name: copy.options.hold }))
    expect(await within(choice).findByText(copy.report.holding)).toBeInTheDocument()
    expect(puts(api.calls, '/api/options/choice')).toEqual([{ kind: 'hold' }])
    expect(gets(api.calls)).toHaveLength(3)
    expect(within(choice).queryByRole('button', { name: copy.options.hold })).not.toBeInTheDocument()
    // 保留中は、前に選んでいた案の考え方と一歩を出さず、仕事の選択肢へ案内する
    expect(screen.getByRole('region', { name: copy.report.sections.steps })).toHaveTextContent(copy.report.stepsNotChosen)
  })

  it('report-2（直す、保留する、次の一歩を選ぶ）: 深めた中身が古いときは、一歩を選び直す道を出さない', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport(),
      deepen: fakeDeepen({ content: fakeDeepenContent({ stale: true, steps: [] }) }),
    })
    renderApp('/report')

    const steps = await screen.findByRole('region', { name: copy.report.sections.steps })
    expect(steps).toHaveTextContent('オンライン秘書の体験談を 2 つ読む')
    // getDeepen を待ってからも出ない
    await waitFor(() => expect(within(steps).queryByRole('button', { name: copy.report.editSteps })).not.toBeInTheDocument())
  })

  it('report-2（直す、保留する、次の一歩を選ぶ）: 深めた中身を読めないときも、最初の一歩の欄に深める画面への道を出し、答えていない問いは答えずにおいてよいと書く', async () => {
    // 深める画面の API が、いまの案で深めた中身を返さない（一歩を選び直す欄は開けない）
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({ content: fakeReportContent({ thinking: [] }) }),
      deepen: fakeDeepen({ readiness: 'noChoice', target: null }),
    })
    renderApp('/report')

    const steps = await screen.findByRole('region', { name: copy.report.sections.steps })
    expect(steps).toHaveTextContent('オンライン秘書の体験談を 2 つ読む')
    expect(within(steps).getByRole('link', { name: copy.report.toDeepen })).toHaveAttribute('href', '/deepen')
    expect(within(steps).queryByRole('button', { name: copy.report.editSteps })).not.toBeInTheDocument()
    const thinking = screen.getByRole('region', { name: copy.report.sections.thinking })
    expect(thinking).toHaveTextContent(copy.report.noThoughts)
    expect(copy.report.noThoughts).toContain('かまいません')
  })

  it('report-3（版を残す）: 前の版では、条件の外と深めていないことを、その版の時点のこととして書き、いまの操作を勧めない', async () => {
    const content = fakeReportContent()
    const past = fakeReportContent({
      abilities: [],
      choice: { ...content.choice, outsideConditions: true },
      thinking: null,
      steps: [{ text: '近所の図書館で本を借りる', own: false, fits: false }],
    })
    const pastNotDeepened = fakeReportContent({ thinking: null, steps: null })
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({
        content,
        current: { number: 3, at: '2026-11-03T11:00:00Z', changed: ['choice'], snapshot: fakeReportSnapshot(content) },
        previous: [
          { number: 2, at: '2026-11-03T10:00:00Z', changed: ['steps'], snapshot: fakeReportSnapshot(past) },
          { number: 1, at: '2026-11-03T09:00:00Z', changed: [], snapshot: fakeReportSnapshot(pastNotDeepened) },
        ],
      }),
    })
    renderApp('/report')

    await userEvent.click(await screen.findByRole('button', { name: copy.report.previousShow }))
    const previous = screen.getByRole('region', { name: copy.report.previousTitle })
    const v2 = within(previous).getByRole('article', { name: copy.report.version.replace('{n}', '2').replace('{at}', '11 月 3 日 19:00') })
    expect(v2).toHaveTextContent(copy.report.snapshotNoAbilities)
    expect(v2).toHaveTextContent(copy.report.snapshotOutside)
    expect(v2).toHaveTextContent(copy.report.snapshotStepOutside)
    expect(v2).toHaveTextContent(copy.report.snapshotNotDeepened)
    expect(v2).not.toHaveTextContent(copy.report.noAbilities)
    expect(v2).not.toHaveTextContent(copy.options.chosenOutside)
    expect(v2).not.toHaveTextContent(copy.deepen.stepOutside)
    expect(v2).not.toHaveTextContent(copy.report.thinkingNotDeepened)
    const v1 = within(previous).getByRole('article', { name: copy.report.version.replace('{n}', '1').replace('{at}', '11 月 3 日 18:00') })
    expect(within(v1).getAllByText(copy.report.snapshotNotDeepened)).toHaveLength(2)
    expect(v1).not.toHaveTextContent(copy.report.stepsNotDeepened)
    // 前の版の写しの文は、いまの操作を勧めず、「いま」とも書かない
    for (const text of [copy.report.snapshotNoAbilities, copy.report.snapshotNotDeepened, copy.report.snapshotOutside, copy.report.snapshotStepOutside]) {
      expect(text).not.toMatch(/いまの|いまは/)
      expect(text).not.toMatch(/できます|話せます|残せます/)
    }
    // 前の版には、いまの版の道（直す、深める）を出さない
    expect(within(previous).queryByRole('link')).not.toBeInTheDocument()
  })

  it('report-1（一つにまとめて示す）: 選んだ案に力が生きる場面を、まだ確かめていないことに本人に確かめる条件を出す', async () => {
    const base = fakeReportContent()
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({
        content: fakeReportContent({
          notYet: {
            ...base.notYet,
            taskGaps: [{ taskName: '日程の調整', abilityName: null, knowledge: ['表計算'], checks: ['連絡が来る時間帯', '急な変更への対応'] }],
          },
          choice: { ...base.choice, scenes: [{ taskName: '日程の調整', scene: '関わる人の都合が食い違うとき' }] },
        }),
      }),
    })
    renderApp('/report')

    const choice = await screen.findByRole('region', { name: copy.report.sections.choice })
    expect(within(choice).getByText(copy.report.sceneTitle)).toBeInTheDocument()
    expect(choice).toHaveTextContent(copy.report.sceneLine.replace('{task}', '日程の調整').replace('{scene}', '関わる人の都合が食い違うとき'))
    const notYet = screen.getByRole('region', { name: copy.report.sections.notYet })
    expect(notYet).toHaveTextContent(
      copy.report.taskChecks.replace('{task}', '日程の調整').replace('{items}', '連絡が来る時間帯、急な変更への対応'),
    )
  })

  it('report-1（一つにまとめて示す）: 力が生きる場面が来なければ、その見出しも出さない', async () => {
    installFakeApi({ loggedIn: true, consented: true, report: fakeReport() })
    renderApp('/report')

    const choice = await screen.findByRole('region', { name: copy.report.sections.choice })
    expect(within(choice).queryByText(copy.report.sceneTitle)).not.toBeInTheDocument()
  })

  it('report-3（版を残す）: 前の版にも、業務の本人に確かめる条件を出し、力が生きる場面は出さない', async () => {
    const base = fakeReportContent()
    const past = fakeReportContent({
      notYet: { ...base.notYet, taskGaps: [{ taskName: '日程の調整', abilityName: null, knowledge: [], checks: ['連絡が来る時間帯'] }] },
    })
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({
        content: base,
        current: { number: 2, at: '2026-11-03T10:00:00Z', changed: [], snapshot: fakeReportSnapshot(base) },
        previous: [{ number: 1, at: '2026-11-03T09:00:00Z', changed: [], snapshot: fakeReportSnapshot(past) }],
      }),
    })
    renderApp('/report')

    await userEvent.click(await screen.findByRole('button', { name: copy.report.previousShow }))
    const previous = screen.getByRole('region', { name: copy.report.previousTitle })
    expect(previous).toHaveTextContent(copy.report.taskChecks.replace('{task}', '日程の調整').replace('{items}', '連絡が来る時間帯'))
    expect(within(previous).queryByText(copy.report.sceneTitle)).not.toBeInTheDocument()
  })

  it('report-3（版を残す）: 版の番号と変わった欄を出し、前の版は根拠の言葉なしで見られる', async () => {
    const first = fakeReportContent({
      records: { ...fakeReportContent().records, preferences: [{ text: '人とやりとりしながら進められる', source: 'chosen' }] },
    })
    const content = fakeReportContent()
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({
        content,
        current: { number: 2, at: '2026-11-03T10:30:00Z', changed: ['records', 'choice'], snapshot: fakeReportSnapshot(content) },
        previous: [{ number: 1, at: '2026-11-03T09:00:00Z', changed: [], snapshot: fakeReportSnapshot(first) }],
      }),
    })
    renderApp('/report')

    expect(await screen.findByText(copy.report.version.replace('{n}', '2').replace('{at}', '11 月 3 日 19:30'))).toBeInTheDocument()
    expect(
      screen.getByText(
        copy.report.changed.replace('{sections}', `${copy.report.sections.records}、${copy.report.sections.choice}`),
      ),
    ).toBeInTheDocument()
    // 前の版は、開くまで出さない
    expect(screen.queryByRole('region', { name: copy.report.previousTitle })).not.toBeInTheDocument()

    const toggle = screen.getByRole('button', { name: copy.report.previousShow })
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(toggle)
    expect(screen.getByRole('button', { name: copy.report.previousHide })).toHaveAttribute('aria-expanded', 'true')

    const previous = screen.getByRole('region', { name: copy.report.previousTitle })
    const v1 = within(previous).getByRole('article', { name: copy.report.version.replace('{n}', '1').replace('{at}', '11 月 3 日 18:00') })
    expect(v1).toHaveTextContent('利害調整力')
    expect(v1).toHaveTextContent('優先順位設定力')
    expect(v1).toHaveTextContent('人とやりとりしながら進められる')
    expect(v1).toHaveTextContent('オンライン秘書')
    expect(v1).toHaveTextContent('近所の図書館で本を借りる')
    // 根拠の言葉、選んだ案の理由、力の状態は出さない
    expect(v1).not.toHaveTextContent('班の 2 家族の都合を聞きました')
    expect(v1).not.toHaveTextContent('先に書類を仕上げました')
    expect(v1).not.toHaveTextContent('班の家族の都合を聞いて集合を決めた動きは')
    expect(within(v1).queryByText(copy.report.abilityStates.needsCheck)).not.toBeInTheDocument()
    // まだ確かめていないことも、力の状態を表す行は出さず、業務に要る知識や道具だけを出す
    expect(v1).not.toHaveTextContent(copy.report.checking.replace('{names}', '優先順位設定力'))
    expect(v1).not.toHaveTextContent('まだ聞けていない力')
    expect(v1).not.toHaveTextContent(copy.report.taskAbility.replace('{task}', '出張や会食の手配').replace('{name}', '変化への気づき'))
    expect(v1).toHaveTextContent(copy.report.taskKnowledge.replace('{task}', '日程の調整').replace('{items}', '表計算'))
    // 前の版の力は状態なしで名前だけ並ぶので、見出しは根拠ありの呼び名にせず、見えた力と確かめ中の力の両方を含む言い方にする（芯 1）
    const names = within(v1).getByRole('heading', { name: copy.report.snapshotAbilities })
    expect(names.nextElementSibling).toHaveTextContent('利害調整力、優先順位設定力')
    expect(copy.report.snapshotAbilities).toContain('確かめ中')
    expect(v1).not.toHaveTextContent(copy.report.seenTitle)
    expect(within(v1).getAllByRole('heading', { level: 4 }).map((h) => h.textContent)).toEqual([
      copy.report.snapshotAbilities,
      ...SECTION_TITLES.slice(1),
    ])
    // 5 つの記録のできることは、前の版の力の見出しを指す
    expect(v1).toHaveTextContent(copy.report.snapshotCanDoNote)
    expect(v1).not.toHaveTextContent(copy.report.canDoNote.replace('{title}', copy.report.sections.abilities))
  })

  it('report-4（決めつけない）: 選んだ案を「あなたが選んだ案」として書き、レポートの文言に使わない言葉と言い切りがない', async () => {
    const words = ['根拠あり', '要確認', '未確認', ...forbiddenWords, ...ASSERTIVE_WORDS]
    const texts = flatten(copy.report)
    const found = words.flatMap((word) => texts.filter((text) => text.includes(word)).map((text) => `${word}: ${text}`))
    expect(found).toEqual([])
    expect(copy.report.sections.choice).toBe('あなたが選んだ案')

    const content = fakeReportContent()
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({
        current: { number: 2, at: '2026-11-03T10:30:00Z', changed: ['choice'], snapshot: fakeReportSnapshot(content) },
        previous: [{ number: 1, at: '2026-11-03T09:00:00Z', changed: [], snapshot: fakeReportSnapshot(content) }],
      }),
    })
    renderApp('/report')
    expect(await screen.findByRole('heading', { name: 'あなたが選んだ案' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: copy.report.previousShow }))
    // 「優先順位設定力」は PRD が決めた力の名前なので、この言葉だけ除いて見る
    const page = (document.body.textContent ?? '').replaceAll('優先順位', '')
    for (const word of words) {
      expect(page).not.toContain(word)
    }
    expect(page).not.toMatch(/[0-9０-９]+\s*(点|位)/)
  })

  it('report-5（保留しても開ける）: 保留のときと、まだ選んでいないときの言葉と道を出す', async () => {
    const hold = {
      kind: 'hold' as const,
      card: null,
      title: null,
      summary: null,
      tasks: [],
      reason: null,
      ability: null,
      problem: null,
      outsideConditions: false,
      demandNotChecked: false,
      cardsStale: false,
      scenes: [],
    }
    for (const [kind, text] of [
      ['hold', copy.report.holding],
      [null, copy.report.noChoice],
    ] as const) {
      installFakeApi({
        loggedIn: true,
        consented: true,
        report: fakeReport({
          content: fakeReportContent({
            choice: { ...hold, kind },
            notYet: { ...fakeReportContent().notYet, taskGaps: [] },
            thinking: null,
            steps: null,
          }),
        }),
      })
      const { unmount } = renderApp('/report')

      const choice = await screen.findByRole('region', { name: copy.report.sections.choice })
      expect(choice).toHaveTextContent(text)
      // まだ選んでいないときは、選ばずにおいても保留にしてもよいことを添える（芯 5）
      if (kind === null) expect(text).toContain('かまいません')
      expect(within(choice).getByRole('link', { name: copy.report.toOptions })).toHaveAttribute('href', '/options')
      expect(within(choice).queryByRole('button', { name: copy.options.hold })).not.toBeInTheDocument()
      // 案を選んでいないので、考え方と一歩の欄は深める画面ではなく仕事の選択肢へ案内する
      for (const [section, notChosen] of [
        [copy.report.sections.thinking, copy.report.thinkingNotChosen],
        [copy.report.sections.steps, copy.report.stepsNotChosen],
      ] as const) {
        const region = screen.getByRole('region', { name: section })
        expect(region).toHaveTextContent(notChosen)
        expect(within(region).getByRole('link', { name: copy.report.toOptions })).toHaveAttribute('href', '/options')
        expect(within(region).queryByRole('link', { name: copy.report.toDeepen })).not.toBeInTheDocument()
      }
      unmount()
      vi.unstubAllGlobals()
    }
  })

  it('report-1（一つにまとめて示す）: 見立てを外していて、できることが空のときは、外した見立てはここに出していないと伝える', async () => {
    const content = fakeReportContent({ abilities: [], abilitiesExcluded: true })
    installFakeApi({
      loggedIn: true,
      consented: true,
      report: fakeReport({ content, current: { number: 1, at: '2026-11-03T09:00:00Z', changed: [], snapshot: fakeReportSnapshot(content) } }),
    })
    renderApp('/report')

    const abilities = await screen.findByRole('region', { name: copy.report.sections.abilities })
    expect(abilities).toHaveTextContent(copy.profile.excludedNote)
    expect(abilities).not.toHaveTextContent(copy.report.noAbilities)
  })

  it('report-1（一つにまとめて示す）: 読み込めなかったときも、ホームへの道を出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    api.state.reportFails = true
    renderApp('/report')

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.errors.generic)
    expect(screen.getByRole('link', { name: copy.report.backHome })).toHaveAttribute('href', '/home')
  })

  it('report-2（直す、保留する、次の一歩を選ぶ）: 考え方の欄の道は、画面の名前どおり「選んだ案を深める画面で直す」と書く', async () => {
    installFakeApi({ loggedIn: true, consented: true, report: fakeReport() })
    renderApp('/report')

    const thinking = await screen.findByRole('region', { name: copy.report.sections.thinking })
    expect(within(thinking).getByRole('link', { name: '選んだ案を深める画面で直す' })).toHaveAttribute('href', '/deepen')
  })
})
