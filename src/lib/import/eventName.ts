// Turns meet-software event names into FlyTiming's fields.
//   "Varsity Girls 100 Meter Hurdles Prelims" → { division: 'Varsity', gender: 'F', event: '100m Hurdles', round: 'prelim' }
//   "Boys 4x400 Meter Relay"                  → { gender: 'M', event: '4x400m Relay' }
// Event names match the style Athletic.net expects ("100m", "110m Hurdles", "4x100m Relay").

import type { Gender } from '../types'

export interface ParsedEventName {
  division: string | null
  gender: Gender | null
  event: string
  round: 'prelim' | 'final' | null
}

const GENDERS: [RegExp, Gender][] = [
  [/\b(girls?|women'?s?|womens|female|ladies)\b/i, 'F'],
  [/\b(boys?|men'?s?|mens|male)\b/i, 'M'],
  [/\b(mixed|coed|co-ed)\b/i, 'X'],
]

const DIVISIONS: [RegExp, string][] = [
  [/\bjunior\s+varsity\b|\bj\.?v\.?\b/i, 'JV'],
  [/\bvarsity\b/i, 'Varsity'],
  [/\bfrosh[\s/-]*soph(omore)?\b|\bf\/s\b/i, 'Frosh/Soph'],
  [/\bfresh(man|men)\b|\bfrosh\b/i, 'Freshman'],
  [/\bsophomores?\b/i, 'Sophomore'],
  [/\bopen\b/i, 'Open'],
  [/\b(middle school|ms)\b/i, 'Middle School'],
  [/\b(\d{1,2})(st|nd|rd|th)\s+grade\b/i, '$1th Grade'],
]

const ROUNDS: [RegExp, 'prelim' | 'final'][] = [
  [/\b(prelims?|preliminar(y|ies)|trials?|semis?|semi-?finals?|quarter-?finals?)\b/i, 'prelim'],
  [/\b(timed\s+finals?|finals?)\b/i, 'final'],
]

const M = String.raw`(?:m|meters?|metres?|mtrs?)\b`

export function parseEventName(raw: string): ParsedEventName {
  let s = ` ${raw.replace(/\s+/g, ' ').trim()} `
  let gender: Gender | null = null
  let division: string | null = null
  let round: 'prelim' | 'final' | null = null

  for (const [re, g] of GENDERS) if (re.test(s)) { gender = g; s = s.replace(re, ' '); break }
  for (const [re, d] of DIVISIONS) {
    const m = s.match(re)
    if (m) { division = d.replace('$1', m[1] ?? ''); s = s.replace(re, ' '); break }
  }
  for (const [re, r] of ROUNDS) if (re.test(s)) { round = r; s = s.replace(re, ' '); break }
  s = s.replace(/\b(dash|run|race)\b/gi, ' ').replace(/\s+/g, ' ').trim()

  let event: string
  let m: RegExpMatchArray | null
  if ((m = s.match(new RegExp(String.raw`\b(\d)\s*x\s*(\d+)\s*(?:${M})?\s*(?:relay)?`, 'i')))) {
    event = `${m[1]}x${m[2]}m Relay`
  } else if (/\b(sprint|distance|shuttle)\s+medley\b/i.test(s)) {
    event = s.replace(/\bsmr\b|\bdmr\b/gi, '').trim().replace(/\b\w/g, (c) => c.toUpperCase())
    if (!/relay/i.test(event)) event += ' Relay'
  } else if ((m = s.match(new RegExp(String.raw`\b(\d+)\s*(?:${M})?\s*(?:hurdles|hh|ih|lh|sh)\b`, 'i')))) {
    event = `${m[1]}m Hurdles`
  } else if ((m = s.match(new RegExp(String.raw`\b(\d+)\s*(?:${M})?\s*steeple(chase)?\b`, 'i')))) {
    event = `${m[1]}m Steeplechase`
  } else if ((m = s.match(new RegExp(String.raw`\b(\d+)\s*(?:${M})?\s*(race\s*)?walk\b`, 'i')))) {
    event = `${m[1]}m Racewalk`
  } else if ((m = s.match(new RegExp(String.raw`\b(\d+)\s*${M}`, 'i'))) || (m = s.match(/^(\d{2,5})$/))) {
    event = `${m[1]}m`
  } else if (/\bmile\b/i.test(s)) {
    event = /\b(two|2)\b/i.test(s) ? '2 Mile' : 'Mile'
  } else {
    event = s || raw.trim()
  }
  return { division, gender, event, round }
}

export function parseGender(v: string): Gender | null {
  const t = v.trim().toLowerCase()
  if (!t) return null
  if (/^(f|g|w|girls?|women|womens|female|ladies)$/.test(t)) return 'F'
  if (/^(m|b|boys?|men|mens|male)$/.test(t)) return 'M'
  if (/^(x|mixed|coed|co-ed)$/.test(t)) return 'X'
  return parseEventName(v).gender
}
