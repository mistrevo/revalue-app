import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import forbiddenWords from '../../../shared/forbidden-words.json'
import { AppRoutes } from '@/App'
import { copy } from '@/copy'
import {
  FAKE_DEEPEN_CHOICES,
  fakeDeepen,
  fakeDeepenContent,
  fakeDraftedTask,
  installFakeApi,
  type FakeCall,
} from '@/test/fake-api'
import { renderApp } from '@/test/render-app'
import type { DeepenTask } from '@/api'

afterEach(() => {
  vi.unstubAllGlobals()
})

function posts(calls: FakeCall[]) {
  return calls.filter((c) => c.method === 'POST' && c.url === '/api/deepen')
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

/** 待たせた応答を、テストが好きなときに返させる。 */
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

/** 本人が書いた仕事を選び、見立ての業務を 2 つ作ってある。 */
function ownWithDrafts() {
  return fakeDeepen({
    target: { kind: 'own', title: '家でできるデータ入力', outsideConditions: false },
    content: fakeDeepenContent({
      tasks: [
        fakeDraftedTask('d1', { name: '入力の手順を決める', detail: '入力する順番を決めて、表にまとめる', ability: 'setting-priorities', knowledge: '表計算' }),
        fakeDraftedTask('d2', { name: '依頼した人との連絡', detail: '締め切りと量を確かめる', ability: 'balancing-interests', knowledge: '' }),
      ],
    }),
  })
}

describe('Deepen', () => {
  it('deepen-2（業務ごとに照らす）: 業務の力の選択肢は、裏側が返した力の一覧から出る（画面は力の id を知らない）', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: { ...ownWithDrafts(), abilities: [{ key: 'sample-ability-a', name: '架空の力 A' }, { key: 'sample-ability-b', name: '架空の力 B' }] },
    })
    renderApp('/deepen')
    const tasks = await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.editLabel.replace('{text}', '入力の手順を決める') }))
    const select = within(tasks).getByLabelText(copy.deepen.taskAbilityLabel)
    const options = within(select).getAllByRole('option').map((o) => o.textContent)
    expect(options).toContain('架空の力 A')
    expect(options).toContain('架空の力 B')
    expect(options).not.toContain('変化への気づき')
  })

  it('deepen-1（選んだ 1 案だけ深める）: 選んだ案がないときと保留のときは、仕事の選択肢への道を一つだけ出す', async () => {
    for (const [readiness, text] of [
      ['noChoice', copy.deepen.noChoice],
      ['hold', copy.deepen.hold],
    ] as const) {
      const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ readiness, target: null }) })
      const { unmount } = renderApp('/deepen')

      expect(await screen.findByText(text)).toBeInTheDocument()
      const notReady = screen.getByText(text).parentElement!
      const links = within(notReady).getAllByRole('link')
      expect(links).toHaveLength(1)
      expect(links[0]).toHaveTextContent(copy.deepen.toOptions)
      expect(links[0]).toHaveAttribute('href', '/options')
      expect(screen.queryByRole('button', { name: copy.deepen.generate })).not.toBeInTheDocument()
      expect(posts(api.calls)).toHaveLength(0)
      unmount()
      vi.unstubAllGlobals()
    }

    // 条件が入っていないときは、5 つの記録の条件から聞く入口への道
    installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ readiness: 'needsConditions', target: null }) })
    renderApp('/deepen')
    expect(await screen.findByText(copy.deepen.needsConditions)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.deepen.toProfile })).toHaveAttribute('href', '/profile?ask=conditions')
  })

  it('deepen-1（選んだ 1 案だけ深める）: まだ深めていなければ「この案を深める」で作り、待っているあいだはそのことを伝える', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen() })
    const wait = gate()
    api.state.deepenGate = wait.promise
    renderApp('/deepen')

    const target = await screen.findByRole('region', { name: copy.deepen.targetTitle })
    expect(target).toHaveTextContent('オンライン秘書')
    expect(target).toHaveTextContent(copy.options.kinds.choose.label)
    expect(within(target).getByRole('link', { name: copy.deepen.backToOptions })).toHaveAttribute('href', '/options')
    // 需要の一言は「創る」だけ
    expect(target).not.toHaveTextContent(copy.options.createNotice)
    expect(screen.getByText(copy.deepen.lead)).toBeInTheDocument()
    // 開いただけでは作らない（初めての作成は本人が押す）
    expect(posts(api.calls)).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: copy.deepen.generate }))
    expect(await screen.findByText(copy.deepen.generating)).toBeInTheDocument()
    wait.open()

    expect(await screen.findByText('日程の調整')).toBeInTheDocument()
    expect(screen.queryByText(copy.deepen.generating)).not.toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(1)
    // 並び: 選んだ案 → 業務ごとに見る → もしもの場面で → 最初の一歩 → うまくいかなかったときは
    expect(regionNames()).toEqual([
      copy.deepen.targetTitle,
      copy.deepen.tasksTitle,
      copy.deepen.questionsTitle,
      copy.deepen.stepsTitle,
      copy.deepen.notWorkingTitle,
    ])
  })

  it('deepen-1（選んだ 1 案だけ深める）: 選び直して古くなっていたら、開いたときに 1 回だけ作り直す', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: fakeDeepen({
        target: { kind: 'combine', title: '小さな事務所の段取り係', outsideConditions: false },
        content: fakeDeepenContent({ stale: true, tasks: [], questions: [], steps: [], ownSteps: [] }),
      }),
    })
    const wait = gate()
    api.state.deepenGate = wait.promise
    api.state.deepenGenerate = fakeDeepenContent({
      generatedAt: '2026-11-03T09:00:00Z',
      tasks: [{ ...fakeDeepenContent().tasks[0], name: '面接の日程の連絡' }],
    })
    // React の StrictMode で、画面を開く処理が 2 回走っても作り直しは 1 回
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/deepen']}>
          <AppRoutes />
        </MemoryRouter>
      </StrictMode>,
    )

    expect(await screen.findByText(copy.deepen.regenerating)).toBeInTheDocument()
    // 作り直すあいだ、前の案の中身は出さない
    expect(screen.queryByRole('region', { name: copy.deepen.tasksTitle })).not.toBeInTheDocument()

    wait.open()
    expect(await screen.findByText('面接の日程の連絡')).toBeInTheDocument()
    expect(screen.queryByText(copy.deepen.regenerating)).not.toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(1)
  })

  it('deepen-1（選んだ 1 案だけ深める）: いまの案で失敗していたら自動では作り直さず、「もう一度作る」を出す', async () => {
    const api = installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: fakeDeepen({ content: fakeDeepenContent({ stale: true, retryPaused: true, tasks: [], questions: [], steps: [] }) }),
    })
    renderApp('/deepen')

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.deepen.generateFailed)
    expect(posts(api.calls)).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: copy.deepen.retry }))
    expect(await screen.findByText('日程の調整')).toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(1)
  })

  it('deepen-1（選んだ 1 案だけ深める）: 初めて深めるときに失敗していたら、開き直しても失敗を伝え、「もう一度作る」を出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ retryPaused: true }) })
    renderApp('/deepen')

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.deepen.generateFailed)
    expect(screen.queryByRole('button', { name: copy.deepen.generate })).not.toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: copy.deepen.retry }))
    expect(await screen.findByText('日程の調整')).toBeInTheDocument()
    expect(posts(api.calls)).toHaveLength(1)
  })

  it('deepen-3（最初の一歩は小さく）: コードの候補と中身の候補が並んでいても、裏側が入れ替えたと言わなければ、入れ替えたとは添えない', async () => {
    const base = fakeDeepenContent().steps
    installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: fakeDeepen({
        content: fakeDeepenContent({
          steps: [base[0], base[1], base[2], { id: 'f1', text: 'この仕事について知りたいことを書き出す', hours: 1, place: 'home', demandCheck: false, fits: true, chosen: true }],
          stepsReplaced: false,
        }),
      }),
    })
    renderApp('/deepen')

    const steps = await screen.findByRole('region', { name: copy.deepen.stepsTitle })
    expect(steps).not.toHaveTextContent(copy.deepen.stepsReplaced)
  })

  it('deepen-1（選んだ 1 案だけ深める）: 作るのに失敗したら穏やかな言葉と「もう一度作る」を出し、上限なら上限の言葉だけを出す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen() })
    api.state.deepenGenerate = { status: 503, body: { type: '/problems/ai-unavailable', status: 503, kind: 'failure' } }
    renderApp('/deepen')

    await userEvent.click(await screen.findByRole('button', { name: copy.deepen.generate }))
    expect(await screen.findByRole('alert')).toHaveTextContent(copy.deepen.generateFailed)
    expect(screen.getByRole('button', { name: copy.deepen.retry })).toBeInTheDocument()

    api.state.deepenGenerate = { status: 429, body: { type: '/problems/daily-limit', status: 429, resetAt: '2026-11-03T15:00:00Z' } }
    await userEvent.click(screen.getByRole('button', { name: copy.deepen.retry }))
    expect(await screen.findByText(copy.limit.title)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.deepen.retry })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: copy.deepen.generate })).not.toBeInTheDocument()
  })

  it('deepen-1（選んだ 1 案だけ深める）: 選んだ案がいまの条件に収まらなくなっていたら、仕事の選択肢の画面と同じ一言を添える', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: fakeDeepen({ target: { kind: 'choose', title: 'オンライン秘書', outsideConditions: true }, content: fakeDeepenContent() }),
    })
    renderApp('/deepen')

    const target = await screen.findByRole('region', { name: copy.deepen.targetTitle })
    expect(target).toHaveTextContent(copy.options.chosenOutside)
  })

  it('deepen-1（選んだ 1 案だけ深める）: 書き換えのあいだに選んだ案が変わっていたら、読み直して、新しい案で深め直せると伝える', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')
    const steps = await screen.findByRole('region', { name: copy.deepen.stepsTitle })
    // ほかのタブで選び直した
    api.state.deepen = fakeDeepen({
      target: { kind: 'combine', title: '小さな事務所の段取り係', outsideConditions: false },
      content: fakeDeepenContent({ stale: true, tasks: [], questions: [], steps: [] }),
    })

    await userEvent.click(within(steps).getByRole('checkbox', { name: /オンライン秘書の体験談を 2 つ読む/ }))
    await userEvent.click(within(steps).getByRole('button', { name: copy.deepen.stepsSave }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.deepen.changed)
    expect(screen.queryByRole('region', { name: copy.deepen.stepsTitle })).not.toBeInTheDocument()
    expect(screen.getByRole('region', { name: copy.deepen.targetTitle })).toHaveTextContent('小さな事務所の段取り係')
    expect(screen.getByRole('button', { name: copy.deepen.generate })).toBeInTheDocument()
  })

  it('deepen-1（選んだ 1 案だけ深める）: 同じ案がほかの画面で深め直されていたら、書き換えを入れずに読み直し、そのことを伝える', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')
    const questions = await screen.findByRole('region', { name: copy.deepen.questionsTitle })
    // ほかのタブで別の案を選んで深め、また同じ案を選んで深め直した（作った日時が違う）
    api.state.deepen = fakeDeepen({
      content: fakeDeepenContent({
        generatedAt: '2026-11-03T10:00:00Z',
        questions: [{ ...fakeDeepenContent().questions[0], situation: '架空の場面: 依頼した人から、急ぎの予定の変更を頼まれました。' }],
      }),
    })

    await userEvent.click(within(questions).getByRole('button', { name: FAKE_DEEPEN_CHOICES[1] }))

    expect(await screen.findByRole('alert')).toHaveTextContent(copy.deepen.regenerated)
    expect(await screen.findByText('架空の場面: 依頼した人から、急ぎの予定の変更を頼まれました。')).toBeInTheDocument()
    expect(screen.queryByText(copy.deepen.yourAnswer.replace('{text}', FAKE_DEEPEN_CHOICES[1]))).not.toBeInTheDocument()
    expect(api.state.deepen.content?.questions[0].answer).toBeNull()
    expect(puts(api.calls, '/api/deepen/answers/q1')).toEqual([
      { text: FAKE_DEEPEN_CHOICES[1], fromChoice: true, generatedAt: fakeDeepenContent().generatedAt },
    ])
  })

  it('deepen-2（業務ごとに照らす）: 業務ごとに、使える力と根拠の言葉か、まだ確かめていない力と知識や道具を出す', async () => {
    installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')

    const tasks = await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    const schedule = within(tasks).getByRole('article', { name: '日程の調整' })
    expect(schedule).toHaveTextContent('関わる人と連絡を取り合って、会う日時を決める')
    expect(within(schedule).getByText(copy.deepen.usableTitle)).toBeInTheDocument()
    expect(schedule).toHaveTextContent('利害調整力')
    expect(schedule).toHaveTextContent(copy.deepen.abilityStates.confirmed)
    expect(schedule).toHaveTextContent('「班の 2 家族の都合を聞きました」')
    expect(schedule).toHaveTextContent(`「私から声をかけた」${copy.insights.chosen}`)
    // 知識や道具は、まだ確かめていないこととして並べる
    expect(within(schedule).getByText(copy.deepen.notYetTitle)).toBeInTheDocument()
    expect(schedule).toHaveTextContent('表計算')

    const travel = within(tasks).getByRole('article', { name: '出張や会食の手配' })
    expect(within(travel).queryByText(copy.deepen.usableTitle)).not.toBeInTheDocument()
    expect(travel).toHaveTextContent(copy.deepen.abilityNotYet.replace('{name}', '変化への気づき'))

    expect(tasks).toHaveTextContent(copy.deepen.workNote)
    // 登録した業務は直せない
    expect(within(tasks).queryByText(copy.deepen.draftedTitle)).not.toBeInTheDocument()
    expect(within(tasks).queryByRole('button', { name: copy.deepen.taskAdd })).not.toBeInTheDocument()
    // 状態の呼び名は出さない
    for (const word of ['根拠あり', '要確認', '未確認']) {
      expect(document.body.textContent).not.toContain(word)
    }
  })

  it('deepen-2（業務ごとに照らす）: 力の名前のない業務も出し、「まだ確かめていません」の行を出さない', async () => {
    // 業務の力が辞書から消えていると、裏側は力の id と名前を null で返す
    const legacy: DeepenTask = { ...fakeDraftedTask('d9', { name: '昔の見立ての業務', detail: '前に作った業務', ability: 'balancing-interests', knowledge: '表計算' }), ability: null, abilityName: null, usable: null }
    installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: { ...ownWithDrafts(), content: fakeDeepenContent({ tasks: [legacy] }) },
    })
    renderApp('/deepen')

    const tasks = await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    const task = within(tasks).getByRole('article', { name: '昔の見立ての業務' })
    expect(task).toHaveTextContent('前に作った業務')
    expect(within(task).queryByText(copy.deepen.usableTitle)).not.toBeInTheDocument()
    expect(task.textContent).not.toContain(copy.deepen.abilityNotYet.split('{name}')[0])
    expect(task.textContent).not.toContain('null')
    // 知識や道具は、まだ確かめていないこととして出す
    expect(task).toHaveTextContent('表計算')

    // 直す欄では、力を選び直してもらう（選ぶまで保存できない）
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.editLabel.replace('{text}', '昔の見立ての業務') }))
    const select = within(tasks).getByLabelText(copy.deepen.taskAbilityLabel) as HTMLSelectElement
    expect(select.value).toBe('')
  })

  it('deepen-2（業務ごとに照らす）: 見立ての業務は「AI の見立て（直せます）」と示し、直す・消す・足すができる', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: ownWithDrafts() })
    renderApp('/deepen')

    const tasks = await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    expect(within(tasks).getByText(copy.deepen.draftedTitle)).toBeInTheDocument()

    // 直す
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.editLabel.replace('{text}', '入力の手順を決める') }))
    const name = within(tasks).getByLabelText(copy.deepen.taskNameLabel)
    expect(name).toHaveValue('入力の手順を決める')
    expect(within(tasks).getByLabelText(copy.deepen.taskKnowledgeLabel)).toHaveValue('表計算')
    await userEvent.clear(name)
    await userEvent.type(name, '入力の順番を決める')
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.save }))
    expect(await within(tasks).findByRole('article', { name: '入力の順番を決める' })).toBeInTheDocument()

    // 消す
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.removeLabel.replace('{text}', '依頼した人との連絡') }))
    await waitFor(() => expect(within(tasks).queryByRole('article', { name: '依頼した人との連絡' })).not.toBeInTheDocument())

    // 足す
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.taskAdd }))
    await userEvent.type(within(tasks).getByLabelText(copy.deepen.taskNameLabel), '入力したものを見直す')
    await userEvent.selectOptions(within(tasks).getByLabelText(copy.deepen.taskAbilityLabel), '利害調整力')
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.save }))
    const added = await within(tasks).findByRole('article', { name: '入力したものを見直す' })
    // 直した業務も、同じように照らす
    expect(added).toHaveTextContent(copy.deepen.abilityStates.confirmed)

    const generatedAt = fakeDeepenContent().generatedAt
    expect(puts(api.calls, '/api/deepen/tasks')).toEqual([
      {
        tasks: [
          { name: '入力の順番を決める', detail: '入力する順番を決めて、表にまとめる', ability: 'setting-priorities', knowledge: '表計算' },
          { name: '依頼した人との連絡', detail: '締め切りと量を確かめる', ability: 'balancing-interests', knowledge: '' },
        ],
        generatedAt,
      },
      { tasks: [{ name: '入力の順番を決める', detail: '入力する順番を決めて、表にまとめる', ability: 'setting-priorities', knowledge: '表計算' }], generatedAt },
      {
        tasks: [
          { name: '入力の順番を決める', detail: '入力する順番を決めて、表にまとめる', ability: 'setting-priorities', knowledge: '表計算' },
          { name: '入力したものを見直す', detail: '', ability: 'balancing-interests', knowledge: '' },
        ],
        generatedAt,
      },
    ])
  })

  it('deepen-2（業務ごとに照らす）: 見立ての業務をすべて消しても、「業務を足す」で書ける', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: ownWithDrafts() })
    renderApp('/deepen')

    const tasks = await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    for (const name of ['入力の手順を決める', '依頼した人との連絡']) {
      await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.removeLabel.replace('{text}', name) }))
      await waitFor(() => expect(within(tasks).queryByRole('article', { name })).not.toBeInTheDocument())
    }
    expect(within(tasks).queryAllByRole('article')).toHaveLength(0)
    // 消したあとも、見立てを直せることと、足す道を出す
    expect(within(tasks).getByText(copy.deepen.draftedTitle)).toBeInTheDocument()

    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.taskAdd }))
    await userEvent.type(within(tasks).getByLabelText(copy.deepen.taskNameLabel), '入力したものを見直す')
    await userEvent.selectOptions(within(tasks).getByLabelText(copy.deepen.taskAbilityLabel), '利害調整力')
    await userEvent.click(within(tasks).getByRole('button', { name: copy.deepen.save }))
    expect(await within(tasks).findByRole('article', { name: '入力したものを見直す' })).toBeInTheDocument()
    expect(puts(api.calls, '/api/deepen/tasks').at(-1)).toEqual({
      tasks: [{ name: '入力したものを見直す', detail: '', ability: 'balancing-interests', knowledge: '' }],
      generatedAt: fakeDeepenContent().generatedAt,
    })
  })

  it('deepen-2（業務ごとに照らす）: 業務の見立てを作れなかったときは、そのことと、業務を自分で書けることを伝える', async () => {
    installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: fakeDeepen({
        target: { kind: 'create', title: '習い事の送り迎えの調整の手伝い', outsideConditions: false },
        content: fakeDeepenContent({ tasks: [], tasksRejected: true }),
      }),
    })
    renderApp('/deepen')

    const tasks = await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    expect(tasks).toHaveTextContent(copy.deepen.tasksRejected)
    expect(within(tasks).getByRole('button', { name: copy.deepen.taskAdd })).toBeInTheDocument()
  })

  it('deepen-3（最初の一歩は小さく）: 候補を選び、自分で書いて保存できる。条件の外の候補は、選んでいなければ出さない', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')

    const steps = await screen.findByRole('region', { name: copy.deepen.stepsTitle })
    expect(steps).toHaveTextContent(copy.deepen.stepsLead)
    const first = within(steps).getByRole('checkbox', { name: /オンライン秘書の体験談を 2 つ読む/ })
    expect(first).not.toBeChecked()
    expect(steps).toHaveTextContent(copy.deepen.stepHours.replace('{n}', '1'))
    expect(steps).toHaveTextContent(copy.deepen.placeValues.home)
    expect(steps).not.toHaveTextContent(copy.deepen.stepsReplaced)

    await userEvent.click(first)
    await userEvent.click(within(steps).getByRole('checkbox', { name: /募集を 3 つ読み/ }))
    await userEvent.type(within(steps).getByLabelText(copy.deepen.ownStepLabel.replace('{n}', '1')), '近所の図書館で本を借りる')
    await userEvent.click(within(steps).getByRole('button', { name: copy.deepen.stepsSave }))

    expect(await within(steps).findByText(copy.deepen.stepsSaved)).toBeInTheDocument()
    const generatedAt = fakeDeepenContent().generatedAt
    expect(puts(api.calls, '/api/deepen/steps')).toEqual([{ chosen: ['s1', 's3'], own: ['近所の図書館で本を借りる'], generatedAt }])
    expect(within(steps).getByLabelText(copy.deepen.ownStepLabel.replace('{n}', '1'))).toHaveValue('近所の図書館で本を借りる')

    // 決めずにおいてもよい（両方空で保存できる）
    await userEvent.click(first)
    await userEvent.click(within(steps).getByRole('checkbox', { name: /募集を 3 つ読み/ }))
    await userEvent.clear(within(steps).getByLabelText(copy.deepen.ownStepLabel.replace('{n}', '1')))
    await userEvent.click(within(steps).getByRole('button', { name: copy.deepen.stepsSave }))
    await waitFor(() => expect(puts(api.calls, '/api/deepen/steps')).toHaveLength(2))
    expect(puts(api.calls, '/api/deepen/steps')[1]).toEqual({ chosen: [], own: [], generatedAt })
  })

  it('deepen-3（最初の一歩は小さく）: 条件が変わって選んでいた候補が収まらなくなったら、そうと添えて残し、入れ替えたことを伝える', async () => {
    const base = fakeDeepenContent().steps
    installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: fakeDeepen({
        content: fakeDeepenContent({
          steps: [
            base[0],
            { ...base[1], fits: false, chosen: true },
            { id: 'f1', text: 'この仕事について知りたいことを書き出す', hours: 1, place: 'home', demandCheck: false, fits: true, chosen: false },
          ],
          stepsReplaced: true,
        }),
      }),
    })
    renderApp('/deepen')

    const steps = await screen.findByRole('region', { name: copy.deepen.stepsTitle })
    const outside = within(steps).getByRole('checkbox', { name: /自分の予定表を 1 週間分/ })
    expect(outside).toBeChecked()
    expect(outside.closest('li')).toHaveTextContent(copy.deepen.stepOutside)
    expect(within(steps).getByRole('checkbox', { name: /この仕事について知りたいこと/ }).closest('li')).not.toHaveTextContent(
      copy.deepen.stepOutside,
    )
    expect(steps).toHaveTextContent(copy.deepen.stepsReplaced)
    expect(within(steps).getAllByRole('checkbox')).toHaveLength(3)
  })

  it('deepen-4（創るの一歩には需要の確かめを入れる）: 需要の確かめの候補に印を付ける', async () => {
    const base = fakeDeepenContent().steps
    installFakeApi({
      loggedIn: true,
      consented: true,
      deepen: fakeDeepen({
        target: { kind: 'create', title: '習い事の送り迎えの調整の手伝い', outsideConditions: false },
        content: fakeDeepenContent({
          steps: [
            { ...base[0], id: 's1', text: '知り合いの 3 家族に、送り迎えで困っていることがあるか聞く', demandCheck: true },
            base[1],
            base[2],
          ],
        }),
      }),
    })
    renderApp('/deepen')

    // 選んだ案の欄に、需要はまだ確かめていないと添える（仕事の選択肢の画面と同じ一言）
    const target = await screen.findByRole('region', { name: copy.deepen.targetTitle })
    expect(target).toHaveTextContent(copy.options.createNotice)

    const steps = await screen.findByRole('region', { name: copy.deepen.stepsTitle })
    const demand = within(steps).getByRole('checkbox', { name: /知り合いの 3 家族に/ }).closest('li')!
    expect(demand).toHaveTextContent(copy.deepen.demandCheck)
    expect(within(steps).getAllByText(copy.deepen.demandCheck)).toHaveLength(1)
  })

  it('deepen-5（うまくいかなくても次へ）: 一歩の下に、うまくいかなかったときの受け止め方と、仕事の選択肢への道を出す', async () => {
    installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')

    const notWorking = await screen.findByRole('region', { name: copy.deepen.notWorkingTitle })
    expect(notWorking).toHaveTextContent(
      'うまくいかなかったときは、この案がいまの暮らしに合うかを確かめられた、ということです。一歩を小さくする、別の一歩を試す、仕事の選択肢に戻ってほかの案を選ぶ、のどれもできます。',
    )
    // 本人の力の話にしない。「力がない」の語は、打ち消す形でも出さない
    expect(notWorking).not.toHaveTextContent('力がない')
    expect(within(notWorking).getByRole('link', { name: copy.deepen.notWorkingLink })).toHaveAttribute('href', '/options')
    const names = regionNames()
    expect(names.indexOf(copy.deepen.stepsTitle)).toBe(names.indexOf(copy.deepen.notWorkingTitle) - 1)
  })

  it('deepen-6（仮の場面での考え方を聞く）: 選択肢を選んでも、「それ以外」から書いても答えられ、答えを残したことと力の見立てに使わないことを伝える', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')

    const questions = await screen.findByRole('region', { name: copy.deepen.questionsTitle })
    expect(questions).toHaveTextContent(copy.deepen.questionsLead)
    expect(questions).toHaveTextContent('3 人の会議の日程を決めてほしいと頼まれましたが、1 人から返事が来ません。')
    expect(within(questions).queryByText(copy.deepen.answerSaved)).not.toBeInTheDocument()

    await userEvent.click(within(questions).getByRole('button', { name: FAKE_DEEPEN_CHOICES[1] }))
    expect(await within(questions).findByText(copy.deepen.yourAnswer.replace('{text}', FAKE_DEEPEN_CHOICES[1]))).toBeInTheDocument()
    expect(within(questions).getByText(copy.deepen.answerSaved)).toBeInTheDocument()
    expect(within(questions).getByRole('button', { name: FAKE_DEEPEN_CHOICES[1] })).toHaveAttribute('aria-pressed', 'true')
    expect(within(questions).getByRole('button', { name: FAKE_DEEPEN_CHOICES[0] })).toHaveAttribute('aria-pressed', 'false')

    // 「それ以外」は、自由に書く欄に移る
    await userEvent.click(within(questions).getByRole('button', { name: copy.deepen.other }))
    const field = within(questions).getByLabelText(copy.deepen.answerLabel)
    expect(field).toHaveFocus()
    await userEvent.type(field, 'まず返事のない人に、別の連絡の手段で聞いてみる')
    await userEvent.click(within(questions).getByRole('button', { name: copy.deepen.answerSend }))
    expect(
      await within(questions).findByText(copy.deepen.yourAnswer.replace('{text}', 'まず返事のない人に、別の連絡の手段で聞いてみる')),
    ).toBeInTheDocument()

    const generatedAt = fakeDeepenContent().generatedAt
    expect(puts(api.calls, '/api/deepen/answers/q1')).toEqual([
      { text: FAKE_DEEPEN_CHOICES[1], fromChoice: true, generatedAt },
      { text: 'まず返事のない人に、別の連絡の手段で聞いてみる', fromChoice: false, generatedAt },
    ])
  })

  it('deepen-6（仮の場面での考え方を聞く）: 問いを作れなかったときは、そのことだけを伝える', async () => {
    installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent({ questions: [] }) }) })
    renderApp('/deepen')

    const questions = await screen.findByRole('region', { name: copy.deepen.questionsTitle })
    expect(questions).toHaveTextContent(copy.deepen.noQuestions)
    expect(within(questions).queryByRole('button')).not.toBeInTheDocument()
  })

  it('report-1（一つにまとめて示す）: 深める画面から可能性レポートへ行ける', async () => {
    installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')

    const link = await screen.findByRole('link', { name: copy.deepen.toReport })
    expect(link).toHaveAttribute('href', '/report')
    await userEvent.click(link)
    expect(await screen.findByRole('heading', { level: 1, name: copy.report.title })).toBeInTheDocument()
  })

  it('common-1（使わない言葉を出さない）: 深める画面の文言に、使わない言葉がない', async () => {
    const texts = flatten(copy.deepen)
    const found = ['根拠あり', '要確認', '未確認', ...forbiddenWords].flatMap((word) =>
      texts.filter((text) => text.includes(word)).map((text) => `${word}: ${text}`),
    )
    expect(found).toEqual([])

    installFakeApi({ loggedIn: true, consented: true, deepen: ownWithDrafts() })
    renderApp('/deepen')
    await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    // 「優先順位設定力」は PRD が決めた力の名前なので、この言葉だけ除いて見る
    const page = (document.body.textContent ?? '').replaceAll('優先順位', '')
    for (const word of ['根拠あり', '要確認', '未確認', ...forbiddenWords]) {
      expect(page).not.toContain(word)
    }
    expect(page).not.toMatch(/[0-9０-９]+\s*(点|位)/)
  })

  it('deepen-2（業務ごとに照らす）: まだ確かめていないことの知識や道具は、「要る知識や道具（…）」と添えて一行で出す', async () => {
    installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')

    const tasks = await screen.findByRole('region', { name: copy.deepen.tasksTitle })
    const schedule = within(tasks).getByRole('article', { name: '日程の調整' })
    expect(within(schedule).getByText('要る知識や道具（表計算）')).toBeInTheDocument()
  })

  it('deepen-5（うまくいかなくても次へ）: 仕事の選択肢へ戻る道の言葉を、画面の中で一つにそろえる', async () => {
    installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: fakeDeepenContent() }) })
    renderApp('/deepen')

    await screen.findByRole('region', { name: copy.deepen.notWorkingTitle })
    const links = screen.getAllByRole('link').filter((l) => l.getAttribute('href') === '/options')
    expect(links.length).toBeGreaterThanOrEqual(2)
    expect(new Set(links.map((l) => l.textContent))).toEqual(new Set(['仕事の選択肢へ戻る']))
  })

  it('foundation-6（使いすぎを穏やかに止める）: 深める画面で上限に当たったときは、話す画面向けの「また続きを話せます」と言わない', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true, deepen: fakeDeepen({ content: null }) })
    api.state.deepenGenerate = { status: 429, body: { type: '/problems/daily-limit', status: 429, resetAt: '2026-11-03T15:00:00Z' } }
    renderApp('/deepen')

    await userEvent.click(await screen.findByRole('button', { name: copy.deepen.generate }))

    const notice = (await screen.findByText(copy.limit.title)).parentElement!
    expect(notice).not.toHaveTextContent('また続きを話せます')
  })
})
