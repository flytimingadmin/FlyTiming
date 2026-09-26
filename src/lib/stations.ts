// Which device role this phone is playing. Remembered per phone so a
// start-line volunteer picks "Start" once and every heat opens there.

export type Station = 'lanes' | 'start' | 'finish' | 'score'

export const STATIONS: { key: Station; label: string; path: (raceId: string) => string }[] = [
  { key: 'lanes', label: 'Lanes', path: (id) => `/races/${id}/lanes` },
  { key: 'start', label: 'Start', path: (id) => `/races/${id}/start` },
  { key: 'finish', label: 'Finish', path: (id) => `/races/${id}/finish` },
  { key: 'score', label: 'Score', path: (id) => `/races/${id}/score` },
]

const KEY = 'flytiming.station'

export function readStation(): Station {
  try {
    const v = localStorage.getItem(KEY)
    return STATIONS.some((s) => s.key === v) ? (v as Station) : 'lanes'
  } catch {
    return 'lanes'
  }
}

export function writeStation(s: Station) {
  try { localStorage.setItem(KEY, s) } catch { /* private mode */ }
}
