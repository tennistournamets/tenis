// What a knockout draw does with the seeds and the BYEs, for the line under the
// draw mode. Mirrors tennis_seed_count() and knockout_tennis_slots() on the
// server: the seeded draw puts the seeds on fixed lines and gives them the
// BYEs first; the strict one gives BYEs to the top numbers; the random one to
// whoever the lot picks.

export const DRAW_MODES = ['seeded', 'auto-random', 'manual']

export function drawSize(count) {
  let size = 1
  while (size < count) size *= 2
  return size
}

/** Seeds in a draw of `size` lines: 2 up to 8, 4 up to 16, 8 up to 32, 16 above (ITF/LTS). */
export function tennisSeedCount(size) {
  return size <= 8 ? 2 : size <= 16 ? 4 : size <= 32 ? 8 : 16
}

/**
 * { size, byes, seeds, byesToSeeds, byesByLot, unseeded } for `count` entries.
 * `seeds` is 0 outside the seeded mode.
 */
export function drawSummary(mode, count) {
  const size = drawSize(count)
  const byes = Math.max(size - count, 0)
  const seeds = mode === 'seeded' && count >= 2 ? Math.min(tennisSeedCount(size), count) : 0
  const byesToSeeds = Math.min(byes, seeds)
  return { size, byes, seeds, byesToSeeds, byesByLot: byes - byesToSeeds, unseeded: count - seeds }
}
