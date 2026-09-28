// FlyTiming gun detector v2 — runs on the audio thread.
//
// A starting gun is a sharp, broadband blast with lots of high-frequency
// energy. Handling noise on a forearm-strapped phone (screen taps, strap
// rub, bumps) is mostly low-frequency and very short; voices sit low too.
// So we:
//   1. high-pass the signal at ~1.5 kHz (2nd-order Butterworth),
//   2. measure RMS over a sliding 3 ms window (a single click can't pass),
//   3. trigger when that RMS is above the threshold AND jumped by ≥ riseDb
//      compared with the same window 5 ms earlier. A gun goes from
//      background to full blast in < 1 ms; crowd roar, cheering swells and
//      air horns build over tens of ms, so they can't pass however loud,
//   4. ignore the first 400 ms after arming (the Set tap's own thump).
// The reported frame is the first sample of the blast (sample-accurate).
//
// Messages out:
//   { type: 'level', frameEnd, peakDb, floorDb, thresholdDb }   ~every 50 ms
//   { type: 'gun',   frame, peakDb, floorDb }                   armed trigger
//   { type: 'hit',   frame, peakDb }                            would-trigger while not armed
// Messages in:
//   { type: 'arm', armed }   { type: 'config', thresholdDb, riseDb }

const dbToLin = (db) => Math.pow(10, db / 20)
const linToDb = (x) => (x > 0 ? 20 * Math.log10(x) : -120)
const HPF_HZ = 1500
const WINDOW_S = 0.003
const ARM_GUARD_S = 0.4
const LOOKBACK_S = 0.005

class GunDetector extends AudioWorkletProcessor {
  constructor() {
    super()
    this.armed = false
    this.armGuard = 0
    this.thresholdDb = -12
    this.riseDb = 15
    this.floorRms = dbToLin(-70)
    this.cooldown = 0
    this.meterFrames = 0
    this.meterPeak = 0
    this.pending = null // trigger waiting ~20 ms to measure the blast's peak

    // RBJ biquad high-pass, Q = 1/√2
    const w0 = (2 * Math.PI * HPF_HZ) / sampleRate
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2)
    const cos = Math.cos(w0)
    const a0 = 1 + alpha
    this.b0 = (1 + cos) / 2 / a0
    this.b1 = -(1 + cos) / a0
    this.b2 = (1 + cos) / 2 / a0
    this.a1 = (-2 * cos) / a0
    this.a2 = (1 - alpha) / a0
    this.x1 = this.x2 = this.y1 = this.y2 = 0

    this.W = Math.max(8, Math.round(WINDOW_S * sampleRate))
    this.D = Math.round(LOOKBACK_S * sampleRate)
    this.ring = new Float64Array(2048)
    this.ringIdx = 0
    this.sumSq = 0
    this.sumSqPrev = 0 // same-size window ending D samples ago
    this.samplesSeen = 0

    this.port.onmessage = (e) => {
      const m = e.data
      if (m.type === 'arm') {
        if (m.armed && !this.armed) this.armGuard = Math.round(ARM_GUARD_S * sampleRate)
        this.armed = m.armed
      }
      if (m.type === 'config') { this.thresholdDb = m.thresholdDb; this.riseDb = m.riseDb }
    }
  }

  process(inputs, outputs) {
    const ch = inputs[0] && inputs[0][0]
    if (outputs[0] && outputs[0][0]) outputs[0][0].fill(0)
    if (!ch) return true
    const n = ch.length
    const R = this.ring.length
    const W = this.W
    const D = this.D
    const threshold = dbToLin(this.thresholdDb)
    const rise = dbToLin(this.riseDb)
    let blockPeakRms = 0
    let triggered = false

    for (let i = 0; i < n; i++) {
      const x = ch[i]
      const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2
      this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y

      const old = this.ring[(this.ringIdx - W + R) % R]
      const inPrev = this.ring[(this.ringIdx - D + R) % R]
      const outPrev = this.ring[(this.ringIdx - D - W + R) % R]
      this.ring[this.ringIdx] = y
      this.sumSq += y * y - old * old
      this.sumSqPrev += inPrev * inPrev - outPrev * outPrev
      this.ringIdx = (this.ringIdx + 1) % R
      this.samplesSeen++
      if (this.samplesSeen < W + D) continue
      const rms = Math.sqrt(Math.max(0, this.sumSq) / W)
      const rmsPrev = Math.sqrt(Math.max(0, this.sumSqPrev) / W)
      if (rms > blockPeakRms) blockPeakRms = rms
      if (this.pending) {
        if (rms > this.pending.peak) this.pending.peak = rms
        if (--this.pending.remaining <= 0) {
          const p = this.pending
          this.pending = null
          // The start time is p.frame (the blast's first sample); reporting
          // 20 ms later only lets us include the true peak level.
          this.port.postMessage({ type: p.type, frame: p.frame, peakDb: linToDb(p.peak), floorDb: linToDb(this.floorRms) })
        }
      }

      if (!triggered && this.cooldown <= 0 && rms >= threshold && rms >= Math.max(rmsPrev, 1e-7) * rise) {
        // Just after arming: the Set tap's own thump. Ignore it without
        // starting the cooldown, so a gun right after still counts.
        if (this.armed && this.armGuard > i) continue
        triggered = true
        // Onset: earliest sample in the window that reached half the threshold.
        let back = 0
        for (let k = W; k >= 1; k--) {
          if (Math.abs(this.ring[(this.ringIdx - k + R) % R]) >= threshold * 0.5) { back = k - 1; break }
        }
        const frame = currentFrame + i - back
        const type = this.armed ? 'gun' : 'hit'
        this.armed = false
        this.pending = { type, frame, peak: rms, remaining: Math.round(0.02 * sampleRate) }
        this.cooldown = sampleRate // ignore echoes / the rest of the blast for 1 s
      }
    }
    // Keep the running sum from drifting (float error) — recompute each block.
    let s = 0, sp = 0
    for (let k = 1; k <= W; k++) {
      const v = this.ring[(this.ringIdx - k + R) % R]; s += v * v
      const u = this.ring[(this.ringIdx - D - k + R) % R]; sp += u * u
    }
    this.sumSq = s
    this.sumSqPrev = sp

    if (!triggered) {
      // Background level: slow average (~0.75 s) of the filtered RMS.
      const rms = Math.sqrt(s / W)
      this.floorRms += (rms - this.floorRms) * Math.min(1, n / (sampleRate * 0.75))
      if (this.floorRms < 1e-7) this.floorRms = 1e-7
    }
    this.cooldown -= n
    this.armGuard = Math.max(0, this.armGuard - n)

    this.meterPeak = Math.max(this.meterPeak, blockPeakRms)
    this.meterFrames += n
    if (this.meterFrames >= sampleRate * 0.05) {
      this.port.postMessage({
        type: 'level', frameEnd: currentFrame + n,
        peakDb: linToDb(this.meterPeak), floorDb: linToDb(this.floorRms), thresholdDb: this.thresholdDb,
      })
      this.meterFrames = 0
      this.meterPeak = 0
    }
    return true
  }
}

registerProcessor('gun-detector', GunDetector)
