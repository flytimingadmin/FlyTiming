import { supabase } from '../supabase'
import type { LaneAssignment, Race, Result } from '../types'
import type { HeatData } from './results'

export async function loadMeetResults(meetId: string): Promise<HeatData[]> {
  const { data: raceRows, error } = await supabase.from('races').select('*')
    .eq('meet_id', meetId).order('sort_order').order('heat_number')
  if (error) throw error
  const races = (raceRows ?? []) as Race[]
  if (!races.length) return []
  const ids = races.map((r) => r.id)
  const [lanes, results, starts] = await Promise.all([
    supabase.from('lane_assignments').select('*').in('race_id', ids).order('lane'),
    supabase.from('results').select('*').in('race_id', ids),
    supabase.from('start_events').select('race_id, started_at').in('race_id', ids).is('voided_at', null),
  ])
  for (const r of [lanes, results, starts]) if (r.error) throw r.error
  return races.map((race) => ({
    race,
    lanes: ((lanes.data ?? []) as LaneAssignment[]).filter((l) => l.race_id === race.id),
    results: ((results.data ?? []) as Result[]).filter((x) => x.race_id === race.id),
    startedAt: (starts.data ?? []).find((s) => s.race_id === race.id)?.started_at ?? null,
  }))
}

export function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
