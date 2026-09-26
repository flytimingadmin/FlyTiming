import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, errorMessage } from '../lib/supabase'

const NAME_KEY = 'flytiming.volunteerName'

function readName() {
  try { return localStorage.getItem(NAME_KEY) ?? '' } catch { return '' }
}

export default function Join() {
  const [params] = useSearchParams()
  const { session, loading } = useAuth()
  const navigate = useNavigate()
  const [code, setCode] = useState((params.get('code') ?? '').toUpperCase())
  const [name, setName] = useState(readName)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (code) nameRef.current?.focus()
  }, [code])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      if (!session) {
        const { error } = await supabase.auth.signInAnonymously()
        if (error) throw error
      }
      const { data, error } = await supabase.rpc('join_meet', {
        p_code: code,
        p_display_name: name.trim() || null,
      })
      if (error) throw error
      try { localStorage.setItem(NAME_KEY, name.trim()) } catch { /* private mode */ }
      navigate(`/meets/${data as string}`, { replace: true })
    } catch (err) {
      const msg = errorMessage(err)
      setError(msg.includes('Invalid join code') ? 'That code didn’t match a meet. Check it with the coach.' : msg)
    } finally {
      setBusy(false)
    }
  }

  if (loading) return <p className="muted center pad">Loading…</p>

  return (
    <main className="page narrow">
      <form className="card" onSubmit={submit}>
        <h1>Join a meet</h1>
        <label className="field">
          <span className="label">Join code</span>
          <input
            className="input code-input"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="ABC234"
            autoCapitalize="characters"
            autoComplete="off"
            maxLength={8}
            required
          />
        </label>
        <label className="field">
          <span className="label">Your name or station <span className="muted">(optional)</span></span>
          <input
            ref={nameRef}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Start line – Sam"
            autoComplete="off"
          />
        </label>
        <button className="btn btn-primary" disabled={busy || code.trim().length < 6}>
          {busy ? 'Joining…' : 'Join meet'}
        </button>
        {error && <p className="error">{error}</p>}
      </form>
    </main>
  )
}
