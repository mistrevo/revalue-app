import { createContext, useContext } from 'react'
import type { Me } from '@/api'

export const MeContext = createContext<Me | null>(null)

/** RequireUser の中で、ログインした人の了解の状態を受け取る。 */
export function useMe(): Me {
  const me = useContext(MeContext)
  if (me === null) {
    throw new Error('useMe は RequireUser の中で使う')
  }
  return me
}
