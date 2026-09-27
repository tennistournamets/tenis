// Padel points formats (Americano, Mexicano, Team Americano, King of the Court):
// rounds, rests and plans shown before and after generation. Pure functions
// mirroring the SQL generators (docs/PADEL_FORMATS.md); the server owns them.
import { isDynamicFormat, isIndividualFormat } from './sportConfig.js'
import { sideEntryIds } from './entryDisplay.js'

/** Entries of every slot of a match: both players of each side. */
export const matchEntryIds = match => [...sideEntryIds(match, 'a'), ...sideEntryIds(match, 'b')]

/** The generated field (format_config.roster), or the approved entries before a draw. */
export function pointsRoster(tournament, approvedEntries = []) {
  const roster = tournament?.format_config?.roster
  return Array.isArray(roster) ? roster : approvedEntries.map(e => e.id)
}

/**
 * Rounds in playing order: their matches by court, who rests, and whether the
 * round is played out. A rest counts once the whole round is finished.
 */
export function pointsRounds(matches = [], roster = []) {
  const byRound = new Map()
  for (const m of matches) {
    const round = Number(m.round_number) || 0
    if (!byRound.has(round)) byRound.set(round, [])
    byRound.get(round).push(m)
  }
  return [...byRound.entries()]
    .sort(([a], [b]) => a - b)
    .map(([round, list]) => {
      const sorted = [...list].sort((a, b) => (a.match_number || 0) - (b.match_number || 0))
      const playing = new Set(sorted.flatMap(matchEntryIds))
      return {
        round,
        matches: sorted,
        resting: roster.filter(id => !playing.has(id)),
        finished: sorted.every(m => m.status === 'finished'),
      }
    })
}

/** The round being played now: the first one with a match left, else the last. */
export function currentRound(rounds = []) {
  return rounds.find(r => !r.finished) || rounds[rounds.length - 1] || null
}

const clamp = (value, min, max) => Math.min(max, Math.max(min, value))

/**
 * What the generator will build for n approved entries.
 * { n, valid, reason, courts, maxCourts, rounds, maxRounds, perRound, resting, matches, dynamic }
 * reason is an i18n key suffix (pointsFormat.*) when the field cannot be drawn.
 */
export function pointsPlan(format, n, { courts = null, rounds = null } = {}) {
  const count = Math.max(0, Number(n) || 0)
  const dynamic = isDynamicFormat(format)
  if (format === 'team_americano') {
    const valid = count >= 3
    const tours = count % 2 ? count : count - 1
    return {
      n: count, valid, reason: valid ? null : 'minPairs', dynamic,
      courts: Math.floor(count / 2), maxCourts: Math.floor(count / 2),
      rounds: valid ? tours : 0, maxRounds: valid ? tours : 0,
      perRound: Math.floor(count / 2), resting: count % 2,
      matches: valid ? (count * (count - 1)) / 2 : 0,
    }
  }
  const maxCourts = Math.floor(count / 4)
  let reason = count < 4 ? 'minPlayers' : null
  if (!reason && format === 'king_of_court' && (count < 8 || count % 4)) reason = 'kotcPlayers'
  const valid = !reason
  const c = format === 'king_of_court' ? maxCourts : clamp(Number(courts) || maxCourts, 1, Math.max(1, maxCourts))
  const cycle = count % 2 ? count : count - 1
  const r = format === 'americano' ? clamp(Number(rounds) || cycle, 1, Math.max(1, 3 * cycle)) : null
  return {
    n: count, valid, reason, dynamic,
    courts: valid ? c : 0, maxCourts,
    rounds: valid ? r : null, maxRounds: format === 'americano' ? 3 * cycle : null, cycle,
    perRound: valid ? c : 0, resting: valid ? count - 4 * c : 0,
    matches: valid && r ? r * c : null,
  }
}

// About 45 seconds a rally with changeovers: a match to 24 takes some 18 minutes.
export const roundMinutes = target => Math.round((Number(target) || 24) * 0.75)

/** Entries shown as a player (individual formats) or as a pair (Team Americano). */
export const entryIsPlayer = format => isIndividualFormat(format)

/** Points still missing to close the total: the second field of a score form. */
export function complementScore(value, target) {
  const n = Number(value)
  if (value === '' || value == null || !Number.isInteger(n) || n < 0 || n > target) return ''
  return String(target - n)
}
