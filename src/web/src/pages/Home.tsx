import { Link } from 'react-router'
import { Page } from '@/components/Page'
import { Button } from '@/components/ui/button'
import { copy } from '@/copy'

/** ホーム。このまとまりでは、あいさつと設定へのリンクだけを置く。「話す」の入口は 02 discover で足す。 */
export function Home() {
  return (
    <Page>
      <p className="text-lg leading-relaxed font-medium">{copy.home.greeting}</p>
      <div className="mt-6 flex flex-col gap-3 sm:flex-row">
        <Button size="lg" disabled className="w-full sm:w-auto">
          {copy.home.talk}
        </Button>
        <Button asChild variant="outline" size="lg" className="w-full sm:w-auto">
          <Link to="/settings">{copy.home.settingsLink}</Link>
        </Button>
      </div>
    </Page>
  )
}
