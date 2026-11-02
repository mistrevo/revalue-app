import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { installFakeApi } from '@/test/fake-api'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Home', () => {
  it('foundation-2（始める前に保存するものを示す）: 了解した人にはホームが出て、設定へ進める', async () => {
    installFakeApi({ loggedIn: true, consented: true })
    renderApp('/home')

    expect(await screen.findByText(copy.home.greeting)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: copy.home.settingsLink })).toHaveAttribute('href', '/settings')
  })
})
