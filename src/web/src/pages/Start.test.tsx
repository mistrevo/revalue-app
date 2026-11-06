import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOGOUT_URL } from '@/api'
import { copy } from '@/copy'
import { readDraft, writeDraft } from '@/lib/drafts'
import { FAKE_OPENING, installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Start', () => {
  it('foundation-2（始める前に保存するものを示す）: はじめにの画面に 5 つの項目が出る', async () => {
    const api = installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    const titles = ['保存するもの', '保存しないもの', '使い道', '保存期間', 'いつでも全部消せます']
    for (const title of titles) {
      expect(screen.getByRole('heading', { name: title })).toBeInTheDocument()
    }
    const use = copy.start.items.find((item) => item.title === '使い道')!
    expect(use.body).toContain('Claude')
    expect(use.body).toContain('開発者も')
    expect(screen.getByText(use.body)).toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: copy.start.agree }))

    // 了解したら、話す画面の最初の問いへ進む
    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    const posts = api.calls.filter((call) => call.method === 'POST')
    // 了解を記録してから、最初の場面を一つだけ作る
    expect(posts).toEqual([
      { method: 'POST', url: '/api/consent', body: { version: api.currentVersion } },
      { method: 'POST', url: '/api/episodes', body: undefined },
    ])
  })

  it('foundation-2（始める前に保存するものを示す）: 4 行の要約が先に出て、5 項目の全文は「くわしく読む」の中にある', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    for (const line of copy.start.summary) expect(await screen.findByText(line)).toBeInTheDocument()
    const more = screen.getByText(copy.start.more).closest('details')!
    expect(more).not.toHaveAttribute('open')
    for (const item of copy.start.items) {
      expect(within(more).getByText(item.body)).toBeInTheDocument()
      expect(within(more).getByRole('heading', { name: item.title })).toBeInTheDocument()
    }
    expect(screen.getByText(copy.start.afterAgree)).toBeInTheDocument()
  })

  it('foundation-2（始める前に保存するものを示す）: 「くわしく読む」には開く印（下向きの矢印）があり、開くと向きが変わる', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    const summary = (await screen.findByText(copy.start.more)).closest('summary')!
    const icon = summary.querySelector('svg')
    expect(icon).not.toBeNull()
    expect(icon).toHaveAttribute('aria-hidden', 'true')
    expect(icon).toHaveClass('group-open:rotate-180')
    // ブラウザの開閉の三角は消しているので、矢印が唯一の印になる
    expect(summary).toHaveClass('text-primary')
  })

  it('foundation-2（始める前に保存するものを示す）: 4 行の要約だけで、全文より狭く言い切らず、共用の端末で書きかけが見えうることも了解の前に分かる', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    const more = (await screen.findByText(copy.start.more)).closest('details')!
    const outside = copy.start.summary.filter((line) => !more.contains(screen.getByText(line)))
    expect(outside).toEqual(copy.start.summary)
    const [kept, notKept, ai] = copy.start.summary
    // 残すもの: 全文の「保存するもの」にある仕組みのための記録も挙げる
    for (const word of ['話した内容', 'ID', '了解した日時', '回数']) expect(kept).toContain(word)
    // 残さないもの: 書きかけはこの端末にだけ残り、同じ端末を使う人に見えることがある
    expect(notKept).toContain('書きかけ')
    expect(notKept).toContain('この端末')
    expect(notKept).toContain('同じ端末を使う人')
    // AI に送るとき: 全文の「使い道」と同じ場面を挙げる
    for (const word of ['返事', '見立て', '仕事の選択肢', '深める', 'Claude', '開発者も']) expect(ai).toContain(word)
  })

  it('foundation-2（始める前に保存するものを示す）: まだ見たことのない製品の言葉には、普通の言葉を添える', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    const saved = copy.start.items.find((item) => item.title === '保存するもの')!
    expect(saved.body).toContain('5 つの記録（できること、好み、やりたいこと、条件、動き出すときに大事にしたいこと）')
    expect(saved.body).toMatch(/可能性レポート（[^）]+）/)
    expect(screen.getByText(saved.body)).toBeInTheDocument()
  })

  it('foundation-2（始める前に保存するものを示す）: 書きかけの答えがこの端末のブラウザにだけ残ることと、消えるときを示す', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    const notSaved = copy.start.items.find((item) => item.title === '保存しないもの')!
    expect(notSaved.body).toContain('書きかけ')
    expect(notSaved.body).toContain('この端末のブラウザにだけ')
    for (const when of ['送る', '区切る', '飛ばす', '全部消す', 'ログアウト', '30 日']) {
      expect(notSaved.body).toContain(when)
    }
    // 家族と共用する端末では、次に開いた人の目に入りうることも、了解する前に伝える
    expect(notSaved.body).toContain('ほかの人も使う')
    expect(screen.getByText(notSaved.body)).toBeInTheDocument()
  })

  it('foundation-3（いつでも全部消せる）: 全部消したあとでなければ、消したことは伝えない', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    expect(screen.queryByText(copy.settings.deleted)).not.toBeInTheDocument()
  })

  it('foundation-2（始める前に保存するものを示す）: 了解していない人が話す画面を開くと、はじめにへ進む', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/talk')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    expect(screen.queryByText(FAKE_OPENING)).not.toBeInTheDocument()
  })

  it('foundation-2（始める前に保存するものを示す）: 前の版で了解した人は、了解の要る API を使わずに「はじめに」へ進み、書きかけのことを読んでから、いまの版で了解し直す', async () => {
    // 「保存しないもの」に書きかけのことを足して版を上げたので、前の版の了解は了解していない扱い（裏側は 403 を返す）
    const api = installFakeApi({ loggedIn: true, consented: false, consentVersion: '2026-11-03-2' })
    expect(api.currentVersion).not.toBe('2026-11-03-2')
    renderApp('/talk/episode-1')

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    const notSaved = copy.start.items.find((item) => item.title === '保存しないもの')!
    expect(screen.getByText(notSaved.body)).toBeInTheDocument()
    expect(notSaved.body).toContain('書きかけ')
    // 了解し直すまでは、了解の状態を読むだけで、了解の要る API を呼ばない
    expect(api.calls.filter((call) => call.url !== '/api/me')).toEqual([])

    await userEvent.click(screen.getByRole('button', { name: copy.start.agree }))

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
    expect(api.calls.find((call) => call.method === 'POST' && call.url === '/api/consent')?.body).toEqual({
      version: api.currentVersion,
    })
  })

  it('foundation-2（始める前に保存するものを示す）: 了解していない人に、了解の要る API は 403 を返す（偽物も裏側と同じ）', async () => {
    const api = installFakeApi({ loggedIn: true, consented: false, consentVersion: '2026-11-03-2' })

    const me = await fetch('/api/me').then((response) => response.json())
    expect(me).toEqual({ consented: false, consentVersion: '2026-11-03-2', currentVersion: api.currentVersion })
    for (const url of ['/api/episodes', '/api/next-step']) {
      const response = await fetch(url)
      expect(response.status).toBe(403)
      expect(await response.json()).toMatchObject({ type: '/problems/consent-required' })
    }
  })

  it('foundation-2（始める前に保存するものを示す）: 了解済みの人がはじめにを開くと、話す画面へ進む', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/start')

    expect(await screen.findByText(FAKE_OPENING)).toBeInTheDocument()
  })

  it('foundation-2（始める前に保存するものを示す）: 了解の記録に失敗したら穏やかに伝え、先へ進まない', async () => {
    const api = installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')
    await screen.findByRole('heading', { level: 1, name: copy.start.title })

    api.fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
    await userEvent.click(screen.getByRole('button', { name: copy.start.agree }))

    expect(await screen.findByText(copy.errors.generic)).toBeInTheDocument()
    expect(screen.queryByText(FAKE_OPENING)).not.toBeInTheDocument()
  })

  it('foundation-2（始める前に保存するものを示す）: 了解せずにやめる道（ログアウト）があり、組み込み認証へページごと移動する', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    const decline = await screen.findByRole('link', { name: copy.start.decline })
    expect(decline.tagName).toBe('A')
    expect(decline).toHaveAttribute('href', LOGOUT_URL)
    expect(copy.start.decline).toBe('了解せずにやめる（ログアウト）')
  })

  it('discover-11（書きかけを残す）: 了解せずにやめる（ログアウト）でも、その端末の書きかけがすべて消える', async () => {
    // 保存期間が過ぎてサーバーのデータが消えたあとや、了解の版が変わったあとにも、書きかけが端末に残っていることがある
    installFakeApi({ loggedIn: true, consented: false })
    writeDraft('episode-old', '前に書きかけた話')
    renderApp('/start')

    const decline = await screen.findByRole('link', { name: copy.start.decline })
    // テストの中では、ページごとの移動はしない
    const stay = (event: MouseEvent) => event.preventDefault()
    document.addEventListener('click', stay)
    fireEvent.click(decline)
    document.removeEventListener('click', stay)

    expect(readDraft('episode-old')).toBe('')
  })

  it('foundation-2（始める前に保存するものを示す）: 使い道に、選んだ案を深めるときも AI に送ることが入る', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/start')

    await screen.findByRole('heading', { level: 1, name: copy.start.title })
    const use = copy.start.items.find((item) => item.title === '使い道')!
    expect(use.body).toContain('選んだ案を深める')
    expect(use.body).toContain('選んだ案')
    expect(use.body).toContain('5 つの記録')
  })
})
