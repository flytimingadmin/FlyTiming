// Finish-line guide: a line the finish-phone operator aligns with the painted
// finish line. It's burned into every recorded frame so the scorer judges
// the torso against exactly the same line. It can tilt, because a phone
// that isn't perfectly in line with the finish sees the line at an angle.

import { timecodeHeight } from './timecode'

/** Horizontal positions (0–1 of frame width) where the line meets the top and bottom edges. */
export interface FinishLine { top: number; bottom: number }

export const CENTER_LINE: FinishLine = { top: 0.5, bottom: 0.5 }
const KEY = 'flytiming.finishLine'

export function readFinishLine(): FinishLine {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null')
    if (typeof v?.top === 'number' && typeof v?.bottom === 'number') return v
  } catch { /* ignore */ }
  return CENTER_LINE
}

export function writeFinishLine(line: FinishLine) {
  try { localStorage.setItem(KEY, JSON.stringify(line)) } catch { /* private mode */ }
}

export function drawFinishLine(ctx: CanvasRenderingContext2D, w: number, h: number, line: FinishLine) {
  const y2 = h - timecodeHeight(w)
  const width = Math.max(3, Math.round(w / 400))
  ctx.beginPath()
  ctx.moveTo(line.top * w, 0)
  ctx.lineTo(line.bottom * w, y2)
  ctx.lineCap = 'butt'
  // Dark edge + Electric Blue core reads on red, blue or black track surfaces.
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.75)'
  ctx.lineWidth = width + 2
  ctx.stroke()
  ctx.strokeStyle = '#2e8bff'
  ctx.lineWidth = width
  ctx.stroke()
}
