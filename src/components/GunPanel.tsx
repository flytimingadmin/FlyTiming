import { useEffect, useState } from 'react'
import { THRESHOLD_RANGE, type GunSettings, type Level, type DetectorStatus } from '../lib/gunDetector'

const pct = (db: number) => `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`

interface Props {
  status: DetectorStatus
  error: string | null
  level: Level | null
  lastHit: { at: number; peakDb: number } | null
  loudest: number | null
  settings: GunSettings
  setSettings: (s: GunSettings) => void
  enable: () => void
  armed: boolean
}

/** Mic switch, live level meter with trigger line, clap-test feedback, and settings. */
export default function GunPanel({ status, error, level, lastHit, loudest, settings, setSettings, enable, armed }: Props) {
  const [, tick] = useState(0)
  useEffect(() => {
    if (!lastHit) return
    const t = setTimeout(() => tick((n) => n + 1), 3100)
    return () => clearTimeout(t)
  }, [lastHit])
  const recentHit = lastHit && Date.now() - lastHit.at < 3000 && !armed

  if (status !== 'on') {
    return (
      <div className="card gun-panel">
        <div className="eyebrow">Gun detection</div>
        <p className="small muted">
          The phone listens for the gun and starts the clock on the bang itself — faster and more
          consistent than a thumb.
        </p>
        <button className="btn btn-primary" onClick={enable} disabled={status === 'starting'}>
          {status === 'starting' ? 'Starting microphone…' : 'Turn on microphone'}
        </button>
        {error && <p className="error small">{error}</p>}
      </div>
    )
  }

  return (
    <div className="card gun-panel">
      <div className="row between">
        <span className="eyebrow">{armed ? 'Listening for the gun' : 'Microphone on'}</span>
        <span className="small muted">
          trigger {settings.thresholdDb} dB{loudest !== null && ` · loudest ${Math.round(loudest)} dB`}
        </span>
      </div>
      <div className="meter" aria-hidden="true">
        {level && (
          <>
            <span className="meter-floor" style={{ width: pct(level.floorDb) }} />
            <span className="meter-peak" style={{ width: pct(level.peakDb) }} />
            {loudest !== null && <span className="meter-hold" style={{ left: pct(loudest) }} />}
            <span className="meter-threshold" style={{ left: pct(level.thresholdDb) }} />
          </>
        )}
      </div>
      <p className="small muted meter-caption">
        {recentHit
          ? <span className="hit">Heard a gun-level sound ({Math.round(lastHit!.peakDb)} dB) — this would have started the race.</span>
          : armed ? 'Anything that crosses the white line now starts the race.'
          : 'Only a sharp blast past the white line starts the race. Taps, bumps and voices are filtered out.'}
      </p>

      <details className="small">
        <summary className="muted">Detection settings</summary>
        <div className="gun-settings">
          <label className="field threshold-field">
            <span className="row between">
              <span className="label">Trigger level</span>
              <span className="small">
                <strong>{settings.thresholdDb} dB</strong>
                {loudest !== null && <span className="muted"> · loudest recent {Math.round(loudest)} dB</span>}
              </span>
            </span>
            <input type="range" className="threshold-slider"
              min={THRESHOLD_RANGE.min} max={THRESHOLD_RANGE.max} step={1}
              value={settings.thresholdDb}
              onChange={(e) => setSettings({ ...settings, thresholdDb: Number(e.target.value) })}
              aria-label="Trigger level" disabled={armed} />
            <span className="row between small muted"><span>More sensitive</span><span>Less sensitive</span></span>
            <span className="small muted">
              To set it: fire a test shot, read <em>loudest recent</em>, and set the trigger a few dB below it.
              If other sounds still trigger it, move the slider right.
            </span>
          </label>
          <label className="field">
            <span className="label">Distance from starter (m)</span>
            <input className="input" type="number" min={0} max={100} step={1} inputMode="decimal"
              value={settings.distanceM}
              onChange={(e) => setSettings({ ...settings, distanceM: Math.max(0, Number(e.target.value) || 0) })} />
          </label>
          <label className="field">
            <span className="label">Device latency (ms)</span>
            <input className="input" type="number" min={-200} max={200} step={1} inputMode="decimal"
              value={settings.latencyMs}
              onChange={(e) => setSettings({ ...settings, latencyMs: Number(e.target.value) || 0 })} />
          </label>
          <p className="muted">Sound travels ≈3 ms per meter; the app subtracts it. Strapped to the starter’s
            forearm, 0.5 m is right. Leave latency at 0 unless a calibration clap says otherwise.</p>
        </div>
      </details>
    </div>
  )
}
