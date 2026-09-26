// The draw mode an organizer picked for a tournament, remembered on this
// device so a reload does not silently switch a manual draw back to random.
// Storage can be missing or throw (private mode, blocked site data).
const MODES = new Set(['auto-random', 'manual'])
const key = tournamentId => `champ_draw_mode:${tournamentId}`
const defaultStorage = () => (typeof localStorage === 'undefined' ? null : localStorage)

export function readDrawMode(tournamentId, storage = defaultStorage()) {
  try {
    const mode = storage?.getItem(key(tournamentId))
    return MODES.has(mode) ? mode : 'auto-random'
  } catch {
    return 'auto-random'
  }
}

export function writeDrawMode(tournamentId, mode, storage = defaultStorage()) {
  if (!MODES.has(mode)) return
  try { storage?.setItem(key(tournamentId), mode) } catch { /* not remembered */ }
}
