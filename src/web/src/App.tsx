import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { PageTitle } from '@/components/PageTitle'
import { RequireUser } from '@/components/RequireUser'
import { copy } from '@/copy'
import { Abilities } from '@/pages/Abilities'
import { Deepen } from '@/pages/Deepen'
import { Episodes } from '@/pages/Episodes'
import { Home } from '@/pages/Home'
import { Landing } from '@/pages/Landing'
import { Options } from '@/pages/Options'
import { Profile } from '@/pages/Profile'
import { Report } from '@/pages/Report'
import { Settings } from '@/pages/Settings'
import { Start } from '@/pages/Start'
import { Talk } from '@/pages/Talk'

/**
 * 画面の切り替え。/.auth/* はここに置かない（組み込み認証へページごと移動するため）。
 * RequireUser には画面ごとに key を付け、画面が変わるたびにログインと了解の状態を読み直す。
 */
export function AppRoutes() {
  return (
    <Routes>
      <Route
        path="/"
        element={
          <PageTitle>
            <Landing />
          </PageTitle>
        }
      />
      <Route
        path="/start"
        element={
          <PageTitle title={copy.titles.start}>
            <RequireUser key="start">
              <Start />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/home"
        element={
          <PageTitle title={copy.titles.home}>
            <RequireUser key="home" consent>
              <Home />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/talk/:id"
        element={
          <PageTitle title={copy.titles.talk}>
            <RequireUser key="talk" consent>
              <Talk />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/episodes"
        element={
          <PageTitle title={copy.titles.episodes}>
            <RequireUser key="episodes" consent>
              <Episodes />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/abilities"
        element={
          <PageTitle title={copy.titles.abilities}>
            <RequireUser key="abilities" consent>
              <Abilities />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/profile"
        element={
          <PageTitle title={copy.titles.profile}>
            <RequireUser key="profile" consent>
              <Profile />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/options"
        element={
          <PageTitle title={copy.titles.options}>
            <RequireUser key="options" consent>
              <Options />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/deepen"
        element={
          <PageTitle title={copy.titles.deepen}>
            <RequireUser key="deepen" consent>
              <Deepen />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/report"
        element={
          <PageTitle title={copy.titles.report}>
            <RequireUser key="report" consent>
              <Report />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route
        path="/settings"
        element={
          <PageTitle title={copy.titles.settings}>
            <RequireUser key="settings">
              <Settings />
            </RequireUser>
          </PageTitle>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
