import { fireEvent, screen } from '@testing-library/react'
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
