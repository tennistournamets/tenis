/**
 * Full public URL for spectators (registration + bracket).
 * @param {string} slug
 */
export function tournamentShareUrl(slug) {
  const path = `/tournaments/${encodeURIComponent(slug)}`
  if (typeof window === 'undefined') {
    return path
  }
  return `${window.location.origin}${path}`
}

export async function copyTournamentLink(slug) {
  const url = tournamentShareUrl(slug)
  if (typeof navigator === 'undefined' || typeof navigator.clipboard?.writeText !== 'function') {
    throw new Error('Clipboard unavailable')
  }
  await navigator.clipboard.writeText(url)
  return url
}
