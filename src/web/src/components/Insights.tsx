import { useId, type ReactNode } from 'react'
import type { EpisodeInsights, Quote } from '@/api'
import { MessageCircle, Sprout, type LucideIcon } from 'lucide-react'
import { copy } from '@/copy'

/**
 * 話し終えた場面から見えたこと（03-validate.md の「話し終えたとき」）。区切ったときに、トークの中のカードで出す。
 * 先頭に、AI の読み取りであることと、本人が直せることを添える。
 * 見えた力、もう少し聞かせてほしいことの順に出し、最後に代わりの一文を添える（「まだ聞けていない力」の名前は並べない）。中身のない見出しは出さない。
 * 見えた力は、核となる行動の文と本人の言葉を組にして出す。もう少し聞かせてほしいことは、組にせず本人の言葉と手がかりだけにする。
 * 状態の呼び名やチェック表、点数は出さない。星のような評価や格付けを思わせる印も付けず、力の名前は本人の言葉より目立たせない
 * （本人の言葉を根拠にした読み取りで、判定の結果ではないため。Claude の判断）。
 * children（読み取りを直す、続きを話す、まとめて見る）は、カードの中の最後に置く。
 */
export function Insights({ insights, children }: { insights: EpisodeInsights; children?: ReactNode }) {
  return (
    <section
      aria-label={copy.insights.cardLabel}
      className="flex min-w-0 flex-col gap-4 rounded-[18px] border border-border bg-surface px-4 py-4"
    >
      <p className="text-sm leading-relaxed text-muted-foreground">{copy.insights.lead}</p>
      {insights.seen.length > 0 && (
        <Section title={copy.insights.seenTitle} Icon={Sprout}>
          {insights.seen.map((ability) => (
            <div key={ability.key}>
              <h3 className="text-base leading-snug font-bold">{ability.name}</h3>
              <QuoteList quotes={ability.quotes} paired boxed />
            </div>
          ))}
        </Section>
      )}

      {insights.moreToHear.length > 0 && (
        <Section title={copy.insights.moreTitle} Icon={MessageCircle}>
          {insights.moreToHear.map((ability) => (
            <div key={ability.key}>
              <h3 className="text-base leading-snug font-bold">{ability.name}</h3>
              <QuoteList quotes={ability.quotes} boxed />
              <Hints hints={ability.hints} />
            </div>
          ))}
        </Section>
      )}

      <p className="text-sm leading-relaxed text-muted-foreground">
        {insights.seen.length > 0 ? copy.insights.moreNote : copy.insights.nothingYetNote}
      </p>
      {children}
    </section>
  )
}

/** カードの中の見出し。小さく、アイコンの色で出す。アイコンは、見えた力は芽、もう少し聞かせてほしいことは吹き出し。 */
function Section({ title, Icon, children }: { title: string; Icon: LucideIcon; children: ReactNode }) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="flex items-center gap-1.5 text-sm font-bold text-primary">
        <Icon aria-hidden className="size-4 shrink-0" />
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
 * boxed のときは、一つずつ入力欄の地の箱に入れる（話す画面のカードの中。モック talkend.html）。
 */
export function QuoteList({ quotes, paired = false, boxed = false }: { quotes: Quote[]; paired?: boolean; boxed?: boolean }) {
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
        <li
          key={index}
          className={
            boxed
              ? 'min-w-0 rounded-xl bg-field px-3 py-2.5 text-[15px] leading-relaxed break-words'
              : 'border-l-2 border-primary/40 pl-3 text-sm leading-relaxed break-words'
          }
        >
          {actions.length > 0 && (
            <span className={boxed ? 'block text-xs leading-relaxed text-muted-foreground' : 'block text-muted-foreground'}>
              {actions.join('、')}
            </span>
          )}
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
