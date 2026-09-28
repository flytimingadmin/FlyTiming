import { Navigate, Route, Routes, useParams } from 'react-router-dom'
import { useAuth } from './lib/auth'
import { supabaseConfigured } from './lib/supabase'
import AppHeader from './components/AppHeader'
import Home from './pages/Home'
import Join from './pages/Join'
import NewMeet from './pages/NewMeet'
import MeetPage from './pages/MeetPage'
import LaneSetup from './pages/LaneSetup'
import StartPhone from './pages/StartPhone'
import FinishPhone from './pages/FinishPhone'
import Scoring from './pages/Scoring'
import ImportHeats from './pages/ImportHeats'
import type { ReactNode } from 'react'

function RequireSession({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth()
  if (loading) return <p className="muted center pad">Loading…</p>
  return session ? children : <Navigate to="/" replace />
}

/** Remounts a heat screen when the heat changes (e.g. "Next heat →"), so no state carries over. */
function PerHeat({ children }: { children: ReactNode }) {
  const { raceId } = useParams()
  return <div key={raceId} style={{ display: 'contents' }}>{children}</div>
}

export default function App() {
  if (!supabaseConfigured) {
    return (
      <main className="page">
        <AppHeader />
        <div className="card">
          <h2>Supabase not configured</h2>
          <p className="muted">
            Copy <code>.env.example</code> to <code>.env.local</code> and fill in your project URL
            and publishable key, then restart the dev server.
          </p>
        </div>
      </main>
    )
  }

  return (
    <>
      <AppHeader />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/join" element={<Join />} />
        <Route path="/meets/new" element={<RequireSession><NewMeet /></RequireSession>} />
        <Route path="/meets/:meetId" element={<RequireSession><MeetPage /></RequireSession>} />
        <Route path="/meets/:meetId/import" element={<RequireSession><ImportHeats /></RequireSession>} />
        <Route path="/races/:raceId/lanes" element={<RequireSession><PerHeat><LaneSetup /></PerHeat></RequireSession>} />
        <Route path="/races/:raceId/start" element={<RequireSession><StartPhone /></RequireSession>} />
        <Route path="/races/:raceId/finish" element={<RequireSession><PerHeat><FinishPhone /></PerHeat></RequireSession>} />
        <Route path="/races/:raceId/score" element={<RequireSession><PerHeat><Scoring /></PerHeat></RequireSession>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </>
  )
}
