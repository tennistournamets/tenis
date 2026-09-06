import { formatSetScore } from './tennisRules.js'
import { computed, ref } from 'vue'

const POINT_LABELS = ['0', '15', '30', '40']

function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function sideValue(record, side) {
  return asNumber(record?.[side], 0)
}

export function createInitialTennisState(setFormat = 'best_of_3') {
  return {
    points: { a: 0, b: 0 },
    games: { a: 0, b: 0 },
    setsWon: { a: 0, b: 0 },
    sets: [],
    currentSet: 1,
    isTiebreak: false,
    tiebreakPoints: { a: 0, b: 0 },
    requiredSets: setFormat === 'best_of_5' ? 3 : 2,
    winner: null,
  }
}

export function normalizeTennisState(state, setFormat = 'best_of_3') {
  const source = state && typeof state === 'object' ? state : {}
  return {
    points: {
      a: sideValue(source.points, 'a'),
      b: sideValue(source.points, 'b'),
    },
    games: {
      a: sideValue(source.games, 'a'),
      b: sideValue(source.games, 'b'),
    },
    setsWon: {
      a: sideValue(source.setsWon, 'a'),
      b: sideValue(source.setsWon, 'b'),
    },
    sets: Array.isArray(source.sets) ? source.sets : [],
    currentSet: asNumber(source.currentSet, 1),
    isTiebreak: Boolean(source.isTiebreak),
    isMatchTiebreak: Boolean(source.isMatchTiebreak),
    tiebreakTo: asNumber(source.tiebreakTo, 7),
    tiebreakMargin: asNumber(source.tiebreakMargin, 2),
    rules: source.rules || null,
    tiebreakPoints: {
      a: sideValue(source.tiebreakPoints, 'a'),
      b: sideValue(source.tiebreakPoints, 'b'),
    },
    requiredSets: asNumber(source.requiredSets, setFormat === 'best_of_5' ? 3 : 2),
    winner: source.winner === 'a' || source.winner === 'b' ? source.winner : null,
  }
}

export function pointLabel(state, side) {
  const normalized = normalizeTennisState(state)
  if (normalized.isTiebreak) {
    return String(sideValue(normalized.tiebreakPoints, side))
  }

  const mine = sideValue(normalized.points, side)
  const other = sideValue(normalized.points, side === 'a' ? 'b' : 'a')
  if (mine >= 3 && other >= 3 && mine > other) {
    return 'AD'
  }
  return POINT_LABELS[Math.min(mine, 3)] || '0'
}

export function scoreLine(state) {
  const normalized = normalizeTennisState(state)
  const completed = normalized.sets.map(formatSetScore)
  if (normalized.winner) return completed.join(' · ')
  const current = normalized.isMatchTiebreak
    ? `[${normalized.tiebreakPoints.a}:${normalized.tiebreakPoints.b}]`
    : `${normalized.games.a}:${normalized.games.b}`
  return [...completed, current].join(' · ')
}

export function isLiveScoreActive(liveScore) {
  return liveScore?.status === 'active'
}

export function useTennisScoring(initialState = null, setFormat = 'best_of_3') {
  const state = ref(normalizeTennisState(initialState, setFormat))

  const labels = computed(() => ({
    a: pointLabel(state.value, 'a'),
    b: pointLabel(state.value, 'b'),
  }))

  const summary = computed(() => scoreLine(state.value))

  function replaceState(nextState) {
    state.value = normalizeTennisState(nextState, setFormat)
  }

  return {
    state,
    labels,
    summary,
    replaceState,
  }
}
