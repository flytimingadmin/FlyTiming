import { useState } from 'react'
import { errorMessage } from '../lib/supabase'
import { download, loadMeetResults } from '../lib/export/load'
import { athleticNetRows, buildLifFiles, planExport, toCsv, toTsv, type ExportPlan, type HeatData } from '../lib/export/results'
import { buildZip } from '../lib/export/zip'
import { raceTitle, type Meet } from '../lib/types'

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'meet'

/** "Export this meet's results" — lives on the meet dashboard, not per heat. */
export default function ExportCard({ meet, scored, total }: { meet: Meet; scored: number; total: number }) {
  const [busy, setBusy] = useState(false)
  const [plan, setPlan] = useState<ExportPlan | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const base = `${meet.meet_date}-${slug(meet.name)}`

  async function withData(fn: (heats: HeatData[], p: ExportPlan) => void | Promise<void>) {
    setBusy(true); setError(null); setNote(null)
    try {
      const all = await loadMeetResults(meet.id)
      const p = planExport(all)
      setPlan(p)
      if (!p.heats.length) { setError('No scored heats to export yet.'); return }
      await fn(p.heats, p)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const hytek = () => withData((heats) => {
    const files = buildLifFiles(heats)
    download(`${base}-hytek-lif.zip`, buildZip(files) as BlobPart, 'application/zip')
    setNote(`Downloaded ${files.length} .lif file${files.length === 1 ? '' : 's'} (one per heat).`)
  })

  const athleticCsv = () => withData((heats) => {
    const rows = athleticNetRows(heats)
    download(`${base}-athletic-net.csv`, toCsv(rows), 'text/csv')
    setNote(`Downloaded ${rows.length - 1} result row${rows.length === 2 ? '' : 's'} for Athletic.net.`)
  })

  const athleticCopy = () => withData(async (heats) => {
    await navigator.clipboard.writeText(toTsv(athleticNetRows(heats)))
    setNote('Copied — paste into Athletic.net’s “Paste Results” box.')
  })

  return (
    <section className="card export-card">
      <div className="row between">
        <h2>Export results</h2>
        <span className="small muted">{scored} of {total} heats scored</span>
      </div>
      <p className="muted small">Only scored heats are included.</p>
      <div className="export-actions">
        <button className="btn btn-primary" onClick={hytek} disabled={busy || !scored}>Hy-Tek (.lif files)</button>
        <button className="btn" onClick={athleticCsv} disabled={busy || !scored}>Athletic.net CSV</button>
        <button className="btn btn-ghost" onClick={athleticCopy} disabled={busy || !scored}>Copy for Athletic.net</button>
      </div>
      {note && <p className="small flash">{note}</p>}
      {error && <p className="error">{error}</p>}
      {plan && (plan.skipped.length > 0 || plan.warnings.length > 0) && (
        <ul className="export-warnings small">
          {plan.skipped.length > 0 && (
            <li>Not included (not scored yet): {plan.skipped.map((r) => raceTitle(r)).join('; ')}</li>
          )}
          {plan.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
      <details className="small muted export-help">
        <summary>How to import</summary>
        <p><strong>Hy-Tek Meet Manager:</strong> unzip the file. In Run, pick the event and heat, switch the
          button to <em>Get Results From Lynx File</em>, and choose that heat’s .lif file
          (named event-round-heat, e.g. 003-1-02.lif). Enter bibs that match Meet Manager’s competitor
          numbers, and check its import preview — it flags anything that doesn’t match.</p>
        <p><strong>Athletic.net:</strong> upload the CSV on the meet’s Upload tab (or paste), then choose the
          timing method on the Timing Method step. FlyTiming starts from the gun’s sound (or a backup tap) and
          times the finish from video. It isn’t a certified FAT system — check your league’s rules before
          marking results FAT.</p>
      </details>
    </section>
  )
}
