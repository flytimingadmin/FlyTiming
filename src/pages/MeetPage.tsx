import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '../lib/auth'
import { supabase, errorMessage } from '../lib/supabase'
import { eventLabel, raceTitle, type Meet } from '../lib/types'
import { STATIONS, readStation, writeStation, type Station } from '../lib/stations'
import {
  HEAT_STATES, HEAT_STATE_LABEL, groupByEvent, loadMeetHeats,
  type HeatState, type HeatSummary,
} from '../lib/dashboard'
import { formatResult } from '../lib/format'
import JoinCodeCard from '../components/JoinCodeCard'
import AddHeatsForm from '../components/AddHeatsForm'
import ExportCard from '../components/ExportCard'

function HeatBadge({ h }: { h: HeatSummary }) {
  const label = h.state === 'scoring' ? `Scoring ${h.results}/${h.lanes}` : HEAT_STATE_LABEL[h.state]
  return <span className={`badge heat-${h.state}`}>{label}</span>
}

function heatDetail(h: HeatSummary) {
  const parts = [`${h.lanes} lane${h.lanes === 1 ? '' : 's'}`]
  if (h.startedAt) parts.push(`started ${new Date(h.startedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`)
  if (h.recording) parts.push('recording…')
  if (h.bestMs !== null && h.state === 'scored') parts.push(`win ${formatResult(h.bestMs)}`)
  return parts.join(' · ')
}


function UpNext({ label, heat, to }: { label: string; heat: HeatSummary | undefined; to: (id: string) => string }) {
  if (!heat) {
    return (
      <div className="upnext upnext-empty">
        <div className="eyebrow">{label}</div>
        <div className="muted small">Nothing waiting</div>
      </div>
    )
  }
  return (
    <Link className="upnext" to={to(heat.race.id)}>
      <div className="eyebrow">{label}</div>
      <div className="upnext-title">{raceTitle(heat.race)}</div>
      <HeatBadge h={heat} />
    </Link>
  )
}

export default function MeetPage() {
  const { meetId = '' } = useParams()
  const { session } = useAuth()
  const [meet, setMeet] = useState<Meet | null>(null)
  const [heats, setHeats] = useState<HeatSummary[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [station, setStation] = useState<Station>(readStation)
  const [filter, setFilter] = useState<HeatState | null>(null)
  const refreshTimer = useRef<number | undefined>(undefined)

  const load = useCallback(async () => {
    try {
      setHeats(await loadMeetHeats(meetId))
    } catch (e) {
      setError(errorMessage(e))
    }
  }, [meetId])

  useEffect(() => {
    supabase.from('meets').select('*').eq('id', meetId).maybeSingle().then(({ data, error }) => {
      if (error) setError(errorMessage(error))
      else if (!data) setError('Meet not found, or you haven’t joined it.')
      else setMeet(data as Meet)
    })
    load()

    // Any phone's lanes, gun, video or results can change a heat's state.
    // Bursts (e.g. saving 8 lanes) are coalesced into one reload.
    const refresh = () => {
      window.clearTimeout(refreshTimer.current)
      refreshTimer.current = window.setTimeout(load, 400)
    }
    const channel = supabase.channel(`meet-${meetId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'races', filter: `meet_id=eq.${meetId}` }, refresh)
    for (const table of ['lane_assignments', 'start_events', 'recordings', 'results']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, refresh)
    }
    channel.subscribe()
    return () => {
      window.clearTimeout(refreshTimer.current)
      supabase.removeChannel(channel)
    }
  }, [meetId, load])

  const counts = useMemo(() => {
    const c = Object.fromEntries(HEAT_STATES.map((s) => [s, 0])) as Record<HeatState, number>
    for (const h of heats ?? []) c[h.state]++
    return c
  }, [heats])

  if (error) return <main className="page"><p className="error">{error}</p></main>
  if (!meet || !heats) return <p className="muted center pad">Loading…</p>

  const isOwner = meet.owner_id === session?.user.id
  const total = heats.length
  const nextSort = heats.reduce((max, h) => Math.max(max, h.race.sort_order), -1) + 1
  const stationPath = STATIONS.find((s) => s.key === station)!.path
  const nextToStart = heats.find((h) => h.state === 'ready' || h.state === 'needsLanes')
  const nextToScore = heats.find((h) => h.state === 'awaiting' || h.state === 'scoring')
  const shown = filter ? heats.filter((h) => h.state === filter) : heats

  return (
    <main className="page">
      <Link to="/" className="back">← Meets</Link>
      <h1>{meet.name}</h1>
      <p className="muted">
        {new Date(meet.meet_date + 'T00:00').toLocaleDateString(undefined, { dateStyle: 'full' })}
        {meet.location ? ` · ${meet.location}` : ''}
      </p>

      {total > 0 && (
        <section className="card progress-card">
          <div className="row between">
            <span className="eyebrow">Progress</span>
            <span className="small"><strong>{counts.scored}</strong> of {total} heats scored</span>
          </div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={counts.scored}>
            {HEAT_STATES.map((s) => counts[s] > 0 && (
              <span key={s} className={`progress-seg seg-${s}`} style={{ flexGrow: counts[s] }} title={`${HEAT_STATE_LABEL[s]}: ${counts[s]}`} />
            ))}
          </div>
          <div className="chips" role="group" aria-label="Filter heats by status">
            <button className={`chip ${filter === null ? 'active' : ''}`} onClick={() => setFilter(null)}>All {total}</button>
            {HEAT_STATES.map((s) => counts[s] > 0 && (
              <button key={s} className={`chip chip-${s} ${filter === s ? 'active' : ''}`}
                onClick={() => setFilter(filter === s ? null : s)}>
                <span className={`chip-dot seg-${s}`} />{HEAT_STATE_LABEL[s]} {counts[s]}
              </button>
            ))}
          </div>
        </section>
      )}

      {total > 0 && (
        <div className="upnext-row">
          <UpNext label="Next to start" heat={nextToStart} to={(id) => `/races/${id}/start`} />
          <UpNext label="Next to score" heat={nextToScore} to={(id) => `/races/${id}/score`} />
        </div>
      )}

      {isOwner && (
        <JoinCodeCard meetId={meet.id} code={meet.join_code}
          onChange={(join_code) => setMeet({ ...meet, join_code })} />
      )}

      <section>
        <div className="row between wrap">
          <h2>Heats</h2>
          <div className="segmented" role="radiogroup" aria-label="This phone's station">
            {STATIONS.map((s) => (
              <button key={s.key} role="radio" aria-checked={station === s.key}
                className={station === s.key ? 'active' : ''}
                onClick={() => { setStation(s.key); writeStation(s.key) }}>
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <p className="small muted station-hint">Tapping a heat opens it on this phone’s station.</p>
        {total === 0 && (
          <p className="muted">No heats yet. <Link to={`/meets/${meet.id}/import`}>Import a preheated meet</Link> or add events below.</p>
        )}
        {filter && shown.length === 0 && <p className="muted">No heats are {HEAT_STATE_LABEL[filter].toLowerCase()}.</p>}

        {groupByEvent(shown).map((group) => (
          <div key={group[0].race.id} className="event-group">
            <div className="event-title">{eventLabel(group[0].race)}</div>
            <ul className="list">
              {group.map((h) => (
                <li key={h.race.id}>
                  <Link className="list-item row between" to={stationPath(h.race.id)}>
                    <span className="heat-main">
                      <span className="list-title">Heat {h.race.heat_number}</span>
                      <span className="small muted">{heatDetail(h)}</span>
                    </span>
                    <HeatBadge h={h} />
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>

      {total > 0 && <ExportCard meet={meet} scored={counts.scored} total={total} />}

      <section className="card import-cta">
        <div>
          <h2>Import heats</h2>
          <p className="small muted">Preheated in Hy-Tek or a spreadsheet? Bring in every heat and lane at once.</p>
        </div>
        <Link className="btn btn-primary" to={`/meets/${meet.id}/import`}>Import heats</Link>
      </section>

      <AddHeatsForm meetId={meet.id} nextSort={nextSort} onAdded={load} />
    </main>
  )
}
