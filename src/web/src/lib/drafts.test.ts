import { clearAllDrafts, clearDraft, DRAFT_MAX_AGE_DAYS, pruneExpiredDrafts, readDraft, writeDraft } from './drafts'

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

const DAY = 24 * 60 * 60 * 1000

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

  it('discover-11（書きかけを残す）: 最後に書いてから 30 日を過ぎた書きかけは、読むときに捨てる', () => {
    expect(DRAFT_MAX_AGE_DAYS).toBe(30)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    writeDraft('episode-1', '家のことの話')

    vi.setSystemTime(new Date('2026-11-06T00:00:00Z').getTime() + 30 * DAY - 1)
    expect(readDraft('episode-1')).toBe('家のことの話')

    vi.setSystemTime(new Date('2026-11-06T00:00:00Z').getTime() + 30 * DAY + 1)
    expect(readDraft('episode-1')).toBe('')
    expect(localStorage.getItem('revalue.draft.episode-1')).toBeNull()
  })

  it('discover-11（書きかけを残す）: 書き足すと、書いた時刻も新しくなる', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    writeDraft('episode-1', 'あ')
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z').getTime() + 20 * DAY)
    writeDraft('episode-1', 'あい')

    vi.setSystemTime(new Date('2026-11-06T00:00:00Z').getTime() + 40 * DAY)
    expect(readDraft('episode-1')).toBe('あい')
  })

  it('discover-11（書きかけを残す）: 書いた時刻の分からない書きかけは捨てる', () => {
    localStorage.setItem('revalue.draft.episode-1', '時刻のない書きかけ')
    localStorage.setItem('revalue.draft.episode-2', JSON.stringify({ text: 'あ' }))
    expect(readDraft('episode-1')).toBe('')
    expect(readDraft('episode-2')).toBe('')
    expect(localStorage.getItem('revalue.draft.episode-1')).toBeNull()
    expect(localStorage.getItem('revalue.draft.episode-2')).toBeNull()
  })

  it('discover-11（書きかけを残す）: 開いたときに、期限を過ぎた書きかけをすべての場面から捨て、新しい書きかけと色は残す', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'))
    writeDraft('episode-old', '前に書きかけた話')
    vi.setSystemTime(new Date('2026-11-06T00:00:00Z'))
    writeDraft('episode-new', 'いま書いている話')
    localStorage.setItem('revalue.draft.episode-broken', '時刻のない書きかけ')
    localStorage.setItem('revalue.palette', 'rose')

    pruneExpiredDrafts()

    expect(localStorage.getItem('revalue.draft.episode-old')).toBeNull()
    expect(localStorage.getItem('revalue.draft.episode-broken')).toBeNull()
    expect(readDraft('episode-new')).toBe('いま書いている話')
    expect(localStorage.getItem('revalue.palette')).toBe('rose')
  })

  it('discover-11（書きかけを残す）: 残せたかどうかを返す。残せたときだけ、画面は「残っています」と伝える', () => {
    expect(writeDraft('episode-1', 'パート先に電話して、')).toBe(true)
    // 空白だけにしたら消すので、残っていない
    expect(writeDraft('episode-1', '  ')).toBe(false)

    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked')
    })
    expect(writeDraft('episode-1', 'パート先に電話して、')).toBe(false)
    expect(readDraft('episode-1')).toBe('')
  })

  it('discover-11（書きかけを残す）: 書いても読み戻せないブラウザ（保存を黙って捨てる）では、残せなかったと返す', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {})
    expect(writeDraft('episode-1', 'パート先に電話して、')).toBe(false)
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
    expect(() => pruneExpiredDrafts()).not.toThrow()
  })
})
