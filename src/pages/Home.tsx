import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, errorMessage } from '../lib/supabase'
import type { Meet } from '../lib/types'

function JoinForm() {
  const [code, setCode] = useState('')
  const navigate = useNavigate()
  function submit(e: FormEvent) {
    e.preventDefault()
    navigate(`/join?code=${encodeURIComponent(code.trim())}`)
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>Join a meet</h2>
      <p className="muted small">Helping at a meet? Enter the code from the coach.</p>
      <input
        className="input code-input"
        value={code}
        onChange={(e) => setCode(e.target.value.toUpperCase())}
        placeholder="ABC234"
        autoCapitalize="characters"
        autoComplete="off"
        maxLength={8}
        aria-label="Join code"
      />
      <button className="btn btn-primary" disabled={code.trim().length < 6}>Join</button>
    </form>
  )
}

function CoachSignIn() {
  const [email, setEmail] = useState('')
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: window.location.origin },
    })
    setBusy(false)
    if (error) setError(errorMessage(error))
    else setSent(true)
  }

  if (sent) {
    return (
      <div className="card">
        <h2>Check your email</h2>
        <p className="muted">We sent a sign-in link to <strong>{email}</strong>.</p>
      </div>
    )
  }
  return (
    <form className="card" onSubmit={submit}>
      <h2>Coach sign in</h2>
      <p className="muted small">Create and run meets. We’ll email you a sign-in link.</p>
      <input
        className="input"
        type="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="coach@school.org"
        autoComplete="email"
        aria-label="Email"
      />
      <button className="btn" disabled={busy}>{busy ? 'Sending…' : 'Email me a link'}</button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}

function MeetList() {
  const { isAnonymous } = useAuth()
  const [meets, setMeets] = useState<Meet[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    supabase
      .from('meets')
      .select('*')
      .order('meet_date', { ascending: false })
      .then(({ data, error }) => {
        if (error) setError(errorMessage(error))
        else setMeets(data as Meet[])
      })
  }, [])

  return (
    <section>
      <div className="row between">
        <h1>Meets</h1>
        {!isAnonymous && <Link className="btn btn-primary" to="/meets/new">New meet</Link>}
      </div>
      {error && <p className="error">{error}</p>}
      {meets === null && !error && <p className="muted">Loading…</p>}
      {meets?.length === 0 && (
        <p className="muted">
          {isAnonymous ? 'You haven’t joined a meet yet.' : 'No meets yet — create your first one.'}
        </p>
      )}
      <ul className="list">
        {meets?.map((m) => (
          <li key={m.id}>
            <Link className="list-item" to={`/meets/${m.id}`}>
              <span className="list-title">{m.name}</span>
              <span className="muted small">
                {new Date(m.meet_date + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'medium' })}
                {m.location ? ` · ${m.location}` : ''}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function Home() {
  const { session, loading } = useAuth()
  if (loading) return <p className="muted center pad">Loading…</p>

  return (
    <main className="page">
      {session ? (
        <>
          <MeetList />
          <JoinForm />
        </>
      ) : (
        <>
          <section className="hero">
            <img src="/brand/ft-mark-white.png" alt="" className="hero-mark" />
            <h1 className="hero-word">FlyTiming</h1>
            <p className="muted">Phone-based race timing for track &amp; field.</p>
          </section>
          <JoinForm />
          <CoachSignIn />
        </>
      )}
    </main>
  )
}
