// What a format will produce for a given field, shown before the organizer
// commits to generating it. Pure arithmetic that mirrors the SQL generators.

export function roundRobinPlan(n) {
  const count = Math.max(0, Number(n) || 0)
  return { n: count, matches: (count * (count - 1)) / 2, rounds: count < 2 ? 0 : count % 2 ? count : count - 1 }
}

// generate_groups snake-distributes the approved field; each group plays all-play-all.
export function groupPlan(n, groupCount, advancePerGroup = 2) {
  const count = Math.max(0, Number(n) || 0)
  const g = Math.max(1, Number(groupCount) || 1)
  const base = Math.floor(count / g)
  const extra = count % g
  const sizes = Array.from({ length: g }, (_, i) => base + (i < extra ? 1 : 0))
  const matches = sizes.reduce((sum, k) => sum + (k * (k - 1)) / 2, 0)
  const advance = Math.max(1, Number(advancePerGroup) || 2)
  return { n: count, groups: g, sizes, minSize: Math.min(...sizes), maxSize: Math.max(...sizes), matches, advance, qualifiers: g * advance }
}

/**
 * The group stage barely filters when (almost) everyone advances, for example
 * 8 of 9: 'all' when nobody is knocked out, 'almostAll' when one is.
 */
export function groupAdvanceWarning(plan) {
  if (!plan || plan.n < 3 || !plan.qualifiers) return null
  const out = plan.n - plan.qualifiers
  return out <= 0 ? 'all' : out === 1 ? 'almostAll' : null
}

// generate_groups needs at least two entries per group.
export function groupCountOptions(n, max = 8) {
  const count = Math.max(0, Number(n) || 0)
  const options = []
  for (let g = 2; g <= Math.min(max, Math.floor(count / 2)); g++) options.push(g)
  return options
}

export const isPowerOfTwo = n => Number.isInteger(n) && n > 0 && (n & (n - 1)) === 0

export function bracketPlan(n, format = 'single_elimination') {
  const count = Math.max(0, Number(n) || 0)
  const size = count < 2 ? 0 : 2 ** Math.ceil(Math.log2(count))
  const rounds = size ? Math.log2(size) : 0
  if (format === 'double_elimination') {
    // No byes in v1: other counts produce no bracket, so there is nothing to count.
    const valid = count >= 2 && isPowerOfTwo(count)
    return { n: count, size, rounds, byes: size - count, upper: valid ? size - 1 : 0, lower: valid && size > 2 ? size - 2 : 0, final: valid ? 1 : 0, valid }
  }
  return { n: count, size, rounds, byes: size - count, matches: count ? count - 1 : 0, valid: count >= 2 }
}
