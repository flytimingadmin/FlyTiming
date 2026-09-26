import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase } from '../lib/supabase'

export default function AppHeader() {
  const { session, isAnonymous } = useAuth()
  const navigate = useNavigate()

  async function signOut() {
    await supabase.auth.signOut()
    navigate('/')
  }

  return (
    <header className="app-header">
      <Link to="/" className="brand" aria-label="FlyTiming home">
        <img src="/brand/ft-mark-white.png" alt="" className="brand-mark" />
        <span className="brand-word">FlyTiming</span>
      </Link>
      {session && (
        <div className="header-right">
          <span className="muted small">{isAnonymous ? 'Volunteer' : session.user.email}</span>
          <button className="btn-link small" onClick={signOut}>Sign out</button>
        </div>
      )}
    </header>
  )
}
