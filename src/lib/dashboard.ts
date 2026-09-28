import { supabase } from './supabase'
import type { Race } from './types'

/**
 * What the dashboard shows per heat. Finer-grained than races.status:
 * it also knows whether the gun has fired and how far scoring has got.
 */
export type HeatState = 'needsLanes' | 'ready' | 'running' | 'awaiting' | 'scoring' | 'scored'

export const HEAT_STATES: HeatState[] = ['needsLanes', 'ready', 'running', 'awaiting', 'scoring', 'scored']

export const HEAT_STATE_LABEL: Record<HeatState, string> = {
  needsLanes: 'Needs lanes',
  ready: 'Ready',
  running: 'Running',
  awaiting: 'Awaiting scoring',
  scoring: 'Scoring',
  scored: 'Scored',
}

export interface HeatSummary {
  race: Race
  state: HeatState
  lanes: number
  results: number
  startedAt: string | null
  recording: boolean
  /** fastest finished time, for scored heats */
  bestMs: number | null
}

function heatState(race: Race, started: boolean, results: number): HeatState {
  switch (race.status) {
    case 'needsLanes': return 'needsLanes'
    case 'readyToStart': return started ? 'running' : 'ready'
    case 'uploaded': return results > 0 ? 'scoring' : 'awaiting'
    case 'scored': return 'scored'
  }
}

export async function loadMeetHeats(meetId: string): Promise<HeatSummary[]> {
  const { data: raceRows, error } = await supabase.from('races').select('*')
    .eq('meet_id', meetId).order('sort_order').order('heat_number')
  if (error) throw error
  const races = (raceRows ?? []) as Race[]
  if (!races.length) return []
  const ids = races.map((r) => r.id)

  const [lanes, results, starts, recordings] = await Promise.all([
    supabase.from('lane_assignments').select('race_id').in('race_id', ids),
    supabase.from('results').select('race_id, status, elapsed_ms').in('race_id', ids),
    supabase.from('start_events').select('race_id, started_at').in('race_id', ids).is('voided_at', null),
    supabase.from('recordings').select('race_id, status').in('race_id', ids),
  ])
  for (const r of [lanes, results, starts, recordings]) if (r.error) throw r.error

  const count = (rows: { race_id: string }[] | null, id: string) => (rows ?? []).filter((x) => x.race_id === id).length
  return races.map((race) => {
    const raceResults = (results.data ?? []).filter((x) => x.race_id === race.id)
    const startedAt = (starts.data ?? []).find((x) => x.race_id === race.id)?.started_at ?? null
    const times = raceResults
      .filter((x) => x.status === 'finished' && x.elapsed_ms !== null)
      .map((x) => x.elapsed_ms as number)
    return {
      race,
      state: heatState(race, Boolean(startedAt), raceResults.length),
      lanes: count(lanes.data, race.id),
      results: raceResults.length,
      startedAt,
      recording: (recordings.data ?? []).some((x) => x.race_id === race.id && x.status === 'recording'),
      bestMs: times.length ? Math.min(...times) : null,
    }
  })
}

/** Heats grouped by event (division + event + round), in schedule order. */
export function groupByEvent(heats: HeatSummary[]) {
  const groups = new Map<string, HeatSummary[]>()
  for (const h of heats) {
    const key = `${h.race.division ?? ''}|${h.race.gender ?? ''}|${h.race.event_name}|${h.race.round}`
    groups.set(key, [...(groups.get(key) ?? []), h])
  }
  return [...groups.values()]
}
