// Sport-family scoring engine registry. Keeps the tennis engine authoritative
// for the 'sets' family and provides a lightweight 'goals' engine for football.
// UI reads a single canonical aggregate (side_a_score/side_b_score); these helpers
// format and seed live-scoring state per family.

import { createInitialTennisState, scoreLine } from './useTennisScoring'
import { scoringFamily } from './sportConfig'

export const scoringEngines = {
  sets: {
    family: 'sets',
    createInitialState: (setFormat = 'best_of_3') => createInitialTennisState(setFormat),
    // state -> "6:3 · 6:4"
    formatScore: (state) => scoreLine(state),
    // Aggregate badge from sets won.
    formatAggregate: (a, b) => `${a ?? 0}:${b ?? 0}`,
  },
  goals: {
    family: 'goals',
    createInitialState: () => ({ a: 0, b: 0, winner: null }),
    formatScore: (state) => `${state?.a ?? 0} : ${state?.b ?? 0}`,
    formatAggregate: (a, b) => `${a ?? 0} : ${b ?? 0}`,
  },
}

export function getEngine(sport) {
  return scoringEngines[scoringFamily(sport)] ?? scoringEngines.sets
}
