import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { supabase, errorMessage } from '../lib/supabase'
import { loadMeetResults } from '../lib/export/load'
import type { HeatData } from '../lib/export/results'
import { parseHeats, type ParseResult } from '../lib/import/parse'
import { applyImport, planImport, type ImportAction, type PlannedHeat } from '../lib/import/plan'
import { eventLabel, type Meet } from '../lib/types'

const ACTION_LABEL: Record<ImportAction, string> = {
  create: 'New', update: 'Update lanes', same: 'No change', skip: 'Skip',
}

const SAMPLE = 'Event\tGender\tDivision\tHeat\tLane\tFirst\tLast\tTeam\tBib\n100m\tGirls\tVarsity\t1\t4\tMaya\tTorres\tCentral\t214'

export default function ImportHeats() {
  const { meetId = '' } = useParams()
  const navigate = useNavigate()
  const [meet, setMeet] = useState<Meet | null>(null)
  const [existing, setExisting] = useState<HeatData[] | null>(null)
  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<{ created: number; updated: number; athletes: number } | null>(null)

  useEffect(() => {
    supabase.from('meets').select('*').eq('id', meetId).maybeSingle()
      .then(({ data }) => setMeet(data as Meet | null))
    loadMeetResults(meetId).then(setExisting).catch((e) => setError(errorMessage(e)))
  }, [meetId])

  const parsed: ParseResult | null = useMemo(() => (text.trim() ? parseHeats(text, fileName ?? undefined) : null), [text, fileName])
  const plan: PlannedHeat[] = useMemo(() => (parsed && existing ? planImport(parsed.heats, existing) : []), [parsed, existing])

  const counts = useMemo(() => {
    const c: Record<ImportAction, number> = { create: 0, update: 0, same: 0, skip: 0 }
    for (const p of plan) c[p.action]++
    return c
  }, [plan])
  const athletes = plan.filter((p) => p.action === 'create' || p.action === 'update').reduce((n, p) => n + p.heat.entries.length, 0)

  // Group planned heats by event for the preview.
  const groups = useMemo(() => {
    const m = new Map<string, PlannedHeat[]>()
    for (const p of plan) {
      const label = eventLabel({ division: p.heat.division, gender: p.heat.gender, event_name: p.heat.event, round: p.heat.round })
      const key = `${p.heat.extEvent ?? ''}|${label}`
      m.set(key, [...(m.get(key) ?? []), p])
    }
    return [...m.entries()]
  }, [plan])

  async function onFile(f: File | undefined) {
    if (!f) return
    setDone(null); setError(null)
    setFileName(f.name)
    setText(await f.text())
  }

  async function runImport() {
    if (!existing) return
    setBusy(true); setError(null)
    try {
      const nextSort = existing.reduce((m, h) => Math.max(m, h.race.sort_order), -1) + 1
      setDone(await applyImport(meetId, plan, nextSort))
      setExisting(await loadMeetResults(meetId))
      setText(''); setFileName(null)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const willChange = counts.create + counts.update

  return (
    <main className="page import-page">
      <Link to={`/meets/${meetId}`} className="back">← {meet?.name ?? 'Meet'}</Link>
      <h1>Import heats</h1>
      <p className="muted">
        Bring in every heat and lane assignment from a preheated meet at once. Re-importing later updates
        lanes for heats that haven’t run — useful after scratches and late adds.
      </p>

      {done && (
        <div className="card import-done">
          <h2>Imported</h2>
          <p>{done.created} new heat{done.created === 1 ? '' : 's'}, {done.updated} updated · {done.athletes} athletes placed in lanes.</p>
          <button className="btn btn-primary" onClick={() => navigate(`/meets/${meetId}`)}>Go to the meet dashboard</button>
        </div>
      )}

      <section className="card">
        <h2>From Hy-Tek Meet Manager</h2>
        <ol className="steps small muted">
          <li>In Meet Manager, seed the heats as usual.</li>
          <li>Turn on the FinishLynx interface: <em>Run → Interfaces → Setup → Photo Finish → FinishLynx (file sharing)</em>.
            Meet Manager then writes <code>lynx.evt</code> (with <code>lynx.sch</code> and <code>lynx.ppl</code>) to the folder set on that screen.</li>
          <li>Choose that <code>lynx.evt</code> file here. (If your version names the menus differently, look for the FinishLynx / photo-finish interface.)</li>
        </ol>
        <label className="btn file-btn">
          Choose file…
          <input type="file" accept=".evt,.csv,.tsv,.txt" onChange={(e) => onFile(e.target.files?.[0])} hidden />
        </label>
        {fileName && <p className="small muted">Loaded <strong>{fileName}</strong></p>}
      </section>

      <section className="card">
        <h2>Or paste from a spreadsheet</h2>
        <p className="small muted">
          Copy the rows (with the header row) and paste. Needed columns: <strong>Event, Heat, Lane</strong>, and
          the athlete’s <strong>First</strong> and <strong>Last</strong> (or one <strong>Name</strong> column). Optional:
          Gender, Division, Round, Team, Bib, Grade.
        </p>
        <textarea className="input paste-box" rows={6} value={fileName ? '' : text}
          placeholder={SAMPLE} spellCheck={false}
          onChange={(e) => { setFileName(null); setDone(null); setText(e.target.value) }} />
      </section>

      {parsed && (
        <section className="card">
          <div className="row between wrap">
            <h2>Preview</h2>
            <span className="small muted">{parsed.format === 'evt' ? 'Hy-Tek / FinishLynx .evt' : 'Spreadsheet'}</span>
          </div>
          {parsed.warnings.map((w) => <p key={w} className="small warn">{w}</p>)}
          {plan.length > 0 && (
            <div className="import-summary">
              {(['create', 'update', 'same', 'skip'] as ImportAction[]).map((a) => counts[a] > 0 && (
                <span key={a} className={`import-chip act-${a}`}>{ACTION_LABEL[a]} {counts[a]}</span>
              ))}
            </div>
          )}
          <div className="import-groups">
            {groups.map(([key, ps]) => (
              <div key={key} className="import-group">
                <div className="event-title">
                  {ps[0].heat.extEvent ? `#${ps[0].heat.extEvent} · ` : ''}
                  {eventLabel({ division: ps[0].heat.division, gender: ps[0].heat.gender, event_name: ps[0].heat.event, round: ps[0].heat.round })}
                </div>
                {ps.map((p, i) => (
                  <details key={i} className="import-heat">
                    <summary>
                      <span>Heat {p.heat.heat} · {p.heat.entries.length} athlete{p.heat.entries.length === 1 ? '' : 's'}</span>
                      <span className={`import-chip act-${p.action}`}>{ACTION_LABEL[p.action]}</span>
                    </summary>
                    {p.reason && <p className="small warn">{p.reason}</p>}
                    {p.heat.notes.map((n) => <p key={n} className="small warn">{n}</p>)}
                    {p.heat.entries.length > 0 && (
                      <table className="results-table import-lanes">
                        <tbody>
                          {p.heat.entries.map((e) => (
                            <tr key={e.lane}>
                              <td>{e.lane}</td>
                              <td>{e.first} {e.last}</td>
                              <td className="muted">{e.team ?? ''}</td>
                              <td className="muted">{e.bib ?? ''}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </details>
                ))}
              </div>
            ))}
          </div>
          {error && <p className="error">{error}</p>}
          <button className="btn btn-primary" onClick={runImport} disabled={busy || !existing || willChange === 0}>
            {busy ? 'Importing…' : willChange === 0 ? 'Nothing to import' : `Import ${willChange} heat${willChange === 1 ? '' : 's'} · ${athletes} athletes`}
          </button>
        </section>
      )}
      {!parsed && error && <p className="error">{error}</p>}
    </main>
  )
}
