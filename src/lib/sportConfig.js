// Central registry describing each sport's capabilities.
// Drives the create wizard and per-sport/format rendering in the admin & public views.

export const SPORTS = ['tennis', 'padel', 'football']

export const TOURNAMENT_FORMATS = [
  'single_elimination',
  'round_robin',
  'groups_playoff',
  'double_elimination',
  'americano',
  'mexicano',
  'team_americano',
  'king_of_court',
]

// Social padel formats: a match is played to a total of N points
// (scoring_config.points_per_match) and the table sums the points.
export const POINTS_FORMATS = ['americano', 'mexicano', 'team_americano', 'king_of_court']
// One player per entry; partners change from match to match.
export const INDIVIDUAL_FORMATS = ['americano', 'mexicano', 'king_of_court']
// The next round is built from the results of the previous one.
export const DYNAMIC_FORMATS = ['mexicano', 'king_of_court']

const CLASSIC_FORMATS = TOURNAMENT_FORMATS.filter(f => !POINTS_FORMATS.includes(f))

export const sportConfig = {
  tennis: {
    scoringFamily: 'sets',       // games/sets/tiebreaks
    forcedCategory: null,        // user picks singles/doubles
    supportsCategory: true,
    supportsSetFormat: true,
    supportsLiveScoring: true,
    supportsDoublesPairing: true,
    allowedFormats: CLASSIC_FORMATS,
  },
  padel: {
    scoringFamily: 'sets',       // identical to tennis
    forcedCategory: 'doubles',   // padel is always doubles
    supportsCategory: false,
    supportsSetFormat: true,
    supportsLiveScoring: true,
    supportsDoublesPairing: true,
    allowedFormats: TOURNAMENT_FORMATS,
  },
  football: {
    scoringFamily: 'goals',      // single integer score per side
    forcedCategory: 'singles',   // a team is one entity per side
    supportsCategory: false,
    supportsSetFormat: false,
    supportsLiveScoring: false,  // v1: final result entry only
    supportsDoublesPairing: false,
    allowedFormats: CLASSIC_FORMATS,
  },
}

// Feature-flag key gating a sport in the create wizard (see `feature_flags` table).
export function sportFlagKey(sport) {
  return `sport.${sport}`
}

export function getSportConfig(sport) {
  return sportConfig[sport] ?? sportConfig.tennis
}

export const isPointsFormat = format => POINTS_FORMATS.includes(format)
export const isIndividualFormat = format => INDIVIDUAL_FORMATS.includes(format)
export const isDynamicFormat = format => DYNAMIC_FORMATS.includes(format)

/** Scoring family of a sport, or 'points' for a points format (it overrides the sport). */
export function scoringFamily(sport, format = null) {
  return isPointsFormat(format) ? 'points' : getSportConfig(sport).scoringFamily
}

/** Total points of one match; King of the Court needs an odd total so every match has a winner. */
export function pointsTarget(tournament) {
  const n = Number(tournament?.scoring_config?.points_per_match)
  return Number.isInteger(n) && n > 0 ? n : defaultPointsTarget(tournament?.format)
}
export const defaultPointsTarget = format => (format === 'king_of_court' ? 21 : 24)
export const pointsTargetOptions = format => (format === 'king_of_court' ? [11, 15, 21, 25, 31] : [16, 21, 24, 32])

// Effective category for a sport, honouring the forced value when present.
export function resolveCategory(sport, chosenCategory) {
  const cfg = getSportConfig(sport)
  return cfg.forcedCategory ?? chosenCategory
}

/**
 * i18n key of the category worth showing next to a tournament: the picked one
 * (tennis), or the fixed doubles of padel; null for a team sport, whose entry
 * is always one team.
 */
export function categoryLabelKey(sport, category) {
  const cfg = getSportConfig(sport)
  const shown = cfg.supportsCategory ? category : cfg.forcedCategory === 'doubles' ? 'doubles' : null
  return shown ? `tournament.${shown}` : null
}
