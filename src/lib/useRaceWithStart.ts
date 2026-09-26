import { useCallback, useEffect, useState } from 'react'
import { supabase, errorMessage } from './supabase'
import type { Race, StartEvent } from './types'

/** A heat, its live (non-voided) start, and the next heat in the meet — kept live via Realtime. */
export function useRaceWithStart(raceId: string) {
  const [race, setRace] = useState<Race | null>(null)
  const [nextRace, setNextRace] = useState<Race | null>(null)
  const [live, setLive] = useState<StartEvent | null>(null)
  const [liveLoaded, setLiveLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const loadLive = useCallback(async () => {
    const { data, error } = await supabase.from('start_events').select('*')
      .eq('race_id', raceId).is('voided_at', null).maybeSingle()
    if (!error) {
      setLive(data as StartEvent | null)
      setLiveLoaded(true)
    }
  }, [raceId])

  useEffect(() => {
    (async () => {
      const { data: r, error } = await supabase.from('races').select('*').eq('id', raceId).maybeSingle()
      if (error) return setLoadError(errorMessage(error))
      if (!r) return setLoadError('Heat not found, or you haven’t joined this meet.')
      const raceRow = r as Race
      setRace(raceRow)
      const { data: list } = await supabase.from('races').select('*')
        .eq('meet_id', raceRow.meet_id).order('sort_order').order('heat_number')
      const races = (list ?? []) as Race[]
      const idx = races.findIndex((x) => x.id === raceId)
      setNextRace(idx >= 0 ? races[idx + 1] ?? null : null)
    })()
    loadLive()

    // Other phones fire / recall the start; the race status changes as video lands.
    const channel = supabase
      .channel(`race-${raceId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'start_events', filter: `race_id=eq.${raceId}` }, loadLive)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'races', filter: `id=eq.${raceId}` },
        (payload) => setRace(payload.new as Race))
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [raceId, loadLive])

  return { race, nextRace, live, setLive, liveLoaded, loadError, loadLive }
}
