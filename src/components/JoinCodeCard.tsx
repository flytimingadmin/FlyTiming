import { useState } from 'react'
import { supabase, errorMessage } from '../lib/supabase'

interface Props {
  meetId: string
  code: string | null
  onChange: (code: string | null) => void
}

/** Owner-only: shows the volunteer join code and lets the coach rotate or disable it. */
export default function JoinCodeCard({ meetId, code, onChange }: Props) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const link = code ? `${window.location.origin}/join?code=${code}` : null

  async function rotate() {
    if (code && !confirm('Issue a new code? The current code stops working (phones already joined stay in).')) return
    setBusy(true)
    const { data, error } = await supabase.rpc('rotate_join_code', { p_meet_id: meetId })
    setBusy(false)
    if (error) return setNote(errorMessage(error))
    onChange(data as string)
    setNote(null)
  }

  async function disable() {
    if (!confirm('Turn off joining? New phones will not be able to join until you issue a new code.')) return
    setBusy(true)
    const { error } = await supabase.from('meets').update({ join_code: null }).eq('id', meetId)
    setBusy(false)
    if (error) return setNote(errorMessage(error))
    onChange(null)
  }

  async function copyLink() {
    if (!link) return
    try {
      if (navigator.share) await navigator.share({ title: 'Join meet on FlyTiming', url: link })
      else {
        await navigator.clipboard.writeText(link)
        setNote('Invite link copied')
      }
    } catch {
      /* share sheet dismissed */
    }
  }

  return (
    <section className="card join-card">
      <div className="eyebrow">Volunteer join code</div>
      {code ? (
        <>
          <div className="join-code" aria-label={code.split('').join(' ')}>{code}</div>
          <p className="muted small">
            Volunteers open FlyTiming, tap <strong>Join a meet</strong>, and enter this code.
          </p>
          <div className="row gap">
            <button className="btn" onClick={copyLink} disabled={busy}>Share invite link</button>
            <button className="btn btn-ghost" onClick={rotate} disabled={busy}>New code</button>
            <button className="btn btn-ghost" onClick={disable} disabled={busy}>Turn off</button>
          </div>
        </>
      ) : (
        <>
          <p className="muted">Joining is off for this meet.</p>
          <button className="btn" onClick={rotate} disabled={busy}>Issue a join code</button>
        </>
      )}
      {note && <p className="small muted">{note}</p>}
    </section>
  )
}
