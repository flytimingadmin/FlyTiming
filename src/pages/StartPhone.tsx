import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { parseTimestamptz, syncedEventTime, syncedNow, useClockSync, type ClockSync } from '../lib/clock'
import { useWakeLock } from '../lib/useWakeLock'
import { useRaceWithStart } from '../lib/useRaceWithStart'
import { formatTenths } from '../lib/format'
import { raceTitle, type StartEvent } from '../lib/types'
import StatusBadge from '../components/StatusBadge'
import SyncPanel from '../components/SyncPanel'
import GunPanel from '../components/GunPanel'
import { useGunDetector } from '../lib/gunDetector'

type PendingStart = Pick<StartEvent, 'race_id' | 'started_at' | 'source' | 'clock_offset_ms' | 'clock_rtt_ms' | 'device_label'>

const pendingKey = (raceId: string) => `flytiming.pendingStart.${raceId}`
const RETRY_MS = 2000
/** A second gun this soon after the start is the starter recalling a false start. */
const RECALL_WINDOW_MS: [number, number] = [1000, 6000]

function readPending(raceId: string): PendingStart | null {
  try { return JSON.parse(localStorage.getItem(pendingKey(raceId)) ?? 'null') } catch { return null }
}
function writePending(raceId: string, p: PendingStart | null) {
  try {
    if (p) localStorage.setItem(pendingKey(raceId), JSON.stringify(p))
    else localStorage.removeItem(pendingKey(raceId))
  } catch { /* private mode */ }
}
type Trigger = 'audio' | 'tap'
const TRIGGER_KEY = 'flytiming.startTrigger'
function readTrigger(): Trigger {
  try { return localStorage.getItem(TRIGGER_KEY) === 'tap' ? 'tap' : 'audio' } catch { return 'audio' }
}

function deviceLabel() {
  try { return localStorage.getItem('flytiming.volunteerName') || 'Start phone' } catch { return 'Start phone' }
}

export default function StartPhone() {
  const { raceId = '' } = useParams()
  const clock = useClockSync()
  const { sync, recalibrate } = clock
  const { race, nextRace, live, setLive, loadError, loadLive } = useRaceWithStart(raceId)
  const [pending, setPending] = useState<PendingStart | null>(() => readPending(raceId))
  const [armed, setArmed] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const retryTimer = useRef<number | undefined>(undefined)
  const [trigger, setTriggerState] = useState<Trigger>(readTrigger)
  const [startSource, setStartSource] = useState<'manual' | 'audio' | null>(null)
  const [recalledNotice, setRecalledNotice] = useState(false)

  useWakeLock(true)

  function setTrigger(t: Trigger) {
    setTriggerState(t)
    try { localStorage.setItem(TRIGGER_KEY, t) } catch { /* private mode */ }
  }

  // Latest values for the gun callback, which fires from the audio thread.
  const fireRef = useRef<(syncedMs: number, source: 'manual' | 'audio') => void>(() => {})
  const secondShotRef = useRef<(syncedMs: number) => void>(() => {})
  const syncRef = useRef<ClockSync | null>(null)
  useEffect(() => { syncRef.current = sync }, [sync])
  const detector = useGunDetector(
    (perfMs) => {
      const s = syncRef.current
      if (s) fireRef.current(performance.timeOrigin + perfMs + s.offsetMs, 'audio')
    },
    (perfMs) => {
      const s = syncRef.current
      if (s) secondShotRef.current(performance.timeOrigin + perfMs + s.offsetMs)
    },
  )

  // Post a captured start; keep retrying on flaky venue Wi-Fi. The gun time is
  // already fixed locally, so a late save doesn't change the timestamp.
  const postStart = useCallback(async (p: PendingStart) => {
    window.clearTimeout(retryTimer.current)
    const { data, error } = await supabase.from('start_events').insert(p).select().single()
    if (!error) {
      writePending(p.race_id, null)
      setPending(null)
      setSaveError(null)
      setLive(data as StartEvent)
      return
    }
    if (error.code === '23505') {
      // Someone else already started this heat — theirs wins.
      writePending(p.race_id, null)
      setPending(null)
      setSaveError('Another phone already started this heat.')
      loadLive()
      return
    }
    if (error.code === '42501') {
      writePending(p.race_id, null)
      setPending(null)
      setSaveError(errorMessage(error))
      return
    }
    setSaveError('Saving start… retrying (check signal)')
    retryTimer.current = window.setTimeout(() => postStart(p), RETRY_MS)
  }, [loadLive])

  // Per-heat reset. This screen stays mounted across "Next heat →" on purpose,
  // so the microphone keeps running between heats. Also resumes an unsent
  // start after a reload.
  useEffect(() => {
    const p = readPending(raceId)
    setPending(p)
    setArmed(false)
    setStartSource(null)
    setSaveError(null)
    setRecalledNotice(false)
    setElapsed(0)
    if (p) postStart(p)
    return () => window.clearTimeout(retryTimer.current)
  }, [raceId]) // postStart is stable per heat

  // Running clock.
  const startedAt = live?.started_at ?? pending?.started_at ?? null
  useEffect(() => {
    if (!startedAt || !sync) return
    const t0 = parseTimestamptz(startedAt)
    let raf = 0
    const frame = () => {
      setElapsed(syncedNow(sync) - t0)
      raf = requestAnimationFrame(frame)
    }
    frame()
    return () => cancelAnimationFrame(raf)
  }, [startedAt, sync])

  function fireAt(at: number, source: 'manual' | 'audio') {
    if (!sync || !armed || startedAt) return
    navigator.vibrate?.(40)
    setStartSource(source)
    const p: PendingStart = {
      race_id: raceId,
      started_at: new Date(at).toISOString(),
      source,
      clock_offset_ms: sync.offsetMs,
      clock_rtt_ms: sync.rttMs,
      device_label: deviceLabel(),
    }
    setArmed(false)
    setRecalledNotice(false)
    writePending(raceId, p)
    setPending(p)
    postStart(p)
  }
  fireRef.current = fireAt

  function fire(e: PointerEvent<HTMLButtonElement>) {
    // Timestamp from the pointerdown event itself — fires on touch, not release.
    if (sync) fireAt(syncedEventTime(sync, e.timeStamp), 'manual')
  }

  // The detector only listens while Set is armed.
  const listening = trigger === 'audio' && detector.status === 'on'
  const { arm } = detector
  useEffect(() => { arm(armed && listening) }, [armed, listening, arm])

  /** Discards the current start (saved or still saving) and returns to Set. */
  async function voidStart() {
    window.clearTimeout(retryTimer.current)
    writePending(raceId, null)
    setPending(null)
    setArmed(false)
    setStartSource(null)
    setElapsed(0)
    if (live) {
      const id = live.id
      setLive(null)
      for (let attempt = 0; attempt < 10; attempt++) {
        const { error } = await supabase.from('start_events')
          .update({ voided_at: new Date(sync ? syncedNow(sync) : Date.now()).toISOString() }).eq('id', id)
        if (!error) { setSaveError(null); break }
        setSaveError(`Recall not saved yet — retrying (${errorMessage(error)})`)
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    if (clock.stale) recalibrate()
  }

  async function recall() {
    if (!confirm('Recall this start? The start time is discarded and the heat can be started again.')) return
    await voidStart()
  }

  // Second shot soon after the start = false-start recall: reset automatically.
  secondShotRef.current = (at) => {
    const t0 = live ? parseTimestamptz(live.started_at) : pending ? parseTimestamptz(pending.started_at) : null
    if (t0 === null) return
    const dt = at - t0
    if (dt < RECALL_WINDOW_MS[0] || dt > RECALL_WINDOW_MS[1]) return
    navigator.vibrate?.([120, 80, 120])
    setRecalledNotice(true)
    void voidStart()
  }

  if (loadError) return <main className="page"><p className="error">{loadError}</p></main>
  if (!race) return <p className="muted center pad">Loading…</p>

  const started = Boolean(startedAt)
  const canArm = Boolean(sync) && !clock.syncing && !started && (trigger === 'tap' || listening)
  const source = live?.source ?? pending?.source ?? startSource

  return (
    <main className="page start-page">
      <Link to={`/meets/${race.meet_id}`} className="back">← Heats</Link>
      <div className="row between wrap">
        <h1>{raceTitle(race)}</h1>
        <StatusBadge status={race.status} />
      </div>

      <SyncPanel {...clock} />

      {race.status === 'needsLanes' && !started && (
        <p className="notice">No lanes assigned yet. You can still start, but scoring needs lanes.</p>
      )}
      {clock.stale && !started && (
        <p className="notice">Clock sync is over 5 minutes old — tap Re-sync before this heat.</p>
      )}

      {recalledNotice && !started && (
        <p className="recall-banner" role="alert">False start — second shot heard, start cancelled. Tap <strong>Set</strong> when the athletes are set again.</p>
      )}
      {!started && (
        <div className="row between wrap">
          <span className="small muted">Start trigger</span>
          <div className="segmented" role="radiogroup" aria-label="Start trigger">
            <button role="radio" aria-checked={trigger === 'audio'} className={trigger === 'audio' ? 'active' : ''}
              onClick={() => setTrigger('audio')} disabled={armed}>Gun sound</button>
            <button role="radio" aria-checked={trigger === 'tap'} className={trigger === 'tap' ? 'active' : ''}
              onClick={() => setTrigger('tap')} disabled={armed}>Tap only</button>
          </div>
        </div>
      )}
      {!started && trigger === 'audio' && <GunPanel {...detector} armed={armed} />}

      {started ? (
        <section className="start-running">
          <div className="eyebrow">
            {pending ? 'Started · saving…' : 'Started'}
            {source && ` · ${source === 'audio' ? 'by gun sound' : 'by tap'}`}
          </div>
          <div className="race-clock" aria-live="off">{formatTenths(elapsed)}</div>
          {listening && elapsed < RECALL_WINDOW_MS[1] && (
            <p className="small muted center">A second shot in the next few seconds recalls this start.</p>
          )}
          {live && (
            <div className="row gap center-row">
              <button className="btn" onClick={recall}>Recall / false start</button>
              {nextRace && (
                <Link className="btn btn-primary" to={`/races/${nextRace.id}/start`}>Next heat →</Link>
              )}
            </div>
          )}
        </section>
      ) : armed ? (
        <section className="start-armed">
          {listening && <div className="listening"><span className="listening-dot" />Listening — the gun starts the clock</div>}
          <button className={`gun-button ${listening ? 'gun-backup' : ''}`} onPointerDown={fire}
            aria-label={listening ? 'Backup: tap if the gun doesn’t trigger' : 'Gun — tap at the flash or bang'}>
            {listening ? 'TAP' : 'GUN'}
          </button>
          {listening && <p className="small muted center">Backup: tap if the gun doesn’t trigger it.</p>}
          <button className="btn btn-ghost" onClick={() => setArmed(false)}>Stand down</button>
        </section>
      ) : (
        <section className="start-idle">
          <button className="arm-button" onClick={() => setArmed(true)} disabled={!canArm}>
            Set
          </button>
          <p className="muted small center">
            {trigger === 'audio'
              ? <>Tap <strong>Set</strong> when athletes are set. The gun starts the clock by itself.</>
              : <>Tap <strong>Set</strong> when athletes are set, then tap <strong>Gun</strong> the instant you see the flash.</>}
          </p>
        </section>
      )}

      {saveError && <p className={saveError.startsWith('Saving') ? 'notice' : 'error'}>{saveError}</p>}
    </main>
  )
}
