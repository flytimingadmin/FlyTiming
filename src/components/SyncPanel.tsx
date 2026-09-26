import { syncQuality, type ClockSync } from '../lib/clock'

interface Props {
  sync: ClockSync | null
  syncing: boolean
  error: string | null
  stale: boolean
  recalibrate: () => void
}

export default function SyncPanel({ sync, syncing, error, stale, recalibrate }: Props) {
  const quality = sync ? syncQuality(sync) : null
  let text = 'Syncing clock…'
  if (error) text = error
  else if (sync && !syncing) text = `Clock synced ±${Math.max(1, Math.round(sync.rttMs / 2))} ms${stale ? ' · stale' : ''}`
  return (
    <div className={`sync-panel sync-${error ? 'poor' : stale ? 'ok' : quality ?? 'pending'}`}>
      <span className="sync-dot" aria-hidden="true" />
      <span className="small">{text}</span>
      <button className="btn-link small" onClick={recalibrate} disabled={syncing}>
        {syncing ? 'Syncing…' : 'Re-sync'}
      </button>
    </div>
  )
}
