/** m:ss.t — for the live start-line clock. */
export function formatTenths(ms: number) {
  if (ms < 0) ms = 0
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  const t = Math.floor((ms % 1000) / 100)
  return `${m}:${String(s).padStart(2, '0')}.${t}`
}

/** m:ss.hh (or ss.hh under a minute) — race-time style; negative before the gun. */
export function formatHundredths(ms: number) {
  const sign = ms < 0 ? '−' : ''
  const abs = Math.abs(ms)
  const m = Math.floor(abs / 60000)
  const s = Math.floor((abs % 60000) / 1000)
  const hh = Math.floor((abs % 1000) / 10)
  const secs = `${m ? String(s).padStart(2, '0') : s}.${String(hh).padStart(2, '0')}`
  return `${sign}${m ? `${m}:` : ''}${secs}`
}

/**
 * Official-style result: rounded UP to the next hundredth (the convention for
 * automatic timing). 10.231 s → "10.24"; 65.2 s → "1:05.20".
 */
export function formatResult(ms: number) {
  return formatHundredths(Math.ceil(ms / 10) * 10)
}
