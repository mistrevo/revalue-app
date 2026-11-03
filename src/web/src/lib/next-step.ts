import type { NextStep } from '@/api'

/**
 * 次にできることの行き先。continue はその場面、conditions は 5 つの記録の条件から聞く入口。
 * talk は行き先の画面がない（その場で新しい場面を始める。useStartEpisode）ので null。
 */
export function nextStepPath(next: NextStep): string | null {
  switch (next.step) {
    case 'continue':
      return next.episodeId ? `/talk/${encodeURIComponent(next.episodeId)}` : '/home'
    case 'talk':
      return null
    case 'conditions':
      return '/profile?ask=conditions'
    case 'options':
      return '/options'
    case 'deepen':
      return '/deepen'
    case 'report':
      return '/report'
  }
}
