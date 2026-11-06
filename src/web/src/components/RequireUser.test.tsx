import { screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copy } from '@/copy'
import { renderApp } from '@/test/render-app'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('RequireUser', () => {
  it('foundation-1（案内はログインなしで見られる）: つながらないときは穏やかに伝える', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 500 })))
    renderApp('/talk')

    expect(await screen.findByText(copy.errors.generic)).toBeInTheDocument()
  })
})
