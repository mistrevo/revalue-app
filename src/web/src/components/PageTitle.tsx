import { useEffect, type ReactNode } from 'react'
import { copy } from '@/copy'

/**
 * ページのタイトル（ブラウザのタブに出る）を画面ごとに変える。「話す — RE:VALUE」の形にする。
 * title がなければ（案内）、案内の見出しと同じ「RE:VALUE（リバリュー）」にする。
 */
export function PageTitle({ title, children }: { title?: string; children: ReactNode }) {
  useEffect(() => {
    document.title = title ? `${title} — ${copy.nav.appName}` : copy.landing.title
  }, [title])
  return children
}
