// Central registry describing each sport's capabilities.
// Drives the create wizard and per-sport/format rendering in the admin & public views.

export const SPORTS = ['tennis', 'padel', 'football']

export const TOURNAMENT_FORMATS = [
  'single_elimination',
  'round_robin',
  'groups_playoff',
  'double_elimination',
]

const ALL_FORMATS = [...TOURNAMENT_FORMATS]

export const sportConfig = {
  tennis: {
    scoringFamily: 'sets',       // games/sets/tiebreaks
    forcedCategory: null,        // user picks singles/doubles
    supportsCategory: true,
    supportsSetFormat: true,
    supportsLiveScoring: true,
    supportsDoublesPairing: true,
    allowedFormats: ALL_FORMATS,
  },
  padel: {
    scoringFamily: 'sets',       // identical to tennis
    forcedCategory: 'doubles',   // padel is always doubles
    supportsCategory: false,
    supportsSetFormat: true,
    supportsLiveScoring: true,
    supportsDoublesPairing: true,
    allowedFormats: ALL_FORMATS,
  },
  football: {
    scoringFamily: 'goals',      // single integer score per side
    forcedCategory: 'singles',   // a team is one entity per side
    supportsCategory: false,
    supportsSetFormat: false,
    supportsLiveScoring: false,  // v1: final result entry only
    supportsDoublesPairing: false,
    allowedFormats: ALL_FORMATS,
  },
}

export function getSportConfig(sport) {
  return sportConfig[sport] ?? sportConfig.tennis
}

export function scoringFamily(sport) {
  return getSportConfig(sport).scoringFamily
}

// Effective category for a sport, honouring the forced value when present.
export function resolveCategory(sport, chosenCategory) {
  const cfg = getSportConfig(sport)
  return cfg.forcedCategory ?? chosenCategory
}
