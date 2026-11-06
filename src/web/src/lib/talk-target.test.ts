import { describe, expect, it } from 'vitest'
import type { EpisodeSummary } from '@/api'
import { chooseTalkTarget } from './talk-target'

const s = (o: Partial<EpisodeSummary>): EpisodeSummary => ({
  id: 'e',
  status: 'finished',
  startedAt: '2026-11-01T00:00:00Z',
  finishedAt: '2026-11-01T01:00:00Z',
  userTurnCount: 1,
  preview: '',
  canResume: false,
  ...o,
})

describe('chooseTalkTarget', () => {
  it('discover-12（開くとトークが出る）: 話している途中の場面があれば、その場面', () => {
    expect(
      chooseTalkTarget([s({ id: 'a' }), s({ id: 'b', status: 'talking', finishedAt: null })], { step: 'continue', episodeId: 'b' }),
    ).toEqual({ kind: 'episode', id: 'b' })
  })

  it('discover-12（開くとトークが出る）: 話している途中の場面が 2 つあれば、新しく始めたほう', () => {
    const list = [
      s({ id: 'old', status: 'talking', finishedAt: null, startedAt: '2026-11-01T00:00:00Z' }),
      s({ id: 'new', status: 'talking', finishedAt: null, startedAt: '2026-11-02T00:00:00Z' }),
    ]
    expect(chooseTalkTarget(list, null)).toEqual({ kind: 'episode', id: 'new' })
  })

  it('discover-12（開くとトークが出る）: 場面がなければ、新しく始める', () => {
    expect(chooseTalkTarget([], { step: 'talk', episodeId: null })).toEqual({ kind: 'new' })
  })

  it('discover-12（開くとトークが出る）: 場面がなければ、次にできることを読めなくても新しく始める', () => {
    expect(chooseTalkTarget([], null)).toEqual({ kind: 'new' })
  })

  it('discover-12（開くとトークが出る）: 続きを話して後から区切った古い場面も、話し終えた時刻で選ぶ', () => {
    const list = [
      s({ id: 'newer', startedAt: '2026-11-03T00:00:00Z', finishedAt: '2026-11-03T01:00:00Z' }),
      s({ id: 'resumed', startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-04T00:00:00Z' }),
    ]
    expect(chooseTalkTarget(list, { step: 'options', episodeId: null })).toEqual({ kind: 'episode', id: 'resumed' })
  })

  it('discover-12（開くとトークが出る）: 話し終えた時刻がない場面は、始めた時刻で比べる', () => {
    const list = [
      s({ id: 'a', startedAt: '2026-11-02T00:00:00Z', finishedAt: null }),
      s({ id: 'b', startedAt: '2026-11-01T00:00:00Z', finishedAt: '2026-11-01T05:00:00Z' }),
    ]
    expect(chooseTalkTarget(list, { step: 'report', episodeId: null })).toEqual({ kind: 'episode', id: 'a' })
  })

  it('discover-10（つらい状態のサインに応える）: いちばん新しい場面がつらい状態のサインで終わっていたら、その会話を出さない', () => {
    expect(chooseTalkTarget([s({ id: 'a' })], { step: 'none', episodeId: null })).toEqual({ kind: 'rest' })
  })

  it('discover-10（つらい状態のサインに応える）: 次にできることを読めなかったら、つらい話を出さない側に倒す', () => {
    expect(chooseTalkTarget([s({ id: 'a' })], null)).toEqual({ kind: 'rest' })
  })
})
