// Picks the richest affordable rendering tier for the live rally scene based
// on the Network Information API. Safari has no navigator.connection — treat
// the network as good and let the load timeout demote instead.
//
// Payload per tier:
//   '2d'         — nothing extra (SVG scene ships in the main bundle)
//   'primitives' — three.js scene chunk, ~156 KB gzip (fine from ~0.5 Mbps)
//   'characters' — + quaternius.glb, 2.2 MB (fine from ~2 Mbps with a 10s cap)

export const GLB_TIMEOUT_MS = 10000

export function maxNetworkTier() {
  const conn =
    typeof navigator !== 'undefined'
      ? navigator.connection || navigator.mozConnection || navigator.webkitConnection
      : null

  if (!conn) return 'characters' // unknown (Safari etc.) — optimistic, timeout guards us

  if (conn.saveData) return '2d'
  const type = conn.effectiveType || ''
  if (type === 'slow-2g' || type === '2g') return '2d'
  if (type === '3g' || (typeof conn.downlink === 'number' && conn.downlink > 0 && conn.downlink < 1.5)) {
    return 'primitives'
  }
  return 'characters'
}

// Rejects after ms so a stalled download can't hold the scene hostage.
export function withTimeout(promise, ms, label = 'load') {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    }),
  ])
}
