import type { EpisodeSummary, NextStep } from '@/api'

/** 開いたとき（/talk）の行き先。episode はその場面、rest は会話を出さない、new は新しい場面を始める。 */
export type TalkTarget = { kind: 'episode'; id: string } | { kind: 'rest' } | { kind: 'new' }

const latest = <T>(items: T[], at: (item: T) => string): T | undefined =>
  items.reduce<T | undefined>((best, item) => (best === undefined || at(item) > at(best) ? item : best), undefined)

/**
 * 開いたときの行き先を決める（discover-12（開くとトークが出る））。
 * 1. 話している途中の場面があれば、その場面（複数なら新しく始めたほう）
 * 2. 話し終えた場面がなければ、新しく始める
 * 3. 次にできることが none（つらい状態のサインに応えたところで終わった）か、読めなかったときは、会話を出さない。
 *    読めないときは、つらい話を出さない側に倒す（Claude の判断）
 * 4. いちばん新しく話し終えた場面に、力の確かめに使わない印（つらい状態のサインに応えたことがある）があれば、会話を出さない。
 *    サインのあと「続けて話す」を選んでふつうに締めた場面も、開くたびに打ち明けた言葉を最初に見せないため（Claude の判断）
 * 5. それ以外は、いちばん新しく話し終えた場面（話し終えた時刻で比べる。なければ始めた時刻）
 */
export function chooseTalkTarget(list: EpisodeSummary[], next: NextStep | null): TalkTarget {
  const talking = latest(
    list.filter((e) => e.status === 'talking'),
    (e) => e.startedAt,
  )
  if (talking) return { kind: 'episode', id: talking.id }

  const finished = list.filter((e) => e.status === 'finished')
  if (finished.length === 0) return { kind: 'new' }

  if (next === null || next.step === 'none') return { kind: 'rest' }

  const last = latest(finished, (e) => e.finishedAt ?? e.startedAt)!
  if (last.excludedFromValidation) return { kind: 'rest' }
  return { kind: 'episode', id: last.id }
}
