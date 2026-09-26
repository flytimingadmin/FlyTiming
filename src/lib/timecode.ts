// Burned-in timecode strip (recordings.timecode_version = 1).
//
// Every recorded frame carries its synced capture time (epoch ms, low 32 bits)
// as a row of black/white cells along the bottom edge, so the scoring screen
// reads the time straight off the pixels — no reliance on container
// timestamps or when MediaRecorder happened to start.
//
// Layout, 40 equal cells left → right:
//   [1,0] guard · 32 data bits (MSB first) · 4-bit checksum · [0,1] guard
// Cells are wide (≈32 px at 1280) so they survive video compression.

export const TC_CELLS = 40
const TWO_32 = 2 ** 32

function checksum(v: number) {
  let s = 0
  for (let i = 0; i < 8; i++) s += (v >>> (i * 4)) & 0xf
  return s & 0xf
}

export function encodeTimecode(ms: number): number[] {
  const v = Math.floor(ms) >>> 0
  const c = checksum(v)
  const bits = [1, 0]
  for (let i = 31; i >= 0; i--) bits.push((v >>> i) & 1)
  for (let i = 3; i >= 0; i--) bits.push((c >>> i) & 1)
  bits.push(0, 1)
  return bits
}

/** Strip height for a given frame width. */
export const timecodeHeight = (width: number) => Math.max(12, Math.round(width / TC_CELLS / 2))

export function drawTimecode(ctx: CanvasRenderingContext2D, ms: number, width: number, height: number) {
  const h = timecodeHeight(width)
  const y = height - h
  const cw = width / TC_CELLS
  ctx.fillStyle = '#000'
  ctx.fillRect(0, y, width, h)
  ctx.fillStyle = '#fff'
  encodeTimecode(ms).forEach((b, i) => {
    if (b) ctx.fillRect(Math.floor(i * cw), y, Math.ceil(cw), h)
  })
}

/**
 * Reads the strip from a frame. `luma(x, y)` returns 0–255 brightness.
 * Returns the low 32 bits of the timestamp, or null if unreadable.
 */
export function decodeTimecode(
  luma: (x: number, y: number) => number, width: number, height: number,
): number | null {
  const h = timecodeHeight(width)
  const cw = width / TC_CELLS
  const cell = (i: number) => {
    // Average the middle of the cell, away from blurred edges.
    let sum = 0, n = 0
    for (let dy = 0.3; dy <= 0.7; dy += 0.2) {
      for (let dx = 0.3; dx <= 0.7; dx += 0.2) {
        sum += luma(Math.floor((i + dx) * cw), Math.floor(height - h + dy * h))
        n++
      }
    }
    return sum / n
  }
  const values = Array.from({ length: TC_CELLS }, (_, i) => cell(i))
  const white = (values[0] + values[TC_CELLS - 1]) / 2
  const black = (values[1] + values[TC_CELLS - 2]) / 2
  if (white - black < 60) return null // no strip in this frame
  const threshold = (white + black) / 2
  const bits = values.map((v) => (v > threshold ? 1 : 0))
  if (bits[0] !== 1 || bits[1] !== 0 || bits[38] !== 0 || bits[39] !== 1) return null
  let v = 0
  for (let i = 0; i < 32; i++) v = v * 2 + bits[2 + i]
  let c = 0
  for (let i = 0; i < 4; i++) c = c * 2 + bits[34 + i]
  return checksum(v) === c ? v : null
}

/** Restores full epoch ms from the low 32 bits, using a nearby reference time. */
export function unwrapTimecode(low32: number, referenceMs: number) {
  const base = referenceMs - (((referenceMs % TWO_32) + TWO_32) % TWO_32)
  const candidates = [base - TWO_32, base, base + TWO_32].map((b) => b + low32)
  return candidates.reduce((best, c) => (Math.abs(c - referenceMs) < Math.abs(best - referenceMs) ? c : best))
}
