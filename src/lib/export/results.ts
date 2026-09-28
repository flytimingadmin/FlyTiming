// Meet results export (build step 7).
//
// Formats, per their published specs:
//  • Hy-Tek Meet Manager — FinishLynx .lif files, one per heat (the same
//    files FAT systems hand to MM; imported with "Get Results From Lynx File").
//    Header: Event, Round, Heat, Event name, Wind, Wind unit, Template,
//            Capture time, Capture duration, Distance, Start time
//    Rows:   Place, ID, Lane, Last, First, Affiliation, Time, License,
//            Delta time, ReacTime, Splits, TT start time
//    Times in raw thousandths (MM rounds and breaks ties itself);
//    DNS / DNF / DQ go in the Place column.
//  • Athletic.net — "AthleticNET Custom Format Track and Field" with headings.
//    Result rounded UP to the hundredth, same as the scoring screen.

import { formatResult } from '../format'
import { parseTimestamptz } from '../clock'
import { eventLabel as fullEventLabel, type LaneAssignment, type Race, type Result } from '../types'

export interface HeatData {
  race: Race
  lanes: LaneAssignment[]
  results: Result[]
  startedAt: string | null
}

export interface ExportFile { name: string; content: string }

export interface ExportPlan {
  heats: HeatData[]          // scored heats that will be exported
  skipped: Race[]            // heats not yet scored
  warnings: string[]
}

export const isRelay = (r: Race) => /relay|\d\s*x\s*\d/i.test(r.event_name)

const clean = (s: string | null | undefined) => (s ?? '').replace(/[,\r\n]+/g, ' ').replace(/\s+/g, ' ').trim()


/** Seconds with thousandths; m:ss.sss from a minute up (FinishLynx style). */
export function formatThousandths(ms: number) {
  const m = Math.floor(ms / 60000)
  const s = (ms % 60000) / 1000
  return m ? `${m}:${s.toFixed(3).padStart(6, '0')}` : s.toFixed(3)
}

/** HH:MM:SS.ssss local time of day, as FinishLynx writes the start time. */
function timeOfDay(iso: string) {
  const ms = parseTimestamptz(iso)
  const d = new Date(ms)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  const frac = String(Math.round((ms % 1000) * 10)).padStart(4, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${frac}`
}

/** Places by time with ties at the displayed hundredth sharing a place. */
function placeMap<T>(items: T[], ms: (t: T) => number) {
  const sorted = [...items].sort((a, b) => ms(a) - ms(b))
  const places = new Map<T, number>()
  sorted.forEach((it, i) => {
    const prev = sorted[i - 1]
    const tied = prev !== undefined && formatResult(ms(prev)) === formatResult(ms(it))
    places.set(it, tied ? places.get(prev)! : i + 1)
  })
  return places
}

const finishedMs = (r: Result | undefined) =>
  r && r.status === 'finished' && r.elapsed_ms !== null ? r.elapsed_ms : null

export function planExport(all: HeatData[]): ExportPlan {
  const heats = all.filter((h) => h.race.status === 'scored')
  const skipped = all.filter((h) => h.race.status !== 'scored').map((h) => h.race)
  const warnings: string[] = []
  const noGender = heats.filter((h) => !h.race.gender)
  if (noGender.length) warnings.push(`${noGender.length} heat(s) have no division (Girls/Boys/Mixed) — Athletic.net requires one.`)
  const noTeam = heats.reduce((n, h) => n + h.lanes.filter((l) => !clean(l.team)).length, 0)
  if (noTeam) warnings.push(`${noTeam} athlete(s) have no team — Athletic.net requires a team.`)
  const relays = heats.filter((h) => isRelay(h.race))
  if (relays.length) warnings.push(`${relays.length} relay heat(s) are in the Hy-Tek files but left out of the Athletic.net file (it needs all four leg names).`)
  const noBib = heats.reduce((n, h) => n + h.lanes.filter((l) => !clean(l.bib)).length, 0)
  if (noBib) warnings.push(`${noBib} athlete(s) have no bib — check them in Meet Manager’s import preview.`)
  return { heats, skipped, warnings }
}

/**
 * Event and Lynx round numbers. Heats imported from Hy-Tek keep Meet
 * Manager's own numbers. Otherwise events are numbered in schedule order
 * (after the highest imported number, so they can't collide), and a prelim
 * and its final share an event number (prelim = round 1, final = round 2).
 */
function eventNumbering(heats: HeatData[]) {
  const nums = new Map<string, number>()
  const hasPrelim = new Set<string>()
  const key = (r: Race) => `${r.division ?? ''}|${r.gender}|${r.event_name}`
  let next = Math.max(0, ...heats.map((h) => h.race.ext_event_number ?? 0)) + 1
  for (const h of [...heats].sort((a, b) => a.race.sort_order - b.race.sort_order)) {
    if (h.race.ext_event_number) continue
    if (!nums.has(key(h.race))) nums.set(key(h.race), next++)
    if (h.race.round === 'prelim') hasPrelim.add(key(h.race))
  }
  return {
    eventNo: (r: Race) => r.ext_event_number ?? nums.get(key(r))!,
    roundNo: (r: Race) => r.ext_round ?? (r.round === 'final' && hasPrelim.has(key(r)) ? 2 : 1),
  }
}

export function buildLifFiles(heats: HeatData[]): ExportFile[] {
  const { eventNo, roundNo } = eventNumbering(heats)
  return heats.map((h) => {
    const r = h.race
    const round = roundNo(r)
    const start = h.startedAt ? timeOfDay(h.startedAt) : ''
    const header = [eventNo(r), round, r.heat_number, clean(fullEventLabel(r)),
      '', '', '', '', '', '', start].join(',')

    const byLane = new Map(h.results.map((x) => [x.lane, x]))
    const finished = h.lanes.filter((l) => finishedMs(byLane.get(l.lane)) !== null)
    const places = placeMap(finished, (l) => finishedMs(byLane.get(l.lane))!)
    const order = [...h.lanes].sort((a, b) =>
      (places.get(a) ?? 1e9) - (places.get(b) ?? 1e9) || a.lane - b.lane)

    const rows = order.map((l) => {
      const res = byLane.get(l.lane)
      const ms = finishedMs(res)
      const place = ms !== null ? String(places.get(l)) : (res?.status ?? 'dns').toUpperCase()
      const time = ms !== null ? formatThousandths(ms) : ''
      return [place, clean(l.bib), l.lane, clean(l.athlete_last_name), clean(l.athlete_first_name),
        clean(l.team), time, '', '', '', '', start].join(',')
    })
    const name = `${String(eventNo(r)).padStart(3, '0')}-${round}-${String(r.heat_number).padStart(2, '0')}.lif`
    return { name, content: [header, ...rows].join('\r\n') + '\r\n' }
  })
}

const ATHLETIC_NET_COLUMNS = [
  'Type', 'Gender', 'Division', 'Event', 'Round', 'Heat', 'HeatPlace', 'Place',
  'Result', 'Team', 'FirstName1', 'LastName1', 'Grade1',
] as const

/** Rows for the Athletic.net custom format (individual events only). */
export function athleticNetRows(heats: HeatData[]): string[][] {
  const rows: string[][] = [[...ATHLETIC_NET_COLUMNS]]
  const individual = heats.filter((h) => !isRelay(h.race))

  // Overall place across all heats of the same division/event/round (timed finals).
  type Entry = { h: HeatData; l: LaneAssignment; res: Result | undefined }
  const events = new Map<string, Entry[]>()
  for (const h of individual) {
    const byLane = new Map(h.results.map((x) => [x.lane, x]))
    const key = `${h.race.division ?? ''}|${h.race.gender}|${h.race.event_name}|${h.race.round}`
    for (const l of h.lanes) events.set(key, [...(events.get(key) ?? []), { h, l, res: byLane.get(l.lane) }])
  }

  for (const entries of events.values()) {
    const finished = entries.filter((e) => finishedMs(e.res) !== null)
    const overall = placeMap(finished, (e) => finishedMs(e.res)!)
    const heatPlaces = new Map<Entry, number>()
    for (const h of new Set(entries.map((e) => e.h))) {
      const inHeat = finished.filter((e) => e.h === h)
      placeMap(inHeat, (e) => finishedMs(e.res)!).forEach((p, e) => heatPlaces.set(e, p))
    }
    const ordered = [...entries].sort((a, b) =>
      (overall.get(a) ?? 1e9) - (overall.get(b) ?? 1e9) ||
      a.h.race.heat_number - b.h.race.heat_number || a.l.lane - b.l.lane)
    for (const e of ordered) {
      const ms = finishedMs(e.res)
      rows.push([
        'Event',
        e.h.race.gender ?? '',
        e.h.race.division ?? '',
        e.h.race.event_name,
        e.h.race.round === 'prelim' ? 'Prelim' : 'Finals',
        String(e.h.race.heat_number),
        ms !== null ? String(heatPlaces.get(e)) : '',
        ms !== null ? String(overall.get(e)) : '',
        ms !== null ? formatResult(ms) : (e.res?.status ?? 'dns').toUpperCase(),
        clean(e.l.team),
        clean(e.l.athlete_first_name),
        clean(e.l.athlete_last_name),
        e.l.grade ? String(e.l.grade) : '',
      ])
    }
  }
  return rows
}

const csvCell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)
export const toCsv = (rows: string[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n'
/** Tab-separated, for Athletic.net's "Paste Results" box (same as copying from a spreadsheet). */
export const toTsv = (rows: string[][]) => rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, ' ')).join('\t')).join('\n')
