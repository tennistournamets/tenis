// Who won the tournament, read from the canonical aggregate every format
// writes (winner_entry_id on the deciding match, or the ranking computed by
// get_standings for an all-play-all), plus the matches still to be played
// when the organizer finishes the tournament.
import { knockoutTotals, matchRoundName } from './roundLabels.js'

const KNOCKOUT_FORMATS = new Set(['single_elimination', 'double_elimination', 'groups_playoff'])
const STAGE_ORDER = { group: 0, main: 1, winners: 2, losers: 3, third_place: 4, grand_final: 5 }
const FINAL_STAGE = { single_elimination: 'main', double_elimination: 'grand_final', groups_playoff: 'winners' }

/** The match whose winner is the champion: the last knockout match with nowhere to advance. */
export function finalMatch(format, matches = []) {
  const stage = FINAL_STAGE[format]
  if (!stage) return null
  const candidates = matches.filter(m => m.stage === stage && !m.next_match_id)
  if (!candidates.length) return null
  return candidates.reduce((best, m) => (Number(m.round_number || 0) > Number(best.round_number || 0) ? m : best))
}

function isFinished(match) {
  return match?.status === 'finished'
}

// A group or all-play-all fixture always has both sides; one without them is a
// rest slot, not a match to play. Knockout slots fill up as rounds are played.
function needsPlaying(format, match) {
  if (isFinished(match)) return false
  if (KNOCKOUT_FORMATS.has(format) && match.stage !== 'group') return true
  return Boolean(match.side_a_entry_id && match.side_b_entry_id)
}

/** Matches that have not been played yet, in playing order. */
export function unplayedMatches(format, matches = []) {
  return matches
    .filter(m => needsPlaying(format, m))
    .sort((a, b) => (STAGE_ORDER[a.stage] ?? 9) - (STAGE_ORDER[b.stage] ?? 9)
      || Number(a.round_number || 0) - Number(b.round_number || 0)
      || Number(a.match_number || 0) - Number(b.match_number || 0))
}

/**
 * { entryId, source } or null.
 * Knockout formats: the winner of the final (SE), grand final (DE) or playoff
 * final (groups). Round robin: the standings leader once every match is played,
 * or when the organizer has finished the tournament; a shared first place has
 * no single champion.
 */
export function tournamentChampion({ format, status, matches = [], standings = [] } = {}) {
  if (KNOCKOUT_FORMATS.has(format)) {
    const final = finalMatch(format, matches)
    if (!final || !isFinished(final) || !final.winner_entry_id) return null
    return { entryId: final.winner_entry_id, source: 'final', matchId: final.id }
  }
  if (format === 'round_robin') {
    if (!standings.length || !matches.some(isFinished)) return null
    const complete = unplayedMatches(format, matches).length === 0
    if (!complete && status !== 'completed') return null
    const ranks = standings.map(r => Number(r.rank)).filter(Number.isFinite)
    const top = Math.min(...ranks)
    const leaders = standings.filter(r => Number(r.rank) === top)
    if (leaders.length !== 1 || !leaders[0].entry_id) return null
    return { entryId: leaders[0].entry_id, source: 'standings' }
  }
  return null
}

const SHOWN_UNPLAYED = 8

/**
 * Arguments for confirmDialog before finishing: the usual confirmation when
 * everything is played, otherwise an explicit warning with the unplayed
 * matches (the first few by name, then a count).
 */
export function finishConfirmation({ format, matches = [], label = id => id || '', t }) {
  const unplayed = unplayedMatches(format, matches)
  if (!unplayed.length) return { message: t('admin.finishTournamentConfirm'), options: {}, unplayed: 0 }
  const totals = knockoutTotals(matches, format)
  const items = unplayed.slice(0, SHOWN_UNPLAYED).map(m => ({
    id: m.id,
    title: `${t(`scoringFlow.stage_${m.stage}`)} · ${matchRoundName(m, totals, t)} · №${m.match_number}`,
    teams: `${label(m.side_a_entry_id)} — ${label(m.side_b_entry_id)}`,
    effect: t('lifecycle.unplayed'),
  }))
  if (unplayed.length > SHOWN_UNPLAYED) {
    items.push({ id: 'more', title: '', teams: t('lifecycle.finishUnplayedMore', { n: unplayed.length - SHOWN_UNPLAYED }), effect: '' })
  }
  return {
    message: t('lifecycle.finishUnplayed'),
    unplayed: unplayed.length,
    options: {
      danger: true,
      confirmLabel: t('lifecycle.finishAnyway'),
      details: { intro: t('lifecycle.finishUnplayedIntro', { n: unplayed.length }), warning: t('lifecycle.finishUnplayedWarning'), items },
    },
  }
}
