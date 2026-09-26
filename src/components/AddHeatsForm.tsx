import { useState, type FormEvent } from 'react'
import { supabase, errorMessage } from '../lib/supabase'
import type { Gender } from '../lib/types'

const COMMON_EVENTS = [
  '100m', '200m', '400m', '100m Hurdles', '110m Hurdles', '300m Hurdles',
  '4x100m Relay', '4x200m Relay', '4x400m Relay',
]

export default function AddHeatsForm({ meetId, nextSort, onAdded }: { meetId: string; nextSort: number; onAdded: () => void }) {
  const [event, setEvent] = useState('')
  const [gender, setGender] = useState<Gender | ''>('')
  const [round, setRound] = useState('final')
  const [heats, setHeats] = useState(1)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    const rows = Array.from({ length: heats }, (_, i) => ({
      meet_id: meetId,
      event_name: event.trim(),
      gender: gender || null,
      round,
      heat_number: i + 1,
      sort_order: nextSort + i,
    }))
    const { error } = await supabase.from('races').insert(rows)
    setBusy(false)
    if (error) return setError(errorMessage(error))
    setEvent('')
    setHeats(1)
    onAdded()
  }

  return (
    <form className="card" onSubmit={submit}>
      <h2>Add heats</h2>
      <label className="field">
        <span className="label">Event</span>
        <input className="input" list="common-events" value={event}
          onChange={(e) => setEvent(e.target.value)} placeholder="100m" required />
        <datalist id="common-events">
          {COMMON_EVENTS.map((ev) => <option key={ev} value={ev} />)}
        </datalist>
      </label>
      <div className="grid-3">
        <label className="field">
          <span className="label">Division</span>
          <select className="input" value={gender} onChange={(e) => setGender(e.target.value as Gender | '')}>
            <option value="">—</option>
            <option value="F">Girls</option>
            <option value="M">Boys</option>
            <option value="X">Mixed</option>
          </select>
        </label>
        <label className="field">
          <span className="label">Round</span>
          <select className="input" value={round} onChange={(e) => setRound(e.target.value)}>
            <option value="final">Final</option>
            <option value="prelim">Prelim</option>
          </select>
        </label>
        <label className="field">
          <span className="label">Heats</span>
          <input className="input" type="number" min={1} max={20} value={heats}
            onChange={(e) => setHeats(Math.max(1, Math.min(20, Number(e.target.value) || 1)))} />
        </label>
      </div>
      <button className="btn btn-primary" disabled={busy || !event.trim()}>
        {busy ? 'Adding…' : heats > 1 ? `Add ${heats} heats` : 'Add heat'}
      </button>
      {error && <p className="error">{error}</p>}
    </form>
  )
}
