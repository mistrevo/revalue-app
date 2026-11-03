import type { NextStep } from '@/api'

/**
 * 次にできることの行き先。talk はホーム（ホームの「次にできること」から新しい場面を始める）、continue はその場面、
 * conditions は 5 つの記録の条件から聞く入口。
 */
export function nextStepPath(next: NextStep): string {
  switch (next.step) {
    case 'continue':
      return next.episodeId ? `/talk/${encodeURIComponent(next.episodeId)}` : '/home'
    case 'talk':
      return '/home'
    case 'conditions':
      return '/profile?ask=conditions'
    case 'abilities':
      return '/abilities'
    case 'options':
      return '/options'
    case 'deepen':
      return '/deepen'
    case 'report':
      return '/report'
  }
}
