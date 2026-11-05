import { useId, type ReactNode } from 'react'
import type { EpisodeInsights, Quote } from '@/api'
import { copy } from '@/copy'

/**
 * 話し終えた場面から見えたこと（03-validate.md の「話し終えたとき」）。
 * 先頭に、AI の読み取りであることと、本人が直せることを添える。
 * 見えた力、もう少し聞かせてほしいことの順に出し、最後に代わりの一文を添える（「まだ聞けていない力」の名前は並べない）。中身のない見出しは出さない。
 * 見えた力は、核となる行動の文と本人の言葉を組にして出す。もう少し聞かせてほしいことは、組にせず本人の言葉と手がかりだけにする。
 * 状態の呼び名やチェック表、点数は出さない。
 */
export function Insights({ insights }: { insights: EpisodeInsights }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm leading-relaxed text-muted-foreground">{copy.insights.lead}</p>
      {insights.seen.length > 0 && (
        <Section title={copy.insights.seenTitle}>
          {insights.seen.map((ability) => (
            <div key={ability.key}>
              <h3 className="text-sm font-semibold">{ability.name}</h3>
              <QuoteList quotes={ability.quotes} paired />
            </div>
          ))}
        </Section>
      )}

      {insights.moreToHear.length > 0 && (
        <Section title={copy.insights.moreTitle}>
          {insights.moreToHear.map((ability) => (
            <div key={ability.key}>
              <h3 className="text-sm font-semibold">{ability.name}</h3>
              <QuoteList quotes={ability.quotes} />
              <Hints hints={ability.hints} />
            </div>
          ))}
        </Section>
      )}

      <p className="text-sm leading-relaxed text-muted-foreground">
        {insights.seen.length > 0 ? copy.insights.moreNote : copy.insights.nothingYetNote}
      </p>
    </div>
  )
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3 rounded-xl border px-4 py-4">
      <h2 id={id} className="text-base font-bold">
        {title}
      </h2>
      {children}
    </section>
  )
}

/**
 * 根拠の本人の言葉。「」で囲み、一字一句そのまま出す。選んだ答えには印を付け、結びついた本人の言葉を並べる。
 * 同じ言葉が複数の行動の根拠になっていても、言葉は一度だけ出す（行動のチェック表に見せないため。Claude の判断）。
 * paired のときは、見えた力の根拠として、核となる行動の文を本人の言葉の上に添えて組にする。同じ言葉が複数の行動の根拠なら、
 * 行動の文を「、」でつなぐ。チェックの印、番号、そろった数は出さない。確かめ中の力は paired にしない
 * （そろった行動とそろっていない行動を並べるとチェック表に見えるため）。
 */
export function QuoteList({ quotes, paired = false }: { quotes: Quote[]; paired?: boolean }) {
  const groups: { quote: Quote; actions: string[] }[] = []
  for (const quote of quotes) {
    const same = groups.find(
      (g) =>
        g.quote.text === quote.text &&
        g.quote.fromChoice === quote.fromChoice &&
        (g.quote.linkedText ?? null) === (quote.linkedText ?? null),
    )
    const action = paired ? (quote.action ?? null) : null
    if (same) {
      if (action && !same.actions.includes(action)) same.actions.push(action)
    } else {
      groups.push({ quote, actions: action ? [action] : [] })
    }
  }
  if (groups.length === 0) return null
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {groups.map(({ quote, actions }, index) => (
        <li key={index} className="border-l-2 border-primary/40 pl-3 text-sm leading-relaxed break-words">
          {actions.length > 0 && <span className="block text-muted-foreground">{actions.join('、')}</span>}
          <span>{`「${quote.text}」`}</span>
          {quote.fromChoice && (
            <>
              <span className="text-muted-foreground">{copy.insights.chosen}</span>
              {quote.linkedText && <span className="block">{`「${quote.linkedText}」`}</span>}
            </>
          )}
        </li>
      ))}
    </ul>
  )
}

/** 足りない行動の手がかり。添える手がかりがなければ、聞き返さずに続きを話せることだけを伝える。 */
export function Hints({ hints }: { hints: string[] }) {
  if (hints.length === 0) {
    return <p className="mt-3 text-sm leading-relaxed text-muted-foreground">{copy.insights.noHint}</p>
  }
  return (
    <div className="mt-3 rounded-lg bg-muted/50 px-3 py-2 text-sm leading-relaxed">
      <p className="text-muted-foreground">{copy.insights.hintLead}</p>
      <ul className="mt-1 list-disc pl-5">
        {hints.map((hint) => (
          <li key={hint}>{hint}</li>
        ))}
      </ul>
    </div>
  )
}
