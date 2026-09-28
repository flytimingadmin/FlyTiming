// Mirrors supabase/migrations/20260926000000_init_schema.sql.
// Can be replaced later by `supabase gen types typescript`.

export type RaceStatus = 'needsLanes' | 'readyToStart' | 'uploaded' | 'scored'
export type MeetRole = 'owner' | 'volunteer'
export type Gender = 'F' | 'M' | 'X'

export interface Meet {
  id: string
  owner_id: string
  name: string
  meet_date: string
  location: string | null
  join_code: string | null
  created_at: string
  updated_at: string
}

export interface Race {
  id: string
  meet_id: string
  event_name: string
  gender: Gender | null
  division: string | null
  round: string
  heat_number: number
  /** Hy-Tek Meet Manager event / round numbers, when imported from lynx.evt */
  ext_event_number: number | null
  ext_round: number | null
  sort_order: number
  scheduled_at: string | null
  status: RaceStatus
  scored_at: string | null
}

export interface LaneAssignment {
  id: string
  race_id: string
  lane: number
  athlete_first_name: string
  athlete_last_name: string
  team: string | null
  bib: string | null
  grade: number | null
}

export const MAX_LANES = 12
export const DEFAULT_LANES = 8

export const RACE_STATUS_LABEL: Record<RaceStatus, string> = {
  needsLanes: 'Needs lanes',
  readyToStart: 'Ready',
  uploaded: 'Awaiting scoring',
  scored: 'Scored',
}

export const GENDER_LABEL: Record<Gender, string> = { F: 'Girls', M: 'Boys', X: 'Mixed' }

/** "JV Girls 100m Hurdles prelim" — division, gender, event, round. */
export function eventLabel(r: Pick<Race, 'event_name' | 'gender' | 'round'> & { division?: string | null }) {
  const d = r.division ? `${r.division} ` : ''
  const g = r.gender ? `${GENDER_LABEL[r.gender]} ` : ''
  const round = r.round && r.round !== 'final' ? ` ${r.round}` : ''
  return `${d}${g}${r.event_name}${round}`
}

export function raceTitle(r: Pick<Race, 'event_name' | 'gender' | 'round' | 'heat_number'> & { division?: string | null }) {
  return `${eventLabel(r)} · Heat ${r.heat_number}`
}

export interface StartEvent {
  id: string
  race_id: string
  started_at: string
  source: 'manual' | 'audio'
  clock_offset_ms: number | null
  clock_rtt_ms: number | null
  device_label: string | null
  created_by: string | null
  voided_at: string | null
  created_at: string
}

export interface Recording {
  id: string
  race_id: string
  status: 'recording' | 'complete' | 'failed'
  mime_type: string
  file_ext: 'mp4' | 'webm'
  chunk_count: number
  started_at: string
  ended_at: string | null
  width: number | null
  height: number | null
  fps: number | null
  timecode_version: number
  created_at: string
}

export type ResultStatus = 'finished' | 'dnf' | 'dns' | 'dq'

export interface Result {
  id: string
  race_id: string
  lane: number
  status: ResultStatus
  elapsed_ms: number | null
  video_time_ms: number | null
  created_by: string | null
  updated_at: string
}

export const RESULT_STATUS_LABEL: Record<ResultStatus, string> = {
  finished: 'Finished', dnf: 'DNF', dns: 'DNS', dq: 'DQ',
}
