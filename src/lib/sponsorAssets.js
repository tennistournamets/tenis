// Sponsor images: uploads are downscaled in the browser and kept as blobs in
// IndexedDB (a prototype stand-in for Supabase Storage). An asset reference is
// `{ id, width, height }` for an upload or `{ url, width, height }` for a static
// file (demo sponsors). resolveAssetUrl() is reactive: it returns '' until the
// blob is read, then the object URL.
import { reactive } from 'vue'

const DB_NAME = 'bracketa_sponsor_assets'
const STORE = 'assets'
const MAX_FILE_BYTES = 8 * 1024 * 1024
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif']

const urls = reactive({})
const pending = new Set()
let dbPromise = null

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const request = globalThis.indexedDB?.open(DB_NAME, 1)
      if (!request) { reject(new Error('indexeddb')); return }
      request.onupgradeneeded = () => request.result.createObjectStore(STORE)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }
  return dbPromise
}

async function withStore(mode, action) {
  const db = await openDb()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const request = action(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(request?.result)
    tx.onerror = () => reject(tx.error)
  })
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || `a${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('decode'))
    img.src = src
  })
}

/**
 * Validates and shrinks an upload to fit `maxWidth`×`maxHeight`, re-encoding
 * raster images as WebP (PNG where the browser cannot encode WebP). SVG and GIF
 * are kept as they are (vector / animation).
 */
export async function prepareImage(file, { maxWidth = 1600, maxHeight = 1600 } = {}) {
  if (!ACCEPTED_TYPES.includes(file.type)) throw new Error('type')
  if (file.size > MAX_FILE_BYTES) throw new Error('size')
  const sourceUrl = URL.createObjectURL(file)
  try {
    const img = await loadImage(sourceUrl)
    const width = img.naturalWidth || 400
    const height = img.naturalHeight || 400
    if (file.type === 'image/svg+xml' || file.type === 'image/gif') {
      return { blob: file, width, height }
    }
    const scale = Math.min(1, maxWidth / width, maxHeight / height)
    const w = Math.max(1, Math.round(width * scale))
    const h = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    canvas.getContext('2d').drawImage(img, 0, 0, w, h)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
    if (!blob) throw new Error('decode')
    return { blob, width: w, height: h }
  } finally {
    URL.revokeObjectURL(sourceUrl)
  }
}

/** Stores a prepared image; returns the asset reference to keep in the sponsorship config. */
export async function saveAsset({ blob, width, height }) {
  const id = newId()
  await withStore('readwrite', (store) => store.put(blob, id))
  urls[id] = URL.createObjectURL(blob)
  return { id, width, height }
}

export async function deleteAsset(ref) {
  if (!ref?.id) return
  try {
    await withStore('readwrite', (store) => store.delete(ref.id))
  } catch {
    // Already gone or storage unavailable: nothing to clean up.
  }
  if (urls[ref.id]) URL.revokeObjectURL(urls[ref.id])
  delete urls[ref.id]
}

async function loadAsset(id) {
  pending.add(id)
  try {
    const blob = await withStore('readonly', (store) => store.get(id))
    if (blob) urls[id] = URL.createObjectURL(blob)
  } catch {
    // Missing blob (other browser, cleared storage): the slot falls back to text.
  } finally {
    pending.delete(id)
  }
}

export function resolveAssetUrl(ref) {
  if (!ref) return ''
  if (ref.url) return ref.url
  if (!ref.id) return ''
  if (!urls[ref.id] && !pending.has(ref.id)) void loadAsset(ref.id)
  return urls[ref.id] || ''
}

/**
 * Uploads made inside an editor that may still be cancelled. `commit(before, after)`
 * drops the replaced originals, `discard()` drops everything uploaded since.
 */
export function createAssetDraft() {
  const created = new Set()
  return {
    track(ref) {
      if (ref?.id) created.add(ref.id)
      return ref
    },
    commit(before, after) {
      const kept = new Set(after.filter(Boolean).map((ref) => ref.id).filter(Boolean))
      for (const ref of before) if (ref?.id && !kept.has(ref.id)) void deleteAsset(ref)
      for (const id of created) if (!kept.has(id)) void deleteAsset({ id })
      created.clear()
    },
    discard() {
      for (const id of created) void deleteAsset({ id })
      created.clear()
    },
  }
}
