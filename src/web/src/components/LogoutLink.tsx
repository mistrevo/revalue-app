import type { AnchorHTMLAttributes } from 'react'
import { LOGOUT_URL } from '@/api'
import { clearAllDrafts } from '@/lib/drafts'

/**
 * ログアウトへの道。組み込み認証へページごと移動する。どこから押しても、その端末のブラウザに残した書きかけをすべて消す
 * （discover-11（書きかけを残す））。ログアウトへの道は、すべてこの部品を通す。
 */
export function LogoutLink({ onClick, ...props }: Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a
      {...props}
      href={LOGOUT_URL}
      onClick={(event) => {
        clearAllDrafts()
        onClick?.(event)
      }}
    />
  )
}
