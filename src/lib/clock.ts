// Shared-clock calibration (CLAUDE.md → "Clock sync approach").
//
// Each device measures its offset from the Postgres clock with NTP-style
// round trips to rpc/server_now, keeping the sample with the lowest RTT.
// Every timestamp we store (gun, finish marks) is local time + offset, so
// all phones agree regardless of their own system clocks.

import { useCallback, useEffect, useState } from 'react'
import { supabase } from './supabase'

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL as string
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string

/** Stale after this long — CLAUDE.md: recalibrate per heat, clocks drift. */
export const SYNC_MAX_AGE_MS = 5 * 60 * 1000

export interface ClockSync {
  /** server clock − local clock */
  offsetMs: number
  /** round trip of the chosen sample; error bound is roughly rtt / 2 */
  rttMs: number
  /** localNow() when measured */
  measuredAt: number
}

/** High-resolution local wall clock (ms since epoch, sub-ms precision). */
export const localNow = () => performance.timeOrigin + performance.now()

export const syncedNow = (sync: ClockSync) => localNow() + sync.offsetMs

/** Converts an event's timeStamp (performance-relative) to synced epoch ms. */
export function syncedEventTime(sync: ClockSync, eventTimeStamp: number) {
  const t = performance.timeOrigin + eventTimeStamp
  // Very old engines used epoch-based timeStamps; fall back to "now".
  const local = Math.abs(t - localNow()) < 1000 ? t : localNow()
  return local + sync.offsetMs
}

/** Parses Postgres timestamptz text keeping microseconds (Date.parse drops them). */
export function parseTimestamptz(s: string): number {
  const m = s.match(/^(.*?[T ]\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}(?::?\d{2})?)?$/)
  if (!m) return Date.parse(s)
  const [, base, frac = '', tz = 'Z'] = m
  const zone = /^[+-]\d{2}$/.test(tz) ? `${tz}:00` : tz
  return Date.parse(base.replace(' ', 'T') + zone) + (frac ? Number(`0.${frac}`) * 1000 : 0)
}

export async function calibrateClock(samples = 7): Promise<ClockSync> {
  // Resolve auth up front so the timed requests are a bare fetch —
  // supabase.rpc() awaits the session internally, which would skew t0.
  const { data } = await supabase.auth.getSession()
  const headers = {
    apikey: SUPABASE_KEY,
    Authorization: `Bearer ${data.session?.access_token ?? SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  }
  const endpoint = `${SUPABASE_URL}/rest/v1/rpc/server_now`

  async function sample(): Promise<ClockSync> {
    const t0 = localNow()
    const res = await fetch(endpoint, { method: 'POST', headers, body: '{}', cache: 'no-store' })
    const t1 = localNow()
    if (!res.ok) throw new Error(`Clock sync failed (${res.status})`)
    const server = parseTimestamptz((await res.json()) as string)
    return { offsetMs: server - (t0 + t1) / 2, rttMs: t1 - t0, measuredAt: t1 }
  }

  await sample() // warm-up: DNS / TLS / connection setup, discarded
  let best: ClockSync | null = null
  for (let i = 0; i < samples; i++) {
    const s = await sample()
    if (!best || s.rttMs < best.rttMs) best = s
  }
  return best!
}

export type SyncQuality = 'good' | 'ok' | 'poor'

/** Against the ±30–50 ms target. */
export function syncQuality(sync: ClockSync): SyncQuality {
  const err = sync.rttMs / 2
  return err <= 25 ? 'good' : err <= 50 ? 'ok' : 'poor'
}

export function useClockSync() {
  const [sync, setSync] = useState<ClockSync | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [, tick] = useState(0)

  const recalibrate = useCallback(async () => {
    setSyncing(true)
    setError(null)
    try {
      setSync(await calibrateClock())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }, [])

  useEffect(() => {
    recalibrate()
    // Phones suspend background tabs; re-sync when the screen comes back.
    const onVisible = () => { if (document.visibilityState === 'visible') recalibrate() }
    document.addEventListener('visibilitychange', onVisible)
    // Re-render periodically so "stale" is noticed.
    const id = setInterval(() => tick((n) => n + 1), 15_000)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      clearInterval(id)
    }
  }, [recalibrate])

  const stale = sync ? localNow() - sync.measuredAt > SYNC_MAX_AGE_MS : false
  return { sync, syncing, error, stale, recalibrate }
}
