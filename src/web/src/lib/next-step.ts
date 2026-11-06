import type { NextStep, NextStepKind } from '@/api'

/**
 * 次にできることの行き先。continue はその場面、conditions は 5 つの記録の条件から聞く入口。
 * talk は行き先の画面がない（その場で新しい場面を始める。useStartEpisode）ので null。
 * none（何も勧めない）は、呼ぶ前に除く。
 */
export function nextStepPath(next: NextStep & { step: Exclude<NextStepKind, 'none'> }): string | null {
  switch (next.step) {
    case 'continue':
      return next.episodeId ? `/talk/${encodeURIComponent(next.episodeId)}` : '/talk'
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
