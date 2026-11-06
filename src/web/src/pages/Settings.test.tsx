import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOGOUT_URL } from '@/api'
import { copy } from '@/copy'
import { installFakeApi } from '@/test/fake-api'
import { readDraft, writeDraft } from '@/lib/drafts'
import { PALETTE_STORAGE_KEY } from '@/lib/palette'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
  localStorage.clear()
})

describe('Settings', () => {
  it('foundation-3（いつでも全部消せる）: もう一度確かめてから消し、はじめにへ進む', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    const confirmSpy = vi.spyOn(window, 'confirm')
    renderApp('/settings')

    const deletes = () => api.calls.filter((call) => call.method === 'DELETE')
    await userEvent.click(await screen.findByRole('button', { name: copy.settings.deleteButton }))
    expect(deletes()).toHaveLength(0)
    expect(screen.getByText(copy.settings.confirmQuestion)).toBeInTheDocument()

    // やめると、消さずに元に戻る
    await userEvent.click(screen.getByRole('button', { name: copy.settings.confirmNo }))
    expect(screen.queryByText(copy.settings.confirmQuestion)).not.toBeInTheDocument()
    expect(deletes()).toHaveLength(0)

    await userEvent.click(screen.getByRole('button', { name: copy.settings.deleteButton }))
    await userEvent.click(screen.getByRole('button', { name: copy.settings.confirmYes }))

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    expect(deletes()).toEqual([{ method: 'DELETE', url: '/api/me', body: undefined }])
    expect(confirmSpy).not.toHaveBeenCalled()
    // 消し終えたことと、また始められることを伝える
    expect(screen.getByRole('status')).toHaveTextContent(copy.settings.deleted)
  })

  it('foundation-3（いつでも全部消せる）: 了解していなくても設定を開いて消せる', async () => {
    installFakeApi({ loggedIn: true, consented: false })
    renderApp('/settings')

    expect(await screen.findByRole('button', { name: copy.settings.deleteButton })).toBeInTheDocument()
  })

  it('foundation-3（いつでも全部消せる）: 消せなかったら穏やかに伝え、画面に残る', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    renderApp('/settings')

    await userEvent.click(await screen.findByRole('button', { name: copy.settings.deleteButton }))
    api.fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
    await userEvent.click(screen.getByRole('button', { name: copy.settings.confirmYes }))

    expect(await screen.findByText(copy.errors.generic)).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: copy.settings.title })).toBeInTheDocument()
  })

  it('foundation-3（いつでも全部消せる）: ログアウトは素のリンク', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/settings')

    const logout = await screen.findByRole('link', { name: copy.settings.logout })
    expect(logout).toHaveAttribute('href', LOGOUT_URL)
  })

  it('foundation-3（いつでも全部消せる）: 全部消すと、その端末の書きかけも消える', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    writeDraft('episode-1', 'あ')
    renderApp('/settings')

    await userEvent.click(await screen.findByRole('button', { name: copy.settings.deleteButton }))
    await userEvent.click(screen.getByRole('button', { name: copy.settings.confirmYes }))

    expect(await screen.findByRole('heading', { level: 1, name: copy.start.title })).toBeInTheDocument()
    expect(readDraft('episode-1')).toBe('')
  })

  it('foundation-3（いつでも全部消せる）: 消せなかったら、書きかけも残す', async () => {
    const api = installFakeApi({ loggedIn: true, consented: true })
    writeDraft('episode-1', 'あ')
    renderApp('/settings')

    await userEvent.click(await screen.findByRole('button', { name: copy.settings.deleteButton }))
    api.fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }))
    await userEvent.click(screen.getByRole('button', { name: copy.settings.confirmYes }))

    expect(await screen.findByText(copy.errors.generic)).toBeInTheDocument()
    expect(readDraft('episode-1')).toBe('あ')
  })

  it('foundation-3（いつでも全部消せる）: ログアウトすると、その端末の書きかけも消える', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    writeDraft('episode-1', 'あ')
    renderApp('/settings')

    const logout = await screen.findByRole('link', { name: copy.settings.logout })
    // テストの中では、ページごとの移動はしない
    const stay = (event: MouseEvent) => event.preventDefault()
    document.addEventListener('click', stay)
    fireEvent.click(logout)
    document.removeEventListener('click', stay)

    expect(readDraft('episode-1')).toBe('')
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 了解した人の設定には「トークに戻る」がある', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/settings')

    expect(await screen.findByRole('link', { name: copy.nav.backToTalk })).toHaveAttribute('href', '/talk')
  })

  it('common-5（どの色でも読める）: 設定の画面で 6 色から選べ、選ぶとすぐに変わり、開き直しても選んだ色が選ばれている', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    const { unmount } = renderApp('/settings')
    const group = await screen.findByRole('radiogroup', { name: copy.settings.colorTitle })
    expect(within(group).getAllByRole('radio')).toHaveLength(6)
    await userEvent.click(within(group).getByRole('radio', { name: 'さくら' }))
    expect(document.documentElement.dataset.palette).toBe('rose')
    // 開き直したときの選択は、この端末に残した値から出る
    expect(localStorage.getItem(PALETTE_STORAGE_KEY)).toBe('rose')
    unmount()
    renderApp('/settings')
    expect(await screen.findByRole('radio', { name: 'さくら' })).toHaveAttribute('aria-checked', 'true')
  })

  it('common-4（どの画面からもトークへ戻れ、幅に収まる）: 色の札は、幅 360px 未満では 2 列、それ以上では 3 列に並べ、色の名前を途中で折り返さない', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/settings')

    const group = await screen.findByRole('radiogroup', { name: copy.settings.colorTitle })
    // 「あおみどり」は札の中に 69px ほど要る。6 列（PC）と、幅 320px の 3 列では 58〜59px しかなく、「あおみど／り」と折り返す
    expect(group).toHaveClass('grid-cols-2', 'min-[360px]:grid-cols-3')
    expect(group.className).not.toMatch(/grid-cols-6/)
  })

  it('common-5（どの色でも読める）: 矢印キーで色を動かせる', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/settings')
    const first = await screen.findByRole('radio', { name: 'あおみどり' })
    await userEvent.click(first)
    await userEvent.keyboard('{ArrowRight}')
    expect(screen.getByRole('radio', { name: 'さくら' })).toHaveAttribute('aria-checked', 'true')
  })
})
