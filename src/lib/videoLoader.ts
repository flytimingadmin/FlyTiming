import { supabase } from './supabase'
import { VIDEO_BUCKET } from './chunkUploader'
import type { Recording } from './types'

/** Lists a recording's uploaded chunk paths, in order. */
export async function listChunks(rec: Recording): Promise<string[]> {
  const prefix = `${rec.race_id}/${rec.id}`
  const { data, error } = await supabase.storage.from(VIDEO_BUCKET)
    .list(prefix, { limit: 10000, sortBy: { column: 'name', order: 'asc' } })
  if (error) throw error
  return (data ?? [])
    .filter((f) => f.name.endsWith(`.${rec.file_ext}`))
    .map((f) => `${prefix}/${f.name}`)
    .sort()
}

/**
 * Downloads every chunk (a few in parallel, order preserved) and joins them
 * into one playable Blob.
 */
export async function loadRecordingBlob(
  rec: Recording, onProgress: (done: number, total: number) => void,
): Promise<Blob> {
  const paths = await listChunks(rec)
  if (!paths.length) throw new Error('No video has been uploaded for this recording yet.')
  const parts: Blob[] = new Array(paths.length)
  let next = 0, done = 0
  onProgress(0, paths.length)
  async function worker() {
    while (next < paths.length) {
      const i = next++
      for (let attempt = 0; ; attempt++) {
        const { data, error } = await supabase.storage.from(VIDEO_BUCKET).download(paths[i])
        if (data) { parts[i] = data; break }
        if (attempt >= 3) throw error ?? new Error(`Couldn’t download ${paths[i]}`)
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)))
      }
      onProgress(++done, paths.length)
    }
  }
  await Promise.all(Array.from({ length: Math.min(4, paths.length) }, worker))
  return new Blob(parts, { type: rec.mime_type.split(';')[0] })
}
