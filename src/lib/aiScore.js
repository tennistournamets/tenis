// Score from speech or text: the open matches the model may pick from, and what a recognized
// result becomes — the same RPC payload the score editors send, checked by the same rules.
import { matchSideLabel, matchSidesReady } from './entryDisplay.js'
import { groupNamesById } from './groupsFlow.js'
import { correctionMatchTitle } from './roundLabels.js'
import { isPointsFormat, pointsTarget, scoringFamily } from './sportConfig.js'
import { buildSetPayload, formatSetScore, matchScoreCheck, ruleForSet } from './tennisRules.js'

// Enough for a full Americano round list or a 64-draw; the model reads every line.
export const SCORE_MATCHES_MAX = 150

/**
 * Matches that can take a result now: both sides known, not finished, not scored live at the
 * moment. Each gets a short reference (m1, m2, …) for the model, a heading ("Round 2 · Court 1",
 * "Semifinal · №1") and the side names.
 */
export function scoreMatchList({ tournament, matches = [], entriesMap = {}, liveScoresByMatch = {}, scheduleByMatch = {}, courtsById = {}, groups = [] }, t) {
  const points = isPointsFormat(tournament?.format)
  const groupNames = groupNamesById(groups)
  return matches
    .filter(match => match.status !== 'finished' && matchSidesReady(match) && liveScoresByMatch[match.id]?.status !== 'active')
    .sort((x, y) => (x.round_number ?? 0) - (y.round_number ?? 0) || (x.match_number ?? 0) - (y.match_number ?? 0))
    .slice(0, SCORE_MATCHES_MAX)
    .map((match, index) => {
      const courtId = scheduleByMatch[match.id]?.court_id
      const court = points ? t('pointsFormat.court', { n: match.match_number }) : courtsById[courtId]?.name || null
      const round = points
        ? t('bracket.roundN', { n: match.round_number })
        : correctionMatchTitle(match, matches, t, { format: tournament?.format, groupNames })
      return {
        ref: `m${index + 1}`,
        match,
        heading: court ? `${round} · ${court}` : round,
        a: matchSideLabel(match, 'a', entriesMap, '?'),
        b: matchSideLabel(match, 'b', entriesMap, '?'),
      }
    })
}

/** The list as the model sees it: no ids, just what a person would say. */
export const scoreContextMatches = list => list.map(item => ({ ref: item.ref, heading: item.heading, a: item.a, b: item.b }))

const sideOf = (a, b) => (a > b ? 'a' : b > a ? 'b' : null)

/**
 * A recognized result for one match -> { rpc, payload, text, winner, problem }. `problem` is an
 * i18n key under ai.score.problems (or a tennisRules key) when the result cannot be saved as
 * read; `winner` is the side the score gives, 'a' | 'b' | null.
 */
export function scoreDraft(result, match, tournament) {
  const family = scoringFamily(tournament?.sport || 'tennis', tournament?.format)
  const base = { rpc: null, payload: null, text: '', winner: null, problem: null }
  if (family === 'sets') {
    if (!result.sets?.length) return { ...base, problem: 'ai.score.problems.noScore' }
    const setFormat = tournament.set_format || 'best_of_3'
    const config = tournament.scoring_config || {}
    const rows = result.sets.map((set, index) => {
      const rule = ruleForSet(config, index + 1, setFormat)
      // A deciding match tie-break is said as its points ("10:8"), like a set.
      if (rule.kind === 'match_tiebreak') {
        return { set_index: index + 1, side_a_games: '', side_b_games: '', side_a_tiebreak: set.a, side_b_tiebreak: set.b }
      }
      return { set_index: index + 1, side_a_games: set.a, side_b_games: set.b, side_a_tiebreak: set.tb?.a ?? '', side_b_tiebreak: set.tb?.b ?? '' }
    })
    let sets
    try {
      sets = buildSetPayload(rows, config, setFormat)
    } catch (error) {
      return { ...base, text: result.sets.map(set => `${set.a}:${set.b}`).join(' '), problem: error.message }
    }
    const check = matchScoreCheck(rows, config, setFormat)
    const draft = {
      ...base,
      rpc: 'update_match_sets',
      payload: { p_match_id: match.id, p_sets: sets, p_expected_revision: match.score_revision ?? null },
      text: sets.map(formatSetScore).join(' '),
      winner: check.winner ? sideOf(check.a, check.b) : null,
    }
    if (check.problem) return { ...draft, rpc: null, payload: null, problem: `ai.score.problems.${check.problem}` }
    return mismatch(draft, result)
  }

  const score = result.score
  if (!score) return { ...base, problem: 'ai.score.problems.noScore' }
  if (family === 'points') {
    const target = pointsTarget(tournament)
    const draft = {
      ...base,
      rpc: 'update_match_points',
      payload: { p_match_id: match.id, p_a: score.a, p_b: score.b, p_expected_revision: match.score_revision ?? null },
      text: `${score.a}:${score.b}`,
      winner: sideOf(score.a, score.b),
    }
    if (score.a + score.b !== target) return { ...draft, rpc: null, payload: null, problem: 'ai.score.problems.pointsSum', target }
    return mismatch(draft, result)
  }

  // Goals: a draw stands in a league or a group; a knockout draw needs a penalty winner.
  const drawAllowed = tournament?.format === 'round_robin' || match.stage === 'group'
  // Penalties only break a knockout draw; a league draw stays a draw.
  const pens = score.a === score.b && !drawAllowed ? result.pens : null
  const draft = {
    ...base,
    rpc: 'update_football_result',
    payload: {
      p_match_id: match.id,
      p_expected_revision: match.score_revision ?? null,
      p_a_goals: score.a,
      p_b_goals: score.b,
      p_a_pens: pens ? pens.a : null,
      p_b_pens: pens ? pens.b : null,
    },
    text: pens ? `${score.a}:${score.b} (${pens.a}:${pens.b})` : `${score.a}:${score.b}`,
    winner: sideOf(score.a, score.b) ?? (pens ? sideOf(pens.a, pens.b) : null),
  }
  if (score.a === score.b && !drawAllowed && (!pens || pens.a === pens.b)) return { ...draft, rpc: null, payload: null, problem: 'ai.score.problems.needPens' }
  return mismatch(draft, result)
}

// The text named a winner, the numbers give the other side: read the wrong way round.
function mismatch(draft, result) {
  if (result.winner && draft.winner && result.winner !== draft.winner) {
    return { ...draft, rpc: null, payload: null, problem: 'ai.score.problems.winnerMismatch' }
  }
  return draft
}
