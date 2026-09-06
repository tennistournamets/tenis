import { onScopeDispose, ref, watch } from 'vue'

import { normalizeTennisState } from './useTennisScoring.js'
import { ruleForSet } from './tennisRules.js'

// Tennis changeovers: ends are swapped after every odd game of a set
// (1st, 3rd, 5th ...) and, inside a tiebreak, after every 6 points.
// Derived from the score instead of stored, so undo / reload / realtime
// always land on the same orientation.
export function changeoverSwapped(state) {
  if (!state) return false
  const norm = normalizeTennisState(state)

  const config = norm.rules ? { tennis: norm.rules } : { tiebreak_to: norm.tiebreakTo }
  const format = norm.requiredSets === 3 ? 'best_of_5' : 'best_of_3'
  const tbChanges = (points, short) => short ? (points >= 4 ? 1 : 0)
    : norm.rules?.changeover === 'one_then_four' ? (points > 0 ? 1 + Math.floor((points - 1) / 4) : 0)
      : Math.floor(points / 6)
  let changeovers = 0
  for (const set of norm.sets) {
    const rule = ruleForSet(config, set.set_index, format)
    const total = Number(set.side_a_tiebreak || 0) + Number(set.side_b_tiebreak || 0)
    if (set.score_kind === 'match_tiebreak') {
      changeovers += tbChanges(Math.max(0, total - 1), false) + 1
    } else {
      const games = Number(set.side_a_games || 0) + Number(set.side_b_games || 0)
      changeovers += Math.ceil(games / 2)
      // Do not count a change on the final tiebreak point twice: that change
      // belongs to the end of the set, already counted as the odd last game.
      if (total) changeovers += tbChanges(total - 1, rule.margin === 1)
    }
  }
  if (!norm.winner) {
    if (!norm.isMatchTiebreak) changeovers += Math.ceil((norm.games.a + norm.games.b) / 2)
    if (norm.isTiebreak) changeovers += tbChanges(norm.tiebreakPoints.a + norm.tiebreakPoints.b, norm.tiebreakMargin === 1)
  }

  return changeovers % 2 === 1
}

// Game-win celebration in LiveRallyAnimation runs 3s; ends flip just after.
export const CHANGEOVER_DELAY_MS = 3200

function totalGamesPlayed(state) {
  if (!state) return 0
  const norm = normalizeTennisState(state)
  let games = norm.winner || norm.isMatchTiebreak ? 0 : norm.games.a + norm.games.b
  for (const set of norm.sets) {
    games += set.score_kind === 'match_tiebreak' ? 1 : Number(set?.side_a_games || 0) + Number(set?.side_b_games || 0)
  }
  return games
}

// Reactive changeoverSwapped that lets the game-win celebration finish before
// flipping ends: when a game completes forward, the flip is delayed by
// CHANGEOVER_DELAY_MS. Undo / reload / tiebreak mini-changeovers apply
// instantly. Call from component setup (uses the current effect scope).
export function useDeferredChangeover(stateRef) {
  const swapped = ref(changeoverSwapped(stateRef.value))
  let timer = null

  watch(stateRef, (next, prev) => {
    const target = changeoverSwapped(next)

    if (target === swapped.value) {
      // Orientation already correct — drop any pending flip (e.g. undo, or a
      // second game completed before the first flip fired).
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      return
    }

    // A flip is already scheduled towards this target — keep its deadline.
    // Realtime echoes of the same state (new object, same score) and points
    // of the next game re-trigger this watcher and must not reset or rush it.
    if (timer) return

    const forward = Boolean(prev && next) && totalGamesPlayed(next) > totalGamesPlayed(prev)
    if (forward) {
      timer = setTimeout(() => {
        swapped.value = target
        timer = null
      }, CHANGEOVER_DELAY_MS)
    } else {
      swapped.value = target
    }
  })

  onScopeDispose(() => {
    if (timer) clearTimeout(timer)
  })

  return swapped
}

// Returns the logical sides in display order: [left slot, right slot].
// Pass autoSwapped (e.g. from useDeferredChangeover) to defer the flip;
// defaults to the instantaneous value.
export function displaySides(liveScore, state, autoSwapped = changeoverSwapped(state)) {
  const base = Boolean(liveScore?.sides_swapped)
  const auto = liveScore?.sides_auto !== false
  const swapped = base !== (auto ? autoSwapped : false)
  return swapped ? ['b', 'a'] : ['a', 'b']
}
