import { useState, type FormEvent } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, errorMessage } from '../lib/supabase'

function today() {
  const d = new Date()
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
}

export default function NewMeet() {
  const { isAnonymous } = useAuth()
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [date, setDate] = useState(today)
  const [location, setLocation] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (isAnonymous) return <Navigate to="/" replace />

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const { data, error } = await supabase
      .from('meets')
      .insert({ name: name.trim(), meet_date: date, location: location.trim() || null })
      .select('id')
      .single()
    setBusy(false)
    if (error) return setError(errorMessage(error))
    navigate(`/meets/${data.id}`, { replace: true })
  }

  return (
    <main className="page narrow">
      <form className="card" onSubmit={submit}>
        <h1>New meet</h1>
        <label className="field">
          <span className="label">Meet name</span>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="Spring Invitational" required />
        </label>
        <label className="field">
          <span className="label">Date</span>
          <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
        </label>
        <label className="field">
          <span className="label">Location <span className="muted">(optional)</span></span>
          <input className="input" value={location} onChange={(e) => setLocation(e.target.value)} />
        </label>
        <button className="btn btn-primary" disabled={busy || !name.trim()}>
          {busy ? 'Creating…' : 'Create meet'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  )
}
