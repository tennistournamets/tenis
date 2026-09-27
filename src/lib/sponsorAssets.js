// Sponsor images live in the public Storage bucket `sponsor-assets`, under the
// tournament's folder: `<tournament id>/<uuid>.webp`. The browser shrinks every
// upload first (and turns SVG into a picture — the bucket refuses SVG, which
// could carry scripts). An asset reference in the config is `{ path, width,
// height }` for an upload or `{ url, width, height }` for a bundled demo file.
import { supabase } from './supabase'

export const SPONSOR_BUCKET = 'sponsor-assets'
// What the file picker accepts; SVG is rasterized before upload.
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif']
const MAX_SOURCE_BYTES = 8 * 1024 * 1024
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 // bucket limit
const EXTENSIONS = { 'image/webp': 'webp', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif' }

function newId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode'))
    img.src = src
  })
}

function encode(canvas, quality) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', quality))
}

/**
 * Validates and shrinks an upload to fit `maxWidth`×`maxHeight`, re-encoding it
 * as WebP (PNG where the browser cannot encode WebP). Vector SVG is drawn at the
 * full target size so it stays sharp; animated GIF is kept as it is.
 */
export async function prepareImage(file, { maxWidth = 1600, maxHeight = 1600 } = {}) {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new Error('type')
  if (file.size > MAX_SOURCE_BYTES) throw new Error('size')
  if (file.type === 'image/gif') {
    if (file.size > MAX_UPLOAD_BYTES) throw new Error('size')
    const url = URL.createObjectURL(file)
    try {
      const img = await loadImage(url)
      return { blob: file, width: img.naturalWidth || 400, height: img.naturalHeight || 400 }
    } finally {
      URL.revokeObjectURL(url)
    }
  }
  const sourceUrl = URL.createObjectURL(file)
  try {
    const img = await loadImage(sourceUrl)
    const width = img.naturalWidth || 400
    const height = img.naturalHeight || 400
    const vector = file.type === 'image/svg+xml'
    // Raster images only shrink; a vector logo is drawn as large as allowed.
    const fit = Math.min(maxWidth / width, maxHeight / height)
    const scale = vector ? fit : Math.min(1, fit)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(img, 0, 0, w, h)
    let blob = await encode(canvas, 0.9)
    if (blob && blob.size > MAX_UPLOAD_BYTES) blob = await encode(canvas, 0.75)
    if (!blob) throw new Error('decode')
    if (blob.size > MAX_UPLOAD_BYTES) throw new Error('size')
    return { blob, width: w, height: h }
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

/** Uploads a prepared image into the tournament's folder; returns the asset reference. */
export async function uploadAsset(tournamentId, { blob, width, height }) {
  const type = EXTENSIONS[blob.type] ? blob.type : 'image/webp'
  const path = `${tournamentId}/${newId()}.${EXTENSIONS[type]}`
  const { error } = await supabase.storage
    .from(SPONSOR_BUCKET)
    .upload(path, blob, { contentType: type, cacheControl: '31536000', upsert: false })
  if (error) throw new Error('upload')
  return { path, width, height }
}

/** Best effort: a file left behind is only wasted space, never shown. */
export async function deleteAssets(refs) {
  const paths = refs.map((ref) => ref?.path).filter(Boolean)
  if (!paths.length) return
  try {
    await supabase.storage.from(SPONSOR_BUCKET).remove(paths)
  } catch {
    // Offline or no longer allowed: nothing else to do.
  }
}

export function deleteAsset(ref) {
  return deleteAssets([ref])
}

/** Public CDN address of an asset (files are immutable: a new upload = a new path). */
export function resolveAssetUrl(ref) {
  if (!ref) return ''
  if (ref.url) return ref.url
  if (!ref.path) return ''
  return supabase.storage.from(SPONSOR_BUCKET).getPublicUrl(ref.path).data?.publicUrl || ''
}

/**
 * Uploads made inside an editor that may still be cancelled. `commit(before, after)`
 * drops the replaced originals, `discard()` drops everything uploaded since.
 */
export function createAssetDraft() {
  const created = new Set()
  return {
    track(ref) {
      if (ref?.path) created.add(ref.path)
      return ref
    },
    commit(before, after) {
      const kept = new Set(after.filter(Boolean).map((ref) => ref.path).filter(Boolean))
      const drop = [
        ...before.filter((ref) => ref?.path && !kept.has(ref.path)),
        ...[...created].filter((path) => !kept.has(path)).map((path) => ({ path })),
      ]
      created.clear()
      void deleteAssets(drop)
    },
    discard() {
      const drop = [...created].map((path) => ({ path }))
      created.clear()
      void deleteAssets(drop)
    },
  }
}
