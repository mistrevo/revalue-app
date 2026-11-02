import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOGOUT_URL } from '@/api'
import { copy } from '@/copy'
import { installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
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
})
