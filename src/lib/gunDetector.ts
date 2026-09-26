// Start-phone gun detection (see public/gun-detector.worklet.js).
//
// Timing: the worklet reports the audio frame of the bang. Audio frames are
// mapped to performance.now() by watching when block-end frames arrive on
// the main thread and keeping the *smallest* (least-delayed) offset — the
// same trick as the clock sync. Then we subtract the sound's travel time
// from the starter (≈2.9 ms per meter) and any calibrated device latency.

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Trigger level in dB of *high-frequency* (>1.5 kHz) energy over 3 ms.
 * Higher = less sensitive. The panel's "loudest recent sound" readout uses
 * the same measure, so the level can be set just below a test shot.
 */
export const THRESHOLD_RANGE = { min: -40, max: 0 }
const RISE_DB = 20
const SPEED_OF_SOUND = 343 // m/s

export interface GunSettings { thresholdDb: number; distanceM: number; latencyMs: number }
// Default setup: phone strapped to the starter's forearm, right next to the gun.
const DEFAULTS: GunSettings = { thresholdDb: -12, distanceM: 0.5, latencyMs: 0 }
const KEY = 'flytiming.gunDetect.v2' // v1 used a different level measure

export function readGunSettings(): GunSettings {
  try {
    const s = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) ?? '{}') }
    s.thresholdDb = Math.min(THRESHOLD_RANGE.max, Math.max(THRESHOLD_RANGE.min, Number(s.thresholdDb) || DEFAULTS.thresholdDb))
    return s
  } catch { return DEFAULTS }
}
function writeGunSettings(s: GunSettings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)) } catch { /* private mode */ }
}

export interface Level { peakDb: number; floorDb: number; thresholdDb: number }
export interface GunInfo { peakDb: number; floorDb: number }

export type DetectorStatus = 'off' | 'starting' | 'on' | 'error'

export function useGunDetector(
  onGun: (perfMs: number, info: GunInfo) => void,
  /** Gun-level sound while not armed (clap tests, or a recall shot after a start). */
  onHit?: (perfMs: number, info: { peakDb: number }) => void,
) {
  const [status, setStatus] = useState<DetectorStatus>('off')
  const [error, setError] = useState<string | null>(null)
  const [level, setLevel] = useState<Level | null>(null)
  const [lastHit, setLastHit] = useState<{ at: number; peakDb: number } | null>(null)
  /** Loudest sound in the last ~10 s, on the same scale as the threshold. */
  const [loudest, setLoudest] = useState<number | null>(null)
  const recentPeaks = useRef<{ t: number; db: number }[]>([])
  const [settings, setSettingsState] = useState<GunSettings>(readGunSettings)

  const ctxRef = useRef<AudioContext | null>(null)
  const nodeRef = useRef<AudioWorkletNode | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const offsets = useRef<number[]>([])
  const onGunRef = useRef(onGun)
  const onHitRef = useRef(onHit)
  const settingsRef = useRef(settings)
  useEffect(() => { onGunRef.current = onGun; onHitRef.current = onHit }, [onGun, onHit])

  const sendConfig = useCallback((s: GunSettings) => {
    nodeRef.current?.port.postMessage({ type: 'config', thresholdDb: s.thresholdDb, riseDb: RISE_DB })
  }, [])

  const setSettings = useCallback((s: GunSettings) => {
    setSettingsState(s)
    settingsRef.current = s
    writeGunSettings(s)
    sendConfig(s)
  }, [sendConfig])

  /** Must run from a tap (browsers only start audio after a user gesture). */
  const enable = useCallback(async () => {
    if (ctxRef.current) return
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      setStatus('error')
      setError('The microphone needs a secure (https) connection. Open FlyTiming from its https address.')
      return
    }
    setStatus('starting')
    setError(null)
    const ctx = new AudioContext({ latencyHint: 'interactive' })
    ctxRef.current = ctx
    try {
      const resumed = ctx.resume()
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          // Processing meant for calls smears and delays a sharp bang.
          echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1,
        },
      })
      streamRef.current = stream
      await ctx.audioWorklet.addModule('/gun-detector.worklet.js')
      await resumed
      const node = new AudioWorkletNode(ctx, 'gun-detector', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] })
      nodeRef.current = node
      sendConfig(settingsRef.current)

      node.port.onmessage = (e: MessageEvent) => {
        const m = e.data
        const sr = ctx.sampleRate
        if (m.type === 'level') {
          // Smallest observed (arrival − audio time) ≈ when a block was captured.
          const o = offsets.current
          o.push(performance.now() - (m.frameEnd / sr) * 1000)
          if (o.length > 100) o.shift()
          setLevel({ peakDb: m.peakDb, floorDb: m.floorDb, thresholdDb: m.thresholdDb })
          const now = Date.now()
          const peaks = recentPeaks.current.filter((p) => now - p.t < 10_000)
          peaks.push({ t: now, db: m.peakDb })
          recentPeaks.current = peaks
          setLoudest(Math.max(...peaks.map((p) => p.db)))
        } else if (m.type === 'gun' || m.type === 'hit') {
          const o = offsets.current
          const offset = o.length ? Math.min(...o) : performance.now() - (m.frame / sr) * 1000
          const s = settingsRef.current
          const perf = (m.frame / sr) * 1000 + offset - (s.distanceM / SPEED_OF_SOUND) * 1000 - s.latencyMs
          if (m.type === 'gun') onGunRef.current(perf, { peakDb: m.peakDb, floorDb: m.floorDb })
          else {
            setLastHit({ at: Date.now(), peakDb: m.peakDb })
            onHitRef.current?.(perf, { peakDb: m.peakDb })
          }
        }
      }

      const src = ctx.createMediaStreamSource(stream)
      const silent = ctx.createGain()
      silent.gain.value = 0
      src.connect(node)
      node.connect(silent).connect(ctx.destination) // keeps the graph running; outputs silence
      setStatus('on')
    } catch (e) {
      streamRef.current?.getTracks().forEach((t) => t.stop())
      ctx.close().catch(() => {})
      ctxRef.current = null
      nodeRef.current = null
      setStatus('error')
      const name = e instanceof DOMException ? e.name : ''
      setError(name === 'NotAllowedError'
        ? 'Microphone access was blocked. Allow the microphone for this site in your browser settings, then reload.'
        : `Couldn’t start the microphone: ${e instanceof Error ? e.message : String(e)}`)
    }
  }, [sendConfig])

  const arm = useCallback((armed: boolean) => {
    nodeRef.current?.port.postMessage({ type: 'arm', armed })
    // iOS may suspend audio when the screen was off.
    if (armed && ctxRef.current?.state !== 'running') ctxRef.current?.resume().catch(() => {})
  }, [])

  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') ctxRef.current?.resume().catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      streamRef.current?.getTracks().forEach((t) => t.stop())
      ctxRef.current?.close().catch(() => {})
    }
  }, [])

  return { status, error, level, lastHit, loudest, settings, setSettings, enable, arm }
}
