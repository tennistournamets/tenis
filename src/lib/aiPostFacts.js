// Social posts: what happened, worked out here from the tournament snapshot, so the model only
// writes the text. Participants travel as tokens (P1, P2, …): the model never sees a name and
// cannot misspell one; the browser puts the names back.
import { entryDisplayNames, sideEntryIds } from './entryDisplay.js'
import { knockoutTotals, matchStageRoundLabel } from './roundLabels.js'
import { isPointsFormat, scoringFamily } from './sportConfig.js'
import { formatSetScore } from './tennisRules.js'

const RESULTS_MAX = 16
const TABLE_MAX = 5
const NEXT_MAX = 6
export const TOKEN = /\bP(\d{1,3})\b/g

const KNOCKOUT_FINAL_STAGES = ['main', 'winners', 'grand_final']
const roundKey = match => `${match.stage === 'group' ? 'group' : match.stage || 'main'}:${match.round_number ?? 0}`
const played = match => match.status === 'finished' && match.side_a_entry_id && match.side_b_entry_id

/** The final of a knockout (the grand final in a double elimination), if the format has one. */
export function finalMatch(tournament, matches = []) {
  if (isPointsFormat(tournament?.format) || tournament?.format === 'round_robin') return null
  const grand = matches.find(match => match.stage === 'grand_final')
  if (grand) return grand
  const knockout = matches.filter(match => KNOCKOUT_FINAL_STAGES.includes(match.stage))
  if (!knockout.length) return null
  const last = Math.max(...knockout.map(match => match.round_number ?? 0))
  const finals = knockout.filter(match => (match.round_number ?? 0) === last)
  return finals.length === 1 ? finals[0] : null
}

/**
 * What a post can be about: the results (tournament completed or its final played) and the
 * rounds where every match is played, latest first. Each: { key, label }.
 */
export function postMoments({ tournament, matches = [] }, t) {
  const moments = []
  const final = finalMatch(tournament, matches)
  if (tournament?.status === 'completed' || (final && final.status === 'finished')) {
    moments.push({ key: 'results', label: t('ai.posts.moment.results') })
  }
  const rounds = new Map()
  for (const match of matches) {
    if (!match.side_a_entry_id && !match.side_b_entry_id) continue
    const key = roundKey(match)
    if (!rounds.has(key)) rounds.set(key, [])
    rounds.get(key).push(match)
  }
  const label = roundLabeler(tournament, matches, t)
  const complete = [...rounds.entries()]
    .filter(([, list]) => list.every(match => match.status === 'finished') && list.some(played))
    .sort(([, a], [, b]) => (b[0].round_number ?? 0) - (a[0].round_number ?? 0))
    .filter(([key]) => !(final && key === roundKey(final)))
    .slice(0, 3)
  for (const [key, list] of complete) moments.push({ key: `round:${key}`, label: label(list[0]) })
  return moments
}

function roundLabeler(tournament, matches, t) {
  if (isPointsFormat(tournament?.format)) return match => t('bracket.roundN', { n: match.round_number })
  const rounds = { totals: knockoutTotals(matches, tournament?.format), hasLosers: matches.some(match => match.stage === 'losers') }
  return match => matchStageRoundLabel(match, rounds, t)
}

/** One side as tokens ("P1", or "P1 / P2" for partners of a points-format match). */
function tokenizer(entriesMap) {
  const names = {}
  const byEntry = new Map()
  const token = id => {
    if (!byEntry.has(id)) {
      const name = entryDisplayNames(entriesMap[id]).join(' / ')
      if (!name) return null
      const key = `P${byEntry.size + 1}`
      byEntry.set(id, key)
      names[key] = name
    }
    return byEntry.get(id)
  }
  const side = (match, which) => sideEntryIds(match, which).map(token).filter(Boolean).join(' / ') || null
  return { names, token, side }
}

// The score as seen from one side ('a' or 'b'): a post reads "P3 — P1 6:4 6:2", winner first.
function scoreText(match, sets, from = 'a') {
  const [x, y] = from === 'a' ? ['a', 'b'] : ['b', 'a']
  const own = sets.filter(set => set.match_id === match.id).sort((a, b) => a.set_index - b.set_index)
  if (own.length) {
    return own.map(set => formatSetScore({
      ...set,
      side_a_games: set[`side_${x}_games`], side_b_games: set[`side_${y}_games`],
      side_a_tiebreak: set[`side_${x}_tiebreak`], side_b_tiebreak: set[`side_${y}_tiebreak`],
    })).join(' ')
  }
  if (match.side_a_score == null || match.side_b_score == null) return null
  const pens = match.side_a_pens != null && match.side_b_pens != null ? ` (${match[`side_${x}_pens`]}:${match[`side_${y}_pens`]} pen.)` : ''
  return `${match[`side_${x}_score`]}:${match[`side_${y}_score`]}${pens}`
}

// How one-sided a match was: games for sets, else the score difference.
function margin(match, sets) {
  const own = sets.filter(set => set.match_id === match.id && set.score_kind !== 'match_tiebreak')
  if (own.length) return Math.abs(own.reduce((sum, set) => sum + set.side_a_games - set.side_b_games, 0))
  return Math.abs((match.side_a_score ?? 0) - (match.side_b_score ?? 0))
}

// A close one: a deciding set or a tie-break in sets, a margin of 1–2 otherwise.
function close(match, sets, family) {
  if (family === 'sets') {
    const own = sets.filter(set => set.match_id === match.id)
    return own.length >= 3 || own.some(set => set.side_a_tiebreak != null)
  }
  return margin(match, sets) <= (family === 'points' ? 2 : 1)
}

/**
 * Facts for one moment -> { facts, names }. `facts` is what the model gets (tokens only);
 * `names` maps tokens back to display names. `moment` is a key from postMoments().
 */
export function buildPostFacts({ tournament, matches = [], entriesMap = {}, sets = [], standings = [], pointsStandings = [], moment = 'results' }, t) {
  const family = scoringFamily(tournament?.sport || 'tennis', tournament?.format)
  const { names, token, side } = tokenizer(entriesMap)
  const label = roundLabeler(tournament, matches, t)
  // Winner first, the score from the winner's side; a draw keeps the listed order.
  const resultOf = match => {
    if (!match.winner_entry_id) return { round: label(match), draw: [side(match, 'a'), side(match, 'b')], score: scoreText(match, sets) }
    const [w, l] = match.winner_entry_id === match.side_a_entry_id ? ['a', 'b'] : ['b', 'a']
    return { round: label(match), winner: side(match, w), loser: side(match, l), score: scoreText(match, sets, w) }
  }

  const final = finalMatch(tournament, matches)
  let picked
  if (moment === 'results') {
    // The knockout's last two rounds, or the last round of a league / points format.
    const finalRound = final ? final.round_number ?? 0 : null
    picked = final
      ? matches.filter(match => played(match) && KNOCKOUT_FINAL_STAGES.includes(match.stage) && (match.round_number ?? 0) >= finalRound - 1)
      : matches.filter(played).filter((match, _, list) => match.round_number === Math.max(...list.map(m => m.round_number ?? 0)))
  } else {
    const key = String(moment).replace(/^round:/, '')
    picked = matches.filter(match => played(match) && roundKey(match) === key)
  }
  picked = [...picked].sort((a, b) => (b.round_number ?? 0) - (a.round_number ?? 0) || (a.match_number ?? 0) - (b.match_number ?? 0)).slice(0, RESULTS_MAX)

  const facts = {
    tournament: {
      name: tournament?.name ?? '',
      sport: tournament?.sport ?? null,
      format: tournament?.format ?? null,
      doubles: tournament?.category === 'doubles',
      venue: tournament?.venue_address || null,
      entries: new Set(matches.flatMap(match => [match.side_a_entry_id, match.side_b_entry_id, match.side_a2_entry_id, match.side_b2_entry_id]).filter(Boolean)).size,
      finished: tournament?.status === 'completed',
    },
    moment: moment === 'results' ? 'results' : 'round',
    round: moment === 'results' ? null : (picked[0] ? label(picked[0]) : null),
    results: picked.map(resultOf),
  }

  if (moment === 'results') {
    if (final?.status === 'finished' && final.winner_entry_id) {
      facts.champion = side(final, final.winner_entry_id === final.side_a_entry_id ? 'a' : 'b')
      facts.runnerUp = side(final, final.winner_entry_id === final.side_a_entry_id ? 'b' : 'a')
    }
    const table = isPointsFormat(tournament?.format) ? pointsStandings : (final ? [] : standings)
    if (table.length) {
      facts.table = table.slice(0, TABLE_MAX).map(row => ({
        rank: row.rank,
        who: token(row.entry_id),
        points: row.total ?? row.points ?? null,
        won: row.won ?? null,
        lost: row.lost ?? null,
      }))
      if (!facts.champion && tournament?.status === 'completed' && facts.table[0]?.rank === 1) facts.champion = facts.table[0].who
    }
  }

  // Highlights among the matches this post covers.
  const pool = moment === 'results' ? matches.filter(played) : picked
  if (pool.length > 1) {
    const biggest = [...pool].sort((a, b) => margin(b, sets) - margin(a, sets))[0]
    const tight = pool.filter(match => close(match, sets, family))
    facts.biggestWin = resultOf(biggest)
    if (tight.length) facts.closest = resultOf(tight[0])
  }

  if (moment !== 'results') {
    facts.next = matches
      .filter(match => match.status !== 'finished' && match.side_a_entry_id && match.side_b_entry_id)
      .sort((a, b) => (a.round_number ?? 0) - (b.round_number ?? 0) || (a.match_number ?? 0) - (b.match_number ?? 0))
      .slice(0, NEXT_MAX)
      .map(match => ({ round: label(match), a: side(match, 'a'), b: side(match, 'b') }))
  }
  return { facts, names }
}

/** Puts the names back and the link in; a token the facts never had stays as written. */
export function restorePost(text, { names = {}, link = '' } = {}) {
  let out = String(text ?? '').replace(TOKEN, (whole, n) => names[`P${n}`] ?? whole)
  if (link) out = out.includes('{link}') ? out.replaceAll('{link}', link) : out
  return out.replaceAll('{link}', '').trim()
}
