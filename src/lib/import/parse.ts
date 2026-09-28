// Parses preheated meets into heats with lane assignments.
//  • FinishLynx .evt (what Hy-Tek Meet Manager exports for timing systems):
//      header:     Event, Round, Heat, Event name, …
//      competitor: (blank), ID, Lane, Last, First, Affiliation, …
//    Lines starting with ';' are comments.
//  • Spreadsheet rows (CSV / tab-separated paste) with a header row.

import type { Gender } from '../types'
import { MAX_LANES } from '../types'
import { parseEventName, parseGender } from './eventName'

export interface ImportEntry {
  lane: number
  first: string
  last: string
  team: string | null
  bib: string | null
  grade: number | null
}

export interface ImportHeat {
  division: string | null
  gender: Gender | null
  event: string
  round: 'prelim' | 'final'
  heat: number
  extEvent: number | null
  extRound: number | null
  sourceName: string
  entries: ImportEntry[]
  /** Reasons this heat can't be imported (it will be skipped). */
  problems: string[]
  /** Minor issues (the heat still imports). */
  notes: string[]
}

export interface ParseResult {
  format: 'evt' | 'sheet'
  heats: ImportHeat[]
  warnings: string[]
}

/** Splits one delimited line, honoring "quoted, fields" and "" escapes. */
export function splitLine(line: string, delim: string): string[] {
  const out: string[] = []
  let cur = '', q = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (q) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++ }
      else if (c === '"') q = false
      else cur += c
    } else if (c === '"' && cur.trim() === '') { cur = ''; q = true }
    else if (c === delim) { out.push(cur.trim()); cur = '' }
    else cur += c
  }
  out.push(cur.trim())
  return out
}

const lines = (text: string) => text.replace(/^﻿/, '').split(/\r?\n/)
const int = (v: string | undefined) => (v !== undefined && /^\s*-?\d+\s*$/.test(v) ? parseInt(v, 10) : NaN)

export function looksLikeEvt(text: string) {
  const first = lines(text).find((l) => l.trim() && !l.trim().startsWith(';'))
  if (!first) return false
  const f = splitLine(first, ',')
  return !Number.isNaN(int(f[0])) && !Number.isNaN(int(f[1])) && !Number.isNaN(int(f[2])) && Boolean(f[3])
}

function finalizeHeat(h: ImportHeat) {
  if (h.entries.some((e) => !Number.isInteger(e.lane) || e.lane < 1 || e.lane > MAX_LANES)) {
    // Keep the athletes for the preview; the heat itself is skipped.
    h.problems.push(`uses start positions instead of lanes 1–${MAX_LANES} (waterfall start) — not supported for lane scoring yet`)
    return
  }
  const seen = new Set<number>()
  const kept: ImportEntry[] = []
  for (const e of h.entries) {
    if (seen.has(e.lane)) { h.notes.push(`lane ${e.lane} listed twice — kept the first`); continue }
    seen.add(e.lane)
    kept.push(e)
  }
  h.entries = kept.sort((a, b) => a.lane - b.lane)
}

export function parseEvt(text: string): ParseResult {
  const heats: ImportHeat[] = []
  const warnings: string[] = []
  let cur: ImportHeat | null = null
  lines(text).forEach((raw, i) => {
    const line = raw.trimEnd()
    if (!line.trim() || line.trim().startsWith(';')) return
    const f = splitLine(line, ',')
    if (f[0] === '') {
      if (!cur) { warnings.push(`Line ${i + 1}: athlete before any heat — skipped`); return }
      const id = f[1] ?? ''
      cur.entries.push({
        lane: int(f[2]),
        last: f[3] ?? '',
        first: f[4] ?? '',
        team: f[5] || null,
        bib: id && id !== '0' ? id : null,
        grade: null,
      })
      return
    }
    const ev = int(f[0]), rd = int(f[1]), ht = int(f[2])
    if ([ev, rd, ht].some(Number.isNaN)) { warnings.push(`Line ${i + 1}: not an event or athlete line — skipped`); return }
    const name = parseEventName(f[3] ?? '')
    cur = {
      division: name.division, gender: name.gender, event: name.event,
      round: name.round ?? 'final', heat: ht, extEvent: ev, extRound: rd,
      sourceName: f[3] ?? '', entries: [], problems: [], notes: [],
    }
    ;(cur as ImportHeat & { _explicitRound: boolean })._explicitRound = name.round !== null
    heats.push(cur)
  })

  // Rounds without a word in the name: an event number with several rounds
  // runs prelim(s) first, final last.
  const roundsByEvent = new Map<number, Set<number>>()
  for (const h of heats) roundsByEvent.set(h.extEvent!, (roundsByEvent.get(h.extEvent!) ?? new Set()).add(h.extRound!))
  for (const h of heats as (ImportHeat & { _explicitRound?: boolean })[]) {
    if (!h._explicitRound) {
      const rounds = [...roundsByEvent.get(h.extEvent!)!]
      h.round = rounds.length > 1 && h.extRound! < Math.max(...rounds) ? 'prelim' : 'final'
    }
    delete h._explicitRound
    finalizeHeat(h)
  }
  return { format: 'evt', heats, warnings }
}

const COLUMNS: Record<string, RegExp> = {
  event: /^(event|event ?name|race)$/i,
  gender: /^(gender|sex|m\/f|boys\/girls)$/i,
  division: /^(division|level|class|div)$/i,
  round: /^(round|rnd)$/i,
  heat: /^(heat|heat ?#|heat ?no\.?|section|flight)$/i,
  lane: /^(lane|ln|lane ?#)$/i,
  first: /^(first|first ?name|firstname1?|given ?name)$/i,
  last: /^(last|last ?name|lastname1?|surname|family ?name)$/i,
  name: /^(name|athlete|athlete ?name|competitor)$/i,
  team: /^(team|school|affiliation|club|team ?name)$/i,
  bib: /^(bib|bib ?#|id|competitor ?#|comp ?#|number|no\.?)$/i,
  grade: /^(grade|gr|yr|year|grade1)$/i,
}

export function parseSheet(text: string): ParseResult {
  const rows = lines(text).filter((l) => l.trim())
  const warnings: string[] = []
  if (rows.length < 2) return { format: 'sheet', heats: [], warnings: ['Paste a header row plus at least one athlete row.'] }
  const delim = rows[0].includes('\t') ? '\t' : rows[0].split(';').length > rows[0].split(',').length ? ';' : ','
  const header = splitLine(rows[0], delim)
  const col: Partial<Record<keyof typeof COLUMNS, number>> = {}
  header.forEach((h, i) => {
    for (const [k, re] of Object.entries(COLUMNS)) if (re.test(h.trim()) && col[k as keyof typeof COLUMNS] === undefined) col[k as keyof typeof COLUMNS] = i
  })
  const missing = ['event', 'heat', 'lane'].filter((k) => col[k as keyof typeof COLUMNS] === undefined)
  if (col.first === undefined && col.last === undefined && col.name === undefined) missing.push('name (or First / Last)')
  if (missing.length) {
    return { format: 'sheet', heats: [], warnings: [`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Found: ${header.join(', ')}`] }
  }

  const byKey = new Map<string, ImportHeat>()
  rows.slice(1).forEach((row, i) => {
    const f = splitLine(row, delim)
    const get = (k: keyof typeof COLUMNS) => (col[k] === undefined ? '' : (f[col[k]!] ?? '').trim())
    const eventCell = get('event')
    if (!eventCell) return
    const parsed = parseEventName(eventCell)
    const gender = get('gender') ? parseGender(get('gender')) : parsed.gender
    const division = get('division') || parsed.division
    const roundCell = get('round')
    const round = roundCell ? (/pre|semi|trial|quarter/i.test(roundCell) ? 'prelim' : 'final') : parsed.round ?? 'final'
    const heat = int(get('heat'))
    if (Number.isNaN(heat)) { warnings.push(`Row ${i + 2}: heat “${get('heat')}” isn’t a number — skipped`); return }

    let first = get('first'), last = get('last')
    if (!first && !last && get('name')) {
      const n = get('name')
      if (n.includes(',')) { [last, first] = n.split(',').map((x) => x.trim()) }
      else { const parts = n.split(/\s+/); last = parts.pop() ?? ''; first = parts.join(' ') }
    }
    const key = [division ?? '', gender ?? '', parsed.event, round, heat].join('|')
    let h = byKey.get(key)
    if (!h) {
      h = { division: division || null, gender, event: parsed.event, round, heat, extEvent: null, extRound: null,
        sourceName: eventCell, entries: [], problems: [], notes: [] }
      byKey.set(key, h)
    }
    const g = int(get('grade'))
    h.entries.push({ lane: int(get('lane')), first, last, team: get('team') || null, bib: get('bib') || null, grade: Number.isNaN(g) ? null : g })
  })
  const heats = [...byKey.values()]
  heats.forEach(finalizeHeat)
  return { format: 'sheet', heats, warnings }
}

export function parseHeats(text: string, fileName?: string): ParseResult {
  return fileName?.toLowerCase().endsWith('.evt') || looksLikeEvt(text) ? parseEvt(text) : parseSheet(text)
}
