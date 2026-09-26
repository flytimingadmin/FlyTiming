import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { parseTimestamptz } from '../lib/clock'
import { useRaceWithStart } from '../lib/useRaceWithStart'
import { formatHundredths, formatResult } from '../lib/format'
import { decodeTimecode, timecodeHeight, unwrapTimecode } from '../lib/timecode'
import { loadRecordingBlob } from '../lib/videoLoader'
import {
  RESULT_STATUS_LABEL, raceTitle,
  type LaneAssignment, type Recording, type Result, type ResultStatus,
} from '../lib/types'
import StatusBadge from '../components/StatusBadge'

interface FrameInfo {
  /** synced epoch ms of the displayed frame */
  frameMs: number
  /** true when the timecode strip couldn't be read and we fell back to currentTime */
  estimated: boolean
  videoTime: number
}

const RATES = [0.25, 0.5, 1]

export default function Scoring() {
  const { raceId = '' } = useParams()
  const { race, nextRace, live, loadError } = useRaceWithStart(raceId)

  const [lanes, setLanes] = useState<LaneAssignment[]>([])
  const [results, setResults] = useState<Record<number, Result>>({})
  const [recordings, setRecordings] = useState<Recording[] | null>(null)
  const [selectedRecId, setSelectedRecId] = useState<string | null>(null)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [loadedRecId, setLoadedRecId] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [duration, setDuration] = useState(0)
  const [frame, setFrame] = useState<FrameInfo | null>(null)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(0.5)
  const [flash, setFlash] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const videoRef = useRef<HTMLVideoElement>(null)
  /** Presentation time of the frame on screen (from requestVideoFrameCallback). */
  const shownMediaTime = useRef<number | null>(null)
  const stripCanvas = useRef<HTMLCanvasElement | null>(null)

  const startMs = live ? parseTimestamptz(live.started_at) : null
  const recording = recordings?.find((r) => r.id === selectedRecId) ?? null

  // ---- Data ---------------------------------------------------------------
  const loadResults = useCallback(async () => {
    const { data } = await supabase.from('results').select('*').eq('race_id', raceId)
    setResults(Object.fromEntries(((data ?? []) as Result[]).map((r) => [r.lane, r])))
  }, [raceId])

  const loadRecordings = useCallback(async () => {
    const { data } = await supabase.from('recordings').select('*')
      .eq('race_id', raceId).order('created_at', { ascending: false })
    const list = (data ?? []) as Recording[]
    setRecordings(list)
    // Default to the newest complete take (else the newest at all).
    setSelectedRecId((cur) => cur && list.some((r) => r.id === cur)
      ? cur
      : (list.find((r) => r.status === 'complete') ?? list[0])?.id ?? null)
  }, [raceId])

  useEffect(() => {
    supabase.from('lane_assignments').select('*').eq('race_id', raceId).order('lane')
      .then(({ data }) => setLanes((data ?? []) as LaneAssignment[]))
    loadResults()
    loadRecordings()
    const channel = supabase
      .channel(`score-${raceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'results', filter: `race_id=eq.${raceId}` }, loadResults)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'recordings', filter: `race_id=eq.${raceId}` }, loadRecordings)
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [raceId, loadResults, loadRecordings])

  // ---- Video loading --------------------------------------------------------
  const loadVideo = useCallback(async (rec: Recording) => {
    setVideoError(null)
    setFrame(null)
    try {
      const blob = await loadRecordingBlob(rec, (done, total) => setProgress({ done, total }))
      setVideoUrl((old) => { if (old) URL.revokeObjectURL(old); return URL.createObjectURL(blob) })
      setLoadedRecId(rec.id)
    } catch (e) {
      setVideoError(errorMessage(e))
    } finally {
      setProgress(null)
    }
  }, [])

  // Load automatically once the selected take is complete.
  useEffect(() => {
    if (recording?.status === 'complete' && loadedRecId !== recording.id && !progress) loadVideo(recording)
  }, [recording, loadedRecId, progress, loadVideo])

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl) }, [videoUrl])

  // ---- Frame reading --------------------------------------------------------
  const readFrame = useCallback(() => {
    const v = videoRef.current
    const rec = recordings?.find((r) => r.id === loadedRecId)
    if (!v || !rec || !v.videoWidth) return
    const w = v.videoWidth, h = v.videoHeight
    const th = timecodeHeight(w)
    const c = stripCanvas.current ?? (stripCanvas.current = document.createElement('canvas'))
    if (c.width !== w || c.height !== th) { c.width = w; c.height = th }
    const ctx = c.getContext('2d', { willReadFrequently: true })!
    // Only the strip is needed — copy just the bottom rows.
    ctx.drawImage(v, 0, h - th, w, th, 0, 0, w, th)
    const px = ctx.getImageData(0, 0, w, th).data
    const luma = (x: number, y: number) => {
      const row = Math.min(th - 1, Math.max(0, y - (h - th)))
      const i = (row * w + Math.min(w - 1, x)) * 4
      return 0.299 * px[i] + 0.587 * px[i + 1] + 0.114 * px[i + 2]
    }
    const recStart = parseTimestamptz(rec.started_at)
    const low = decodeTimecode(luma, w, h)
    setFrame(low === null
      ? { frameMs: recStart + v.currentTime * 1000, estimated: true, videoTime: v.currentTime }
      : { frameMs: unwrapTimecode(low, recStart), estimated: false, videoTime: v.currentTime })
  }, [recordings, loadedRecId])

  useEffect(() => {
    const v = videoRef.current
    if (!v || !videoUrl) return
    let handle = 0, stopped = false
    const onSeeked = () => readFrame()
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('loadeddata', onSeeked)
    if ('requestVideoFrameCallback' in v) {
      const onFrame = (_now: number, meta: VideoFrameCallbackMetadata) => {
        if (stopped) return
        shownMediaTime.current = meta.mediaTime
        readFrame()
        handle = v.requestVideoFrameCallback(onFrame)
      }
      handle = v.requestVideoFrameCallback(onFrame)
    }
    return () => {
      stopped = true
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('loadeddata', onSeeked)
      if ('cancelVideoFrameCallback' in v) v.cancelVideoFrameCallback(handle)
    }
  }, [videoUrl, readFrame])

  // MediaRecorder files often report duration = Infinity until scanned once.
  function onLoadedMetadata() {
    const v = videoRef.current!
    v.playbackRate = rate
    if (Number.isFinite(v.duration)) return setDuration(v.duration)
    const fix = () => {
      if (!Number.isFinite(v.duration)) return
      v.removeEventListener('durationchange', fix)
      setDuration(v.duration)
      v.currentTime = 0
    }
    v.addEventListener('durationchange', fix)
    v.currentTime = 1e9
  }

  // ---- Controls ---------------------------------------------------------------
  const fps = recording?.fps && recording.fps > 0 ? recording.fps : 30

  // Aim for the middle of the target frame, measured from the frame actually
  // on screen — stepping exactly 1/fps from a frame boundary can round back
  // onto the same frame.
  const step = useCallback((frames: number) => {
    const v = videoRef.current
    if (!v) return
    v.pause()
    const base = shownMediaTime.current ?? v.currentTime
    v.currentTime = Math.max(0, Math.min(v.duration || Infinity, base + (frames + 0.5) / fps))
  }, [fps])

  const togglePlay = useCallback(() => {
    const v = videoRef.current
    if (!v) return
    if (v.paused) v.play().catch(() => {})
    else v.pause()
  }, [])

  function changeRate(r: number) {
    setRate(r)
    if (videoRef.current) videoRef.current.playbackRate = r
  }

  function seekTo(ms: number) {
    const v = videoRef.current
    if (!v) return
    v.pause()
    v.currentTime = ms / 1000
  }

  // ---- Results ----------------------------------------------------------------
  const showFlash = (msg: string) => {
    setFlash(msg)
    window.setTimeout(() => setFlash((f) => (f === msg ? null : f)), 2500)
  }

  const logLane = useCallback(async (lane: number) => {
    if (!frame) return
    if (startMs === null) return showFlash('No start recorded for this heat.')
    if (!lanes.some((l) => l.lane === lane)) return showFlash(`Lane ${lane} has no athlete.`)
    const elapsed = frame.frameMs - startMs
    if (elapsed <= 0) return showFlash('That frame is before the gun.')
    const existing = results[lane]
    if (existing?.status === 'finished' && existing.elapsed_ms !== null &&
        !confirm(`Lane ${lane} already has ${formatResult(existing.elapsed_ms)}. Replace it with ${formatResult(elapsed)}?`)) return
    const row = {
      race_id: raceId, lane, status: 'finished' as ResultStatus,
      elapsed_ms: Math.round(elapsed), video_time_ms: Math.round(frame.videoTime * 1000),
    }
    setResults((prev) => ({ ...prev, [lane]: { ...(prev[lane] ?? { id: '', created_by: null, updated_at: '' }), ...row } }))
    showFlash(`Lane ${lane} · ${formatResult(elapsed)}`)
    const { error } = await supabase.from('results').upsert(row, { onConflict: 'race_id,lane' })
    if (error) { setError(errorMessage(error)); loadResults() }
  }, [frame, startMs, lanes, results, raceId, loadResults])

  async function setStatus(lane: number, status: ResultStatus) {
    if (status === 'finished') return // times come from tapping the lane
    const { error } = await supabase.from('results').upsert(
      { race_id: raceId, lane, status, elapsed_ms: null, video_time_ms: null },
      { onConflict: 'race_id,lane' })
    if (error) setError(errorMessage(error))
    loadResults()
  }

  async function clearLane(lane: number) {
    if (!confirm(`Clear lane ${lane}’s result?`)) return
    const { error } = await supabase.from('results').delete().eq('race_id', raceId).eq('lane', lane)
    if (error) setError(errorMessage(error))
    loadResults()
  }

  // Keyboard: digits log a lane (0 = lane 10), arrows step frames, space plays.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return
      if (/^[0-9]$/.test(e.key)) { e.preventDefault(); logLane(e.key === '0' ? 10 : Number(e.key)) }
      else if (e.key === 'ArrowRight' || e.key === '.') { e.preventDefault(); step(e.shiftKey ? 10 : 1) }
      else if (e.key === 'ArrowLeft' || e.key === ',') { e.preventDefault(); step(e.shiftKey ? -10 : -1) }
      else if (e.key === ' ') { e.preventDefault(); togglePlay() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [logLane, step, togglePlay])

  const standings = useMemo(() => {
    const finished = lanes
      .filter((l) => results[l.lane]?.status === 'finished' && results[l.lane].elapsed_ms !== null)
      .sort((a, b) => results[a.lane].elapsed_ms! - results[b.lane].elapsed_ms!)
    const places = new Map<number, number>()
    finished.forEach((l, i) => {
      // Ties at the displayed hundredth share a place.
      const prev = finished[i - 1]
      const same = prev && formatResult(results[prev.lane].elapsed_ms!) === formatResult(results[l.lane].elapsed_ms!)
      places.set(l.lane, same ? places.get(prev.lane)! : i + 1)
    })
    return places
  }, [lanes, results])

  // ---- Render -----------------------------------------------------------------
  if (loadError) return <main className="page"><p className="error">{loadError}</p></main>
  if (!race) return <p className="muted center pad">Loading…</p>

  const elapsed = frame && startMs !== null ? frame.frameMs - startMs : null
  const scoredCount = lanes.filter((l) => results[l.lane]).length

  return (
    <main className="page wide score-page">
      <Link to={`/meets/${race.meet_id}`} className="back">← Heats</Link>
      <div className="row between wrap">
        <h1>{raceTitle(race)}</h1>
        <StatusBadge status={race.status} />
      </div>
      {startMs === null && <p className="notice">No start recorded for this heat — video can be viewed but times can’t be computed.</p>}

      <div className="score-layout">
        <section className="score-video-col">
          <div className="score-readout" aria-live="off">
            <span className="score-time">
              {elapsed === null ? '—' : `${frame?.estimated ? '≈' : ''}${elapsed > 0 ? formatResult(elapsed) : formatHundredths(elapsed)}`}
            </span>
            <span className="small muted">
              {frame ? (frame.estimated ? 'Timecode unreadable — estimated' : `${Math.round(elapsed ?? 0)} ms from gun`) : ''}
            </span>
          </div>

          <div className="score-video">
            {videoUrl ? (
              <video
                ref={videoRef}
                src={videoUrl}
                playsInline
                muted
                preload="auto"
                onLoadedMetadata={onLoadedMetadata}
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
              />
            ) : (
              <div className="finish-placeholder">
                {videoError ? <p className="error">{videoError}</p>
                  : progress ? <p className="muted">Loading video… {progress.done}/{progress.total}</p>
                  : recordings === null ? <p className="muted">Loading…</p>
                  : !recording ? <p className="muted">No finish video for this heat yet.</p>
                  : recording.status === 'recording' ? (
                    <div className="center">
                      <p className="muted">The finish phone is recording. Video loads automatically when it stops.</p>
                      <button className="btn" onClick={() => loadVideo(recording)}>Load what’s uploaded so far</button>
                    </div>
                  ) : <p className="muted">Video unavailable.</p>}
              </div>
            )}
          </div>

          {videoUrl && (
            <>
              <input
                className="scrub"
                type="range"
                min={0}
                max={duration || 0}
                step={1 / fps}
                value={frame?.videoTime ?? 0}
                onChange={(e) => { const v = videoRef.current; if (v) v.currentTime = Number(e.target.value) }}
                aria-label="Scrub video"
              />
              <div className="transport">
                <button className="btn btn-ghost" onClick={() => step(-10)} aria-label="Back 10 frames">«</button>
                <button className="btn btn-ghost" onClick={() => step(-1)} aria-label="Back 1 frame">‹</button>
                <button className="btn" onClick={togglePlay}>{playing ? 'Pause' : 'Play'}</button>
                <button className="btn btn-ghost" onClick={() => step(1)} aria-label="Forward 1 frame">›</button>
                <button className="btn btn-ghost" onClick={() => step(10)} aria-label="Forward 10 frames">»</button>
                <select className="input rate" value={rate} onChange={(e) => changeRate(Number(e.target.value))} aria-label="Playback speed">
                  {RATES.map((r) => <option key={r} value={r}>{r}×</option>)}
                </select>
              </div>
              <p className="small muted hint">Keyboard: ← → step a frame (shift = 10), space plays, number keys log that lane.</p>
            </>
          )}

          {recordings && recordings.length > 1 && (
            <label className="field">
              <span className="label">Take</span>
              <select className="input" value={selectedRecId ?? ''} onChange={(e) => { setSelectedRecId(e.target.value); setLoadedRecId(null); setVideoUrl(null) }}>
                {recordings.map((r, i) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.created_at).toLocaleTimeString()} · {r.status}{i === 0 ? ' · latest' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>

        <section className="score-lanes-col">
          <div className="row between">
            <h2>Tap lane at the torso</h2>
            <span className="small muted">{scoredCount}/{lanes.length}</span>
          </div>
          {lanes.length === 0 && <p className="muted">No lanes assigned for this heat.</p>}
          <div className="lane-keys">
            {lanes.map((l) => {
              const r = results[l.lane]
              return (
                <button key={l.lane} className={`lane-key ${r ? 'lane-key-done' : ''}`}
                  onClick={() => logLane(l.lane)} disabled={!frame || startMs === null}>
                  <span className="lane-key-num">{l.lane}</span>
                  <span className="lane-key-name">{l.athlete_last_name || l.athlete_first_name}</span>
                  <span className="lane-key-time">
                    {r ? (r.status === 'finished' && r.elapsed_ms !== null ? formatResult(r.elapsed_ms) : RESULT_STATUS_LABEL[r.status]) : '—'}
                  </span>
                </button>
              )
            })}
          </div>
          {flash && <p className="flash" role="status">{flash}</p>}
          {error && <p className="error">{error}</p>}

          {lanes.length > 0 && (
            <table className="results-table">
              <thead>
                <tr><th>Pl</th><th>Ln</th><th>Athlete</th><th>Time</th><th /></tr>
              </thead>
              <tbody>
                {[...lanes]
                  .sort((a, b) => (standings.get(a.lane) ?? 99) - (standings.get(b.lane) ?? 99) || a.lane - b.lane)
                  .map((l) => {
                    const r = results[l.lane]
                    return (
                      <tr key={l.lane}>
                        <td>{standings.get(l.lane) ?? ''}</td>
                        <td>{l.lane}</td>
                        <td>
                          <div>{l.athlete_first_name} {l.athlete_last_name}</div>
                          {l.team && <div className="small muted">{l.team}</div>}
                        </td>
                        <td>
                          {r?.status === 'finished' && r.elapsed_ms !== null ? (
                            <button className="btn-link time-link" onClick={() => r.video_time_ms !== null && seekTo(r.video_time_ms)}
                              title="Jump to this frame">{formatResult(r.elapsed_ms)}</button>
                          ) : r ? RESULT_STATUS_LABEL[r.status] : <span className="muted">—</span>}
                        </td>
                        <td className="row-actions">
                          <select className="input status-select" value="" aria-label={`Lane ${l.lane} status`}
                            onChange={(e) => { const v = e.target.value; if (v === 'clear') clearLane(l.lane); else if (v) setStatus(l.lane, v as ResultStatus) }}>
                            <option value="">⋯</option>
                            <option value="dnf">DNF</option>
                            <option value="dns">DNS</option>
                            <option value="dq">DQ</option>
                            {r && <option value="clear">Clear</option>}
                          </select>
                        </td>
                      </tr>
                    )
                  })}
              </tbody>
            </table>
          )}

          {race.status === 'scored' && nextRace && (
            <Link className="btn btn-primary" to={`/races/${nextRace.id}/score`}>Next heat →</Link>
          )}
        </section>
      </div>
    </main>
  )
}
