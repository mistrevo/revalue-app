import { BrowserRouter, Navigate, Route, Routes } from 'react-router'
import { RequireUser } from '@/components/RequireUser'
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
      <Route path="/" element={<Landing />} />
      <Route
        path="/start"
        element={
          <RequireUser key="start">
            <Start />
          </RequireUser>
        }
      />
      <Route
        path="/home"
        element={
          <RequireUser key="home" consent>
            <Home />
          </RequireUser>
        }
      />
      <Route
        path="/talk/:id"
        element={
          <RequireUser key="talk" consent>
            <Talk />
          </RequireUser>
        }
      />
      <Route
        path="/episodes"
        element={
          <RequireUser key="episodes" consent>
            <Episodes />
          </RequireUser>
        }
      />
      <Route
        path="/abilities"
        element={
          <RequireUser key="abilities" consent>
            <Abilities />
          </RequireUser>
        }
      />
      <Route
        path="/profile"
        element={
          <RequireUser key="profile" consent>
            <Profile />
          </RequireUser>
        }
      />
      <Route
        path="/options"
        element={
          <RequireUser key="options" consent>
            <Options />
          </RequireUser>
        }
      />
      <Route
        path="/deepen"
        element={
          <RequireUser key="deepen" consent>
            <Deepen />
          </RequireUser>
        }
      />
      <Route
        path="/report"
        element={
          <RequireUser key="report" consent>
            <Report />
          </RequireUser>
        }
      />
      <Route
        path="/settings"
        element={
          <RequireUser key="settings">
            <Settings />
          </RequireUser>
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
