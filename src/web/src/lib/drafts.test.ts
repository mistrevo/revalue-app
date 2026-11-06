import { clearAllDrafts, clearDraft, readDraft, writeDraft } from './drafts'

afterEach(() => localStorage.clear())

describe('drafts', () => {
  it('discover-11（書きかけを残す）: 場面ごとに残り、読み直せる', () => {
    writeDraft('episode-1', 'パート先に電話して、')
    writeDraft('episode-2', '別の話')
    expect(readDraft('episode-1')).toBe('パート先に電話して、')
    expect(readDraft('episode-3')).toBe('')
  })

  it('discover-11（書きかけを残す）: 空白だけにしたら消える', () => {
    writeDraft('episode-1', 'あ')
    writeDraft('episode-1', '  ')
    expect(localStorage.getItem('revalue.draft.episode-1')).toBeNull()
  })

  it('discover-11（書きかけを残す）: 1 つの場面の書きかけだけを消せる', () => {
    writeDraft('episode-1', 'あ')
    writeDraft('episode-2', 'い')
    clearDraft('episode-1')
    expect(readDraft('episode-1')).toBe('')
    expect(readDraft('episode-2')).toBe('い')
  })

  it('discover-11（書きかけを残す）: 全部消すと書きかけだけが消え、色は残る', () => {
    writeDraft('episode-1', 'あ')
    localStorage.setItem('revalue.palette', 'rose')
    clearAllDrafts()
    expect(readDraft('episode-1')).toBe('')
    expect(localStorage.getItem('revalue.palette')).toBe('rose')
  })

  it('discover-11（書きかけを残す）: 保存できないブラウザでも投げない', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(() => writeDraft('episode-1', 'あ')).not.toThrow()
    expect(readDraft('episode-1')).toBe('')
    expect(() => clearDraft('episode-1')).not.toThrow()
    expect(() => clearAllDrafts()).not.toThrow()
  })
})
