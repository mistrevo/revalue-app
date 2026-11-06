import { Briefcase, ChevronDown, ChevronUp, ClipboardList, FileText, MessageSquareText, SlidersHorizontal, Sprout } from 'lucide-react'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { copy } from '@/copy'

/** メニュー板のタイル。選んだ案を深める画面はタイルにしない（仕事の選択肢と次にできることから行く。Claude の判断）。 */
const TILES = [
  { to: '/episodes', label: copy.menu.episodes, Icon: MessageSquareText },
  // 星は評価や格付けを思わせるので使わない（Claude の判断）
  { to: '/abilities', label: copy.menu.abilities, Icon: Sprout },
  { to: '/profile', label: copy.menu.profile, Icon: ClipboardList },
  { to: '/options', label: copy.menu.options, Icon: Briefcase },
  { to: '/report', label: copy.menu.report, Icon: FileText },
  { to: '/settings', label: copy.menu.settings, Icon: SlidersHorizontal },
] as const

/**
 * トークの下（スマホ）か右（PC）に置くメニュー板（discover-12（開くとトークが出る））。
 * bottom は初めたたんだ形で出し、押すと 3 列 2 段のタイルを開く。開いたかどうかは覚えない（Claude の判断）。
 * side はたたまず、いつもタイルを縦に並べる。
 */
export function MenuBoard({ variant, hidden = false }: { variant: 'bottom' | 'side'; hidden?: boolean }) {
  const [open, setOpen] = useState(false)
  const tilesId = useId()

  if (variant === 'side') {
    return (
      <nav aria-label={copy.menu.label} className="rounded-2xl border border-border bg-surface p-3">
        <ul className="flex flex-col gap-2">
          {TILES.map((tile) => (
            <li key={tile.to}>
              <Tile {...tile} row />
            </li>
          ))}
        </ul>
      </nav>
    )
  }

  return (
    <nav
      aria-label={copy.menu.label}
      hidden={hidden}
      className="border-t border-border bg-surface px-3 pb-[max(0.5rem,env(safe-area-inset-bottom))]"
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={tilesId}
        onClick={() => setOpen((value) => !value)}
        className="flex min-h-11 w-full items-center justify-center gap-1.5 rounded-lg text-sm font-bold text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span>{open ? copy.menu.close : copy.menu.open}</span>
        {open ? <ChevronDown aria-hidden className="size-4" /> : <ChevronUp aria-hidden className="size-4" />}
      </button>
      {open && (
        <ul id={tilesId} className="grid grid-cols-3 gap-2 pb-2">
          {TILES.map((tile) => (
            <li key={tile.to} className="min-w-0">
              <Tile {...tile} />
            </li>
          ))}
        </ul>
      )}
    </nav>
  )
}

function Tile({ to, label, Icon, row = false }: (typeof TILES)[number] & { row?: boolean }) {
  return (
    <Link
      to={to}
      className={
        row
          ? 'flex min-h-12 items-center gap-3 rounded-xl bg-tile px-3 py-2 font-bold text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
          : 'flex min-h-16 flex-col items-center justify-center gap-1 rounded-xl bg-tile px-1 py-2 text-center text-sm font-bold break-words text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50'
      }
    >
      <Icon aria-hidden className="size-6 shrink-0 text-primary" />
      <span className="min-w-0">{label}</span>
    </Link>
  )
}
