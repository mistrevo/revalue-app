import { Link } from 'react-router'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'

/** ホーム。このまとまりでは、あいさつと設定へのリンクだけを置く。「話す」の入口は 02 discover で足す。 */
export function Home() {
  return (
    <Page>
      <h1 className="text-xl leading-relaxed font-bold">{copy.home.greeting}</h1>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
          <Link to="/settings">{copy.home.settingsLink}</Link>
        </Button>
      </div>
    </Page>
  )
}
