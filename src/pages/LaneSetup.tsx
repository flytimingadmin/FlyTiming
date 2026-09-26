import { useEffect, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import {
  DEFAULT_LANES, MAX_LANES, raceTitle,
  type LaneAssignment, type Race,
} from '../lib/types'
import StatusBadge from '../components/StatusBadge'

interface Row { first: string; last: string; team: string; bib: string }
type Rows = Record<number, Row>

const EMPTY: Row = { first: '', last: '', team: '', bib: '' }
const isFilled = (r: Row) => Boolean(r.first.trim() || r.last.trim())

function rowsFrom(assignments: LaneAssignment[]): Rows {
  const rows: Rows = {}
  for (const a of assignments) {
    rows[a.lane] = {
      first: a.athlete_first_name,
      last: a.athlete_last_name,
      team: a.team ?? '',
      bib: a.bib ?? '',
    }
  }
  return rows
}

const sameRow = (a: Row = EMPTY, b: Row = EMPTY) =>
  a.first.trim() === b.first.trim() && a.last.trim() === b.last.trim() &&
  a.team.trim() === b.team.trim() && a.bib.trim() === b.bib.trim()

export default function LaneSetup() {
  const { raceId = '' } = useParams()
  const [race, setRace] = useState<Race | null>(null)
  const [saved, setSaved] = useState<Rows>({})
  const [rows, setRows] = useState<Rows>({})
  const [laneCount, setLaneCount] = useState(DEFAULT_LANES)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)

  async function load() {
    const [raceRes, lanesRes] = await Promise.all([
      supabase.from('races').select('*').eq('id', raceId).maybeSingle(),
      supabase.from('lane_assignments').select('*').eq('race_id', raceId).order('lane'),
    ])
    if (raceRes.error || lanesRes.error) return setError(errorMessage(raceRes.error ?? lanesRes.error))
    if (!raceRes.data) return setError('Heat not found, or you haven’t joined this meet.')
    const loaded = rowsFrom(lanesRes.data as LaneAssignment[])
    setRace(raceRes.data as Race)
    setSaved(loaded)
    setRows(loaded)
    const highest = Math.max(0, ...Object.keys(loaded).map(Number))
    setLaneCount((n) => Math.max(n, highest))
  }

  useEffect(() => { load() }, [raceId])

  const lanes = useMemo(() => Array.from({ length: laneCount }, (_, i) => i + 1), [laneCount])
  const dirty = lanes.some((l) => !sameRow(rows[l], saved[l])) ||
    Object.keys(saved).some((l) => Number(l) > laneCount)
  const filledCount = lanes.filter((l) => rows[l] && isFilled(rows[l])).length
  const hasRun = race?.status === 'uploaded' || race?.status === 'scored'

  useEffect(() => {
    if (!dirty) return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [dirty])

  function update(lane: number, field: keyof Row, value: string) {
    setRows((prev) => ({ ...prev, [lane]: { ...(prev[lane] ?? EMPTY), [field]: value } }))
    setFlash(null)
  }

  function clearLane(lane: number) {
    setRows((prev) => ({ ...prev, [lane]: EMPTY }))
    setFlash(null)
  }

  async function save() {
    if (!race) return
    const upserts = lanes
      .filter((l) => rows[l] && isFilled(rows[l]) && !sameRow(rows[l], saved[l]))
      .map((l) => ({
        race_id: race.id,
        lane: l,
        athlete_first_name: rows[l].first.trim(),
        athlete_last_name: rows[l].last.trim(),
        team: rows[l].team.trim() || null,
        bib: rows[l].bib.trim() || null,
      }))
    const removals = Object.keys(saved).map(Number)
      .filter((l) => l > laneCount || !rows[l] || !isFilled(rows[l]))

    if (removals.length && hasRun &&
        !confirm(`Clearing lane ${removals.join(', ')} also deletes any result logged for it. Continue?`)) return

    setBusy(true)
    setError(null)
    try {
      if (removals.length) {
        const { error } = await supabase.from('lane_assignments').delete()
          .eq('race_id', race.id).in('lane', removals)
        if (error) throw error
      }
      if (upserts.length) {
        const { error } = await supabase.from('lane_assignments')
          .upsert(upserts, { onConflict: 'race_id,lane' })
        if (error) throw error
      }
      await load()
      setFlash('Lanes saved')
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  if (error && !race) return <main className="page"><p className="error">{error}</p></main>
  if (!race) return <p className="muted center pad">Loading…</p>

  const lastLaneEmpty = !rows[laneCount] || !isFilled(rows[laneCount])

  return (
    <main className="page lanes-page">
      <Link to={`/meets/${race.meet_id}`} className="back">← Heats</Link>
      <div className="row between wrap">
        <h1>{raceTitle(race)}</h1>
        <StatusBadge status={race.status} />
      </div>
      <p className="muted small">
        {filledCount} of {laneCount} lanes filled. Leave a lane blank if it’s empty.
      </p>
      {hasRun && (
        <p className="notice">This heat has already run. You can fix names, but clearing a lane deletes its result.</p>
      )}

      <ol className="lanes">
        {lanes.map((lane) => {
          const r = rows[lane] ?? EMPTY
          const filled = isFilled(r)
          return (
            <li key={lane} className={`lane ${filled ? 'lane-filled' : ''}`}>
              <div className="lane-num" aria-hidden="true">{lane}</div>
              <div className="lane-fields">
                <input className="input" value={r.first} placeholder="First"
                  aria-label={`Lane ${lane} first name`} autoComplete="off" autoCapitalize="words"
                  onChange={(e) => update(lane, 'first', e.target.value)} />
                <input className="input" value={r.last} placeholder="Last"
                  aria-label={`Lane ${lane} last name`} autoComplete="off" autoCapitalize="words"
                  onChange={(e) => update(lane, 'last', e.target.value)} />
                <input className="input" value={r.team} placeholder="Team"
                  aria-label={`Lane ${lane} team`} autoComplete="off"
                  onChange={(e) => update(lane, 'team', e.target.value)} />
                <input className="input" value={r.bib} placeholder="Bib" inputMode="numeric"
                  aria-label={`Lane ${lane} bib`} autoComplete="off"
                  onChange={(e) => update(lane, 'bib', e.target.value)} />
              </div>
              <button className="btn-icon" onClick={() => clearLane(lane)} aria-label={`Clear lane ${lane}`}
                disabled={!filled} style={filled ? undefined : { visibility: 'hidden' }}>×</button>
            </li>
          )
        })}
      </ol>

      <div className="row gap">
        <button className="btn btn-ghost" disabled={laneCount >= MAX_LANES}
          onClick={() => setLaneCount((n) => Math.min(MAX_LANES, n + 1))}>+ Lane</button>
        <button className="btn btn-ghost" disabled={laneCount <= 1 || !lastLaneEmpty}
          onClick={() => setLaneCount((n) => Math.max(1, n - 1))}>− Lane</button>
      </div>

      <div className="save-bar">
        <span className="small muted" aria-live="polite">
          {error ? <span className="error">{error}</span> : dirty ? 'Unsaved changes' : flash ?? 'All changes saved'}
        </span>
        <button className="btn btn-primary" onClick={save} disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save lanes'}
        </button>
      </div>
    </main>
  )
}
