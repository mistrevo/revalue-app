import { useId, type ReactNode } from 'react'
import type { EpisodeInsights, Quote } from '@/api'
import { copy } from '@/copy'

/**
 * 話し終えた場面から見えたこと（03-validate.md の「話し終えたとき」）。
 * 見えた力、もう少し聞かせてほしいこと、まだ聞けていない力の順に出す。中身のない見出しは出さない。
 * 状態の呼び名やチェック表、点数は出さない。
 */
export function Insights({ insights }: { insights: EpisodeInsights }) {
  return (
    <div className="flex flex-col gap-4">
      {insights.seen.length > 0 && (
        <Section title={copy.insights.seenTitle}>
          {insights.seen.map((ability) => (
            <div key={ability.key}>
              <h3 className="text-sm font-semibold">{ability.name}</h3>
              <QuoteList quotes={ability.quotes} />
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

      {insights.notYet.length > 0 && (
        <Section title={copy.insights.notYetTitle}>
          <ul className="flex flex-wrap gap-2">
            {insights.notYet.map((ability) => (
              <li key={ability.key} className="rounded-full bg-muted px-3 py-1 text-sm">
                {ability.name}
              </li>
            ))}
          </ul>
          <p className="text-sm leading-relaxed text-muted-foreground">{copy.insights.notYetNote}</p>
        </Section>
      )}
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
 * 同じ言葉が複数の行動の根拠になっていても、一度だけ出す（行動のチェック表に見せないため。Claude の判断）。
 */
export function QuoteList({ quotes }: { quotes: Quote[] }) {
  const unique = quotes.filter(
    (quote, index) =>
      quotes.findIndex(
        (other) => other.text === quote.text && other.fromChoice === quote.fromChoice && (other.linkedText ?? null) === (quote.linkedText ?? null),
      ) === index,
  )
  if (unique.length === 0) return null
  return (
    <ul className="mt-2 flex flex-col gap-2">
      {unique.map((quote, index) => (
        <li key={index} className="border-l-2 border-primary/40 pl-3 text-sm leading-relaxed break-words">
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

/** 足りない行動の手がかり。 */
export function Hints({ hints }: { hints: string[] }) {
  if (hints.length === 0) return null
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
