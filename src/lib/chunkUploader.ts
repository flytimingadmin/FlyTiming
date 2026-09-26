import { supabase } from './supabase'

export const VIDEO_BUCKET = 'race-video'

export interface UploadProgress {
  uploaded: number
  queued: number
  retrying: boolean
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Uploads MediaRecorder chunks in order to <prefix>/<00000>.<ext>, retrying
 * with backoff on flaky venue Wi-Fi. Chunks stay in memory until uploaded.
 */
export class ChunkUploader {
  private queue: { seq: number; blob: Blob }[] = []
  private nextSeq = 0
  private running = false
  private uploaded = 0
  private retrying = false
  private idle: (() => void)[] = []

  constructor(
    private prefix: string,
    private ext: string,
    private contentType: string,
    private onProgress: (p: UploadProgress) => void,
  ) {}

  get count() { return this.nextSeq }

  enqueue(blob: Blob) {
    if (!blob.size) return
    this.queue.push({ seq: this.nextSeq++, blob })
    this.emit()
    void this.pump()
  }

  /** Resolves once every queued chunk is uploaded. */
  drained(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve()
    return new Promise((r) => this.idle.push(r))
  }

  private emit() {
    this.onProgress({ uploaded: this.uploaded, queued: this.queue.length, retrying: this.retrying })
  }

  private async pump() {
    if (this.running) return
    this.running = true
    let backoff = 1000
    while (this.queue.length) {
      const { seq, blob } = this.queue[0]
      const path = `${this.prefix}/${String(seq).padStart(5, '0')}.${this.ext}`
      const { error } = await supabase.storage
        .from(VIDEO_BUCKET)
        .upload(path, blob, { contentType: this.contentType, upsert: false })
      // A retry after a lost response finds the chunk already there — that's success.
      const duplicate = error && /exists|duplicate/i.test(error.message)
      if (error && !duplicate) {
        this.retrying = true
        this.emit()
        await sleep(backoff)
        backoff = Math.min(backoff * 2, 8000)
        continue
      }
      backoff = 1000
      this.retrying = false
      this.queue.shift()
      this.uploaded++
      this.emit()
    }
    this.running = false
    this.idle.splice(0).forEach((r) => r())
  }
}

/** Best recorder format this browser supports; mp4 first so every scorer can play it. */
export function pickRecorderFormat() {
  const options = [
    { mime: 'video/mp4;codecs=avc1', ext: 'mp4', base: 'video/mp4' },
    { mime: 'video/mp4', ext: 'mp4', base: 'video/mp4' },
    { mime: 'video/webm;codecs=vp9', ext: 'webm', base: 'video/webm' },
    { mime: 'video/webm;codecs=vp8', ext: 'webm', base: 'video/webm' },
    { mime: 'video/webm', ext: 'webm', base: 'video/webm' },
  ]
  if (typeof MediaRecorder === 'undefined') return null
  return options.find((o) => MediaRecorder.isTypeSupported(o.mime)) ?? null
}
