// Decides what importing each heat will do to the meet, and applies it.
//   create   — heat isn't in the meet yet
//   update   — heat exists and hasn't run: its lanes are replaced (re-import after scratches / late adds)
//   same     — heat exists with identical lanes
//   skip     — heat has problems, or has already started / been scored

import { supabase } from '../supabase'
import type { HeatData } from '../export/results'
import type { ImportHeat } from './parse'

export type ImportAction = 'create' | 'update' | 'same' | 'skip'

export interface PlannedHeat {
  heat: ImportHeat
  action: ImportAction
  reason?: string
  existing?: HeatData
}

const nameKey = (x: { division: string | null; gender: string | null; event: string; round: string; heat: number }) =>
  [x.division ?? '', x.gender ?? '', x.event.toLowerCase(), x.round, x.heat].join('|')
const extKey = (ev: number, rd: number, heat: number) => `${ev}|${rd}|${heat}`

function sameLanes(heat: ImportHeat, existing: HeatData) {
  if (heat.entries.length !== existing.lanes.length) return false
  const byLane = new Map(existing.lanes.map((l) => [l.lane, l]))
  return heat.entries.every((e) => {
    const l = byLane.get(e.lane)
    return l && l.athlete_first_name === e.first && l.athlete_last_name === e.last &&
      (l.team ?? null) === e.team && (l.bib ?? null) === e.bib
  })
}

export function planImport(heats: ImportHeat[], existing: HeatData[]): PlannedHeat[] {
  const byExt = new Map<string, HeatData>()
  const byName = new Map<string, HeatData>()
  for (const h of existing) {
    const r = h.race
    if (r.ext_event_number && r.ext_round) byExt.set(extKey(r.ext_event_number, r.ext_round, r.heat_number), h)
    byName.set(nameKey({ division: r.division, gender: r.gender, event: r.event_name, round: r.round, heat: r.heat_number }), h)
  }
  return heats.map((heat) => {
    if (heat.problems.length) return { heat, action: 'skip', reason: heat.problems[0] }
    const match = (heat.extEvent && heat.extRound ? byExt.get(extKey(heat.extEvent, heat.extRound, heat.heat)) : undefined)
      ?? byName.get(nameKey(heat))
    if (!match) return { heat, action: 'create' }
    const ran = Boolean(match.startedAt) || !['needsLanes', 'readyToStart'].includes(match.race.status)
    if (ran) return { heat, action: 'skip', reason: 'already started — lanes left as they are', existing: match }
    if (sameLanes(heat, match)) return { heat, action: 'same', existing: match }
    return { heat, action: 'update', existing: match }
  })
}

const chunk = <T,>(xs: T[], n: number) => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n))

function friendly(e: { message?: string } | null) {
  const msg = e?.message ?? String(e)
  if (/division|ext_event_number|ext_round/.test(msg) && /column/i.test(msg)) {
    return 'The database needs the heat-import update first: run supabase/migrations/20260928000000_heat_import.sql in the Supabase SQL Editor.'
  }
  return msg
}

export async function applyImport(meetId: string, plan: PlannedHeat[], nextSort: number) {
  const creates = plan.filter((p) => p.action === 'create')
  const updates = plan.filter((p) => p.action === 'update')

  // 1. New heats, in file order after the meet's existing heats.
  const created: string[] = []
  for (const part of chunk(creates, 200)) {
    const { data, error } = await supabase.from('races').insert(part.map((p, i) => ({
      meet_id: meetId,
      event_name: p.heat.event,
      gender: p.heat.gender,
      division: p.heat.division,
      round: p.heat.round,
      heat_number: p.heat.heat,
      sort_order: nextSort + created.length + i,
      ext_event_number: p.heat.extEvent,
      ext_round: p.heat.extRound,
    }))).select('id')
    if (error) throw new Error(friendly(error))
    created.push(...(data ?? []).map((r) => r.id as string))
  }

  // 2. Heats being refreshed: clear their lanes (and record Hy-Tek numbers if new).
  const updateIds = updates.map((p) => p.existing!.race.id)
  for (const ids of chunk(updateIds, 200)) {
    const { error } = await supabase.from('lane_assignments').delete().in('race_id', ids)
    if (error) throw new Error(friendly(error))
  }
  for (const p of updates) {
    const r = p.existing!.race
    if (p.heat.extEvent && (r.ext_event_number !== p.heat.extEvent || r.ext_round !== p.heat.extRound)) {
      const { error } = await supabase.from('races')
        .update({ ext_event_number: p.heat.extEvent, ext_round: p.heat.extRound }).eq('id', r.id)
      if (error) throw new Error(friendly(error))
    }
  }

  // 3. Lanes for new + refreshed heats.
  const lanes = [
    ...creates.map((p, i) => ({ p, raceId: created[i] })),
    ...updates.map((p) => ({ p, raceId: p.existing!.race.id })),
  ].flatMap(({ p, raceId }) => p.heat.entries.map((e) => ({
    race_id: raceId,
    lane: e.lane,
    athlete_first_name: e.first,
    athlete_last_name: e.last,
    team: e.team,
    bib: e.bib,
    grade: e.grade,
  })))
  for (const part of chunk(lanes, 500)) {
    const { error } = await supabase.from('lane_assignments').insert(part)
    if (error) throw new Error(friendly(error))
  }
  return { created: creates.length, updated: updates.length, athletes: lanes.length }
}
