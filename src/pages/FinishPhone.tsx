import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { parseTimestamptz, syncedNow, useClockSync, type ClockSync } from '../lib/clock'
import { useWakeLock } from '../lib/useWakeLock'
import { useRaceWithStart } from '../lib/useRaceWithStart'
import { formatHundredths, formatTenths } from '../lib/format'
import { drawTimecode, timecodeHeight } from '../lib/timecode'
import { CENTER_LINE, drawFinishLine, readFinishLine, writeFinishLine, type FinishLine } from '../lib/finishLine'
import { ChunkUploader, pickRecorderFormat, type UploadProgress } from '../lib/chunkUploader'
import { raceTitle } from '../lib/types'
import StatusBadge from '../components/StatusBadge'
import SyncPanel from '../components/SyncPanel'

type Phase = 'idle' | 'recording' | 'finishing' | 'done'

const VIDEO_BITRATE = 2_500_000 // ≈19 MB/min — free-tier storage is 1 GB
const CHUNK_MS = 1000

interface RecordingRow {
  id: string
  race_id: string
  mime_type: string
  file_ext: string
  started_at: string
  width: number
  height: number
  fps: number | null
  clock_offset_ms: number
  clock_rtt_ms: number
  device_label: string
}

function deviceLabel() {
  try { return localStorage.getItem('flytiming.volunteerName') || 'Finish phone' } catch { return 'Finish phone' }
}

/** Burned-in overlay: race clock (or time of day before the gun) + heat name. */
function drawOverlay(
  ctx: CanvasRenderingContext2D, w: number, h: number,
  frameMs: number | null, startMs: number | null, title: string,
) {
  const size = Math.round(Math.min(w, h) / 12)
  const pad = Math.round(size * 0.35)
  const main = frameMs === null ? 'NO CLOCK SYNC'
    : startMs === null ? new Date(frameMs).toLocaleTimeString([], { hour12: false }) + '.' +
        String(Math.floor((frameMs % 1000) / 10)).padStart(2, '0')
    : formatHundredths(frameMs - startMs)
  const sub = startMs === null && frameMs !== null ? `${title} · waiting for gun` : title

  ctx.font = `700 ${size}px Outfit, system-ui, sans-serif`
  const mainW = ctx.measureText(main).width
  ctx.font = `600 ${Math.round(size * 0.38)}px Outfit, system-ui, sans-serif`
  const subW = ctx.measureText(sub).width
  const boxW = Math.max(mainW, subW) + pad * 2
  const boxH = size * 1.55 + pad
  ctx.fillStyle = 'rgba(0, 0, 0, 0.62)'
  ctx.fillRect(pad, pad, boxW, boxH)
  ctx.fillStyle = '#fff'
  ctx.textBaseline = 'top'
  ctx.font = `700 ${size}px Outfit, system-ui, sans-serif`
  ctx.fillText(main, pad * 2, pad * 1.4)
  ctx.font = `600 ${Math.round(size * 0.38)}px Outfit, system-ui, sans-serif`
  ctx.fillText(sub, pad * 2, pad * 1.4 + size * 1.05)
}

/** Drag handle for one end of the finish line (locked while recording). */
function LineHandle({ end, line, onChange, container }: {
  end: 'top' | 'bottom'
  line: FinishLine
  onChange: (l: FinishLine) => void
  container: React.RefObject<HTMLDivElement | null>
}) {
  function move(e: React.PointerEvent) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
    const rect = container.current!.getBoundingClientRect()
    const x = Math.min(0.99, Math.max(0.01, (e.clientX - rect.left) / rect.width))
    onChange({ ...line, [end]: x })
  }
  return (
    <div
      className={`line-handle line-handle-${end}`}
      style={{ left: `${line[end] * 100}%` }}
      role="slider"
      aria-label={`Finish line ${end} position`}
      aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(line[end] * 100)}
      tabIndex={0}
      onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); e.preventDefault() }}
      onPointerMove={move}
      onKeyDown={(e) => {
        const d = e.key === 'ArrowLeft' ? -0.002 : e.key === 'ArrowRight' ? 0.002 : 0
        if (d) { e.preventDefault(); onChange({ ...line, [end]: Math.min(0.99, Math.max(0.01, line[end] + d * (e.shiftKey ? 10 : 1))) }) }
      }}
    />
  )
}

export default function FinishPhone() {
  const { raceId = '' } = useParams()
  const clock = useClockSync()
  const { race, nextRace, live, liveLoaded, loadError } = useRaceWithStart(raceId)

  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [autoRecord, setAutoRecord] = useState(true)
  const [progress, setProgress] = useState<UploadProgress>({ uploaded: 0, queued: 0, retrying: false })
  const [recStartedAt, setRecStartedAt] = useState<number | null>(null)
  const [recElapsed, setRecElapsed] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [discardNotice, setDiscardNotice] = useState(false)
  /** The start this take is recording (null if recording began before the gun). */
  const recordingStartId = useRef<string | null>(null)
  const discardRef = useRef(false)
  const autoStartPending = useRef(false)

  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cameraStream = useRef<MediaStream | null>(null)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const uploaderRef = useRef<ChunkUploader | null>(null)
  const rowRef = useRef<RecordingRow | null>(null)
  const stoppedAtRef = useRef<number>(0)
  // Read by the per-frame draw loop without restarting it.
  const syncRef = useRef<ClockSync | null>(null)
  const startMsRef = useRef<number | null>(null)
  const titleRef = useRef('')
  const [finishLine, setFinishLine] = useState<FinishLine>(readFinishLine)
  const lineRef = useRef(finishLine)
  const previewRef = useRef<HTMLDivElement>(null)
  const [aspect, setAspect] = useState(16 / 9)

  useWakeLock(true)
  useEffect(() => { syncRef.current = clock.sync }, [clock.sync])
  useEffect(() => { startMsRef.current = live ? parseTimestamptz(live.started_at) : null }, [live])
  useEffect(() => { titleRef.current = race ? raceTitle(race) : '' }, [race])
  useEffect(() => { lineRef.current = finishLine; writeFinishLine(finishLine) }, [finishLine])

  // ---- Camera --------------------------------------------------------------
  // Waits for the heat to load: the <video> element isn't rendered until then.
  const screenReady = Boolean(race)
  useEffect(() => {
    if (!screenReady) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setCameraError('The camera needs a secure (https) connection. Open FlyTiming from its https address.')
      return
    }
    let cancelled = false
    navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 60 },
      },
    }).then(async (stream) => {
      if (cancelled) return stream.getTracks().forEach((t) => t.stop())
      cameraStream.current = stream
      const v = videoRef.current!
      v.srcObject = stream
      await v.play().catch(() => {})
      // Preview box follows the camera's shape (rotating the phone flips it).
      const fit = () => { if (v.videoWidth) setAspect(v.videoWidth / v.videoHeight) }
      fit()
      v.addEventListener('resize', fit)
      setCameraReady(true)
    }).catch((e: unknown) => {
      const name = e instanceof DOMException ? e.name : ''
      setCameraError(name === 'NotAllowedError'
        ? 'Camera access was blocked. Allow the camera for this site in your browser settings, then reload.'
        : `Couldn’t open the camera: ${errorMessage(e)}`)
    })
    return () => {
      cancelled = true
      cameraStream.current?.getTracks().forEach((t) => t.stop())
    }
  }, [screenReady])

  // ---- Per-frame draw: camera → canvas + overlay + timecode ---------------
  useEffect(() => {
    if (!cameraReady) return
    const v = videoRef.current!
    const c = canvasRef.current!
    const ctx = c.getContext('2d', { alpha: false })!
    let stopped = false
    let handle = 0

    const draw = (capturePerf: number) => {
      const w = v.videoWidth, h = v.videoHeight
      if (!w || !h) return
      if (c.width !== w || c.height !== h) { c.width = w; c.height = h }
      ctx.drawImage(v, 0, 0, w, h)
      const sync = syncRef.current
      const frameMs = sync ? performance.timeOrigin + capturePerf + sync.offsetMs : null
      drawFinishLine(ctx, w, h, lineRef.current)
      drawOverlay(ctx, w, h, frameMs, startMsRef.current, titleRef.current)
      if (frameMs !== null) drawTimecode(ctx, frameMs, w, h)
      else { ctx.fillStyle = '#000'; ctx.fillRect(0, h - timecodeHeight(w), w, timecodeHeight(w)) }
    }

    if ('requestVideoFrameCallback' in v) {
      // One callback per camera frame; captureTime (where supported) is when
      // the sensor captured it, which removes camera-pipeline latency.
      const onFrame = (now: number, meta: VideoFrameCallbackMetadata) => {
        if (stopped) return
        draw((meta as VideoFrameCallbackMetadata & { captureTime?: number }).captureTime ?? now)
        handle = v.requestVideoFrameCallback(onFrame)
      }
      handle = v.requestVideoFrameCallback(onFrame)
      return () => { stopped = true; v.cancelVideoFrameCallback(handle) }
    }
    const onRaf = () => {
      if (stopped) return
      draw(performance.now())
      handle = requestAnimationFrame(onRaf)
    }
    handle = requestAnimationFrame(onRaf)
    return () => { stopped = true; cancelAnimationFrame(handle) }
  }, [cameraReady])

  // ---- Recording -----------------------------------------------------------
  async function saveRow(fields: Record<string, unknown>) {
    for (let attempt = 0; ; attempt++) {
      const { error } = await supabase.from('recordings').upsert({ ...rowRef.current, ...fields })
      if (!error) return
      if (attempt > 30) throw error
      await new Promise((r) => setTimeout(r, 2000))
    }
  }

  function startRecording() {
    const sync = clock.sync
    const canvas = canvasRef.current
    if (!sync || !cameraReady || !canvas || recorderRef.current) return
    const fmt = pickRecorderFormat()
    if (!fmt) return setError('This browser can’t record video. Try Safari (iPhone) or Chrome (Android).')

    const id = crypto.randomUUID()
    const startedAt = syncedNow(sync)
    const settings = cameraStream.current?.getVideoTracks()[0]?.getSettings()
    rowRef.current = {
      id, race_id: raceId,
      mime_type: fmt.mime, file_ext: fmt.ext,
      started_at: new Date(startedAt).toISOString(),
      width: canvas.width, height: canvas.height, fps: settings?.frameRate ?? null,
      clock_offset_ms: sync.offsetMs, clock_rtt_ms: sync.rttMs,
      device_label: deviceLabel(),
    }

    const uploader = new ChunkUploader(`${raceId}/${id}`, fmt.ext, fmt.base, setProgress)
    const recorder = new MediaRecorder(canvas.captureStream(), {
      mimeType: fmt.mime,
      videoBitsPerSecond: VIDEO_BITRATE,
      // Keyframe every chunk: mp4 recorders only emit data at keyframes, and
      // the scorer seeks faster. Ignored by browsers that don't support it.
      videoKeyFrameIntervalDuration: CHUNK_MS,
    } as MediaRecorderOptions)
    recorder.ondataavailable = (e) => uploader.enqueue(e.data)
    recorder.onstop = () => { void finishRecording() }
    recorder.start(CHUNK_MS)
    uploaderRef.current = uploader
    recorderRef.current = recorder
    recordingStartId.current = live?.id ?? null
    discardRef.current = false
    setDiscardNotice(false)
    setProgress({ uploaded: 0, queued: 0, retrying: false })
    setRecStartedAt(startedAt)
    setPhase('recording')
    setError(null)

    // Row is saved alongside, not before — recording must not wait on the network.
    saveRow({ status: 'recording' }).catch((e) => setError(errorMessage(e)))
  }

  function stopRecording() {
    if (!recorderRef.current || !clock.sync) return
    stoppedAtRef.current = syncedNow(clock.sync)
    setPhase('finishing')
    recorderRef.current.stop()
  }

  async function finishRecording() {
    const uploader = uploaderRef.current!
    recorderRef.current?.stream.getTracks().forEach((t) => t.stop())
    recorderRef.current = null
    await uploader.drained()
    if (discardRef.current) {
      // False start: keep the chunks' row for the record, but never score it.
      discardRef.current = false
      saveRow({ status: 'failed', chunk_count: uploader.count, ended_at: new Date(stoppedAtRef.current).toISOString() })
        .catch(() => {})
      setPhase('idle')
      return
    }
    try {
      await saveRow({
        status: 'complete',
        chunk_count: uploader.count,
        ended_at: new Date(stoppedAtRef.current).toISOString(),
      })
      setPhase('done')
    } catch (e) {
      setError(`Video uploaded but couldn’t be marked complete: ${errorMessage(e)}`)
      setPhase('done')
    }
  }

  // Auto-record when a new gun arrives while this screen is open.
  const lastLiveId = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    if (!liveLoaded) return
    const id = live?.id ?? null
    const previous = lastLiveId.current
    lastLiveId.current = id
    if (previous === undefined) return // gun that fired before we opened doesn't count

    if (phase === 'recording' || phase === 'finishing') {
      if (recordingStartId.current === null && id) {
        recordingStartId.current = id // recording began before the gun; it now covers this start
      } else if (recordingStartId.current !== null && id !== recordingStartId.current) {
        // The start this take covers was recalled (false start): discard it.
        if (phase === 'recording') { discardRef.current = true; setDiscardNotice(true); stopRecording() }
        if (id && autoRecord) autoStartPending.current = true
      }
      return
    }
    if (id && id !== previous && autoRecord && phase === 'idle') startRecording()
  }, [live, liveLoaded]) // startRecording reads current state; re-running on it would double-fire

  // A restart gun that arrived while the discarded take was still uploading.
  useEffect(() => {
    if (phase === 'idle' && autoStartPending.current) {
      autoStartPending.current = false
      if (live && live.id !== recordingStartId.current) startRecording()
    }
  }, [phase]) // fires on the transition back to idle only

  // Recording timer + leave warning.
  useEffect(() => {
    if (phase !== 'recording' && phase !== 'finishing') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    const t = setInterval(() => { if (clock.sync && recStartedAt) setRecElapsed(syncedNow(clock.sync) - recStartedAt) }, 250)
    return () => { window.removeEventListener('beforeunload', warn); clearInterval(t) }
  }, [phase, clock.sync, recStartedAt])

  // Stop cleanly if the screen is left mid-recording (in-app navigation).
  useEffect(() => () => { recorderRef.current?.state === 'recording' && recorderRef.current.stop() }, [])

  if (loadError) return <main className="page"><p className="error">{loadError}</p></main>
  if (!race) return <p className="muted center pad">Loading…</p>

  const busy = phase === 'recording' || phase === 'finishing'
  const canRecord = cameraReady && Boolean(clock.sync) && !clock.syncing && phase === 'idle'

  return (
    <main className="page finish-page">
      {busy
        ? <span className="back muted">Recording — stay on this screen</span>
        : <Link to={`/meets/${race.meet_id}`} className="back">← Heats</Link>}
      <div className="row between wrap">
        <h1>{raceTitle(race)}</h1>
        <StatusBadge status={race.status} />
      </div>

      <SyncPanel {...clock} />

      <div className="finish-preview" ref={previewRef} style={{ ['--ar' as string]: aspect }}>
        <video ref={videoRef} className="camera-source" muted playsInline autoPlay />
        <canvas ref={canvasRef} className="finish-canvas" />
        {!cameraReady && (
          <div className="finish-placeholder">
            {cameraError ? <p className="error">{cameraError}</p> : <p className="muted">Starting camera…</p>}
          </div>
        )}
        {cameraReady && phase === 'idle' && (
          <>
            <LineHandle end="top" line={finishLine} onChange={setFinishLine} container={previewRef} />
            <LineHandle end="bottom" line={finishLine} onChange={setFinishLine} container={previewRef} />
          </>
        )}
        {phase === 'recording' && <div className="rec-pill"><span className="rec-dot" />REC {formatTenths(recElapsed)}</div>}
      </div>

      <p className="muted small">
        Aim down the finish line, landscape, with every lane in frame.
        {phase === 'idle' && ' Drag the two blue handles so the line sits on the painted finish line.'}
        {live ? ' Gun received.' : ' Waiting for the gun.'}
        {phase === 'idle' && (finishLine.top !== 0.5 || finishLine.bottom !== 0.5) && (
          <> <button className="btn-link small" onClick={() => setFinishLine(CENTER_LINE)}>Reset line</button></>
        )}
      </p>

      <div className="finish-controls">
        {phase === 'idle' && (
          <>
            <button className="record-button" onClick={startRecording} disabled={!canRecord} aria-label="Start recording">
              <span className="record-glyph" />
            </button>
            <label className="toggle">
              <input type="checkbox" checked={autoRecord} onChange={(e) => setAutoRecord(e.target.checked)} />
              <span>Start recording automatically when the gun fires</span>
            </label>
          </>
        )}
        {phase === 'recording' && (
          <button className="record-button recording" onClick={stopRecording} aria-label="Stop recording">
            <span className="stop-glyph" />
          </button>
        )}
        {(phase === 'finishing' || phase === 'done') && (
          <div className="upload-status">
            <div className="eyebrow">{phase === 'done' ? 'Uploaded' : 'Finishing upload…'}</div>
            <div className="small muted">
              {progress.uploaded} of {progress.uploaded + progress.queued} chunks
              {progress.retrying && ' · retrying, check signal'}
            </div>
            {phase === 'done' && (
              <div className="row gap center-row">
                <button className="btn" onClick={() => setPhase('idle')}>Record again</button>
                {nextRace && <Link className="btn btn-primary" to={`/races/${nextRace.id}/finish`}>Next heat →</Link>}
              </div>
            )}
          </div>
        )}
        {phase === 'recording' && (
          <div className="small muted center">
            Uploaded {progress.uploaded} chunk{progress.uploaded === 1 ? '' : 's'}
            {progress.queued > 0 && ` · ${progress.queued} waiting`}
            {progress.retrying && ' · retrying, check signal'}
          </div>
        )}
      </div>

      {discardNotice && (phase === 'idle' || phase === 'finishing') && (
        <p className="recall-banner" role="alert">False start — that recording was discarded.
          {autoRecord ? ' Recording will start again on the next gun.' : ' Tap record for the restart.'}</p>
      )}
      {error && <p className="error">{error}</p>}
    </main>
  )
}
