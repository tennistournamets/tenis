// One place that turns server, PostgREST and network errors into translated text.
//
// Adding a server error:
//   * preferred: raise an i18n key from SQL (`raise exception 'serverErrors.myCode'`, or a key
//     under one of the NAMESPACES below) and add its text to src/i18n/serverErrors.js;
//   * for an existing English message: add ONE row to SERVER_ERRORS below
//     (`['Exact server text', 'serverErrors.myCode']`, or a RegExp for texts with values).
// Anything unknown shows the caller's fallback text instead of raw English.

// Messages that already are i18n codes: `<prefix>.<name>` -> `<namespace><name>`.
const NAMESPACES = {
  'access.': 'access.errors.',
  'schedule.': 'schedule.errors.',
  'registration.': 'registrationRules.errors.',
  'drafts.': 'drafts.',
  'tennisRules.': 'tennisRules.',
  'scoringFlow.': 'scoringFlow.',
  'seeding.': 'seeding.',
  'serverErrors.': 'serverErrors.',
}

export const SERVER_ERRORS = [
  // Registration and entries
  ['Registration already exists for this contact', 'admin.addEntryDuplicateContact'],
  ['Single entry requires one participant', 'serverErrors.singleEntryOnePlayer'],
  ['Double entry requires two participants', 'serverErrors.doubleEntryTwoPlayers'],
  ['Double entry requires at least one participant', 'serverErrors.doubleEntryOnePlayer'],
  ['Tournament is private', 'serverErrors.tournamentPrivate'],
  ['Registration is closed', 'serverErrors.registrationClosed'],
  ['Contact info is required', 'serverErrors.contactRequired'],
  ['Invalid phone number or email', 'serverErrors.invalidContact'],
  ['Contact required', 'serverErrors.organizerContactRequired'],
  // Access and roles
  [/^User with email .* not found$/, 'access.errors.userNotFound'],
  ['Not allowed', 'serverErrors.notAllowed'],
  ['Not authorized', 'serverErrors.notAllowed'],
  ['Platform admin required', 'serverErrors.notAllowed'],
  ['Authentication required', 'serverErrors.sessionExpired'],
  // Draw, groups and pairs
  ['At least 2 approved entries required', 'serverErrors.minEntries'],
  ['At least 2 entries required', 'serverErrors.minEntries'],
  ['At least 2 seeds required', 'serverErrors.minEntries'],
  ['At least 2 groups required', 'serverErrors.minGroups'],
  ['Need at least 2 entries per group', 'serverErrors.groupSize'],
  ['Not enough qualifiers for a playoff', 'serverErrors.notEnoughQualifiers'],
  ['All group matches must be finished first', 'serverErrors.groupsUnfinished'],
  [/^Double elimination v1 requires a power-of-two/, 'serverErrors.doubleElimSize'],
  ['Cannot edit pairs while tournament is in progress or completed', 'serverErrors.pairsLocked'],
  [/^Odd number of unpaired players/, 'serverErrors.oddPlayers'],
  ['At least one complete pair required', 'serverErrors.completePairRequired'],
  [/^(Invalid pairs|Invalid or repeated pair member|Pairs must contain distinct|Each pair must contain two|Pairs require approved unpaired|Entry .* is not a valid unpaired entry)/, 'serverErrors.invalidPairs'],
  ['Tournament is not configured for random pairing', 'serverErrors.notRandomPairing'],
  [/^(Manual order must contain unique approved entries|Participant does not belong to the approved entries|No groups found|Match( .*)? not found|Tournament not found)/, 'serverErrors.staleData'],
  ['A match cannot contain the same participant twice', 'serverErrors.sameParticipantTwice'],
  // Scores and live
  ['Scoring rules are locked', 'tennisRules.locked'],
  [/^Invalid set or tiebreak/, 'tennisRules.invalidScore'],
  [/^Only the final entered set/, 'tennisRules.partialLast'],
  [/^No further sets/, 'tennisRules.matchOver'],
  [/^Set indices/, 'tennisRules.setOrder'],
  [/^(Match already finished|Cannot modify finished match|Cannot move players in finished matches)$/, 'serverErrors.matchFinished'],
  [/^(Cannot modify a match with scores or active live scoring|Cannot move players when match scores exist)$/, 'serverErrors.matchHasScores'],
  ['Both sides must be assigned before scoring', 'serverErrors.sidesNotAssigned'],
  [/^(Scores can be entered|Live scoring can start) only after the tournament starts$/, 'serverErrors.beforeStart'],
  ['Live scoring is available only while the tournament is in progress', 'serverErrors.liveNotInProgress'],
  ['Live match not found', 'serverErrors.liveNotFound'],
  ['Nothing to undo', 'serverErrors.nothingToUndo'],
  ['Cannot undo a finished live match', 'serverErrors.cannotUndoFinished'],
  ['Penalty shootout result required to break a knockout tie', 'serverErrors.penaltiesRequired'],
  [/^Valid (goal|penalty|goal and penalty) counts required$/, 'serverErrors.invalidGoals'],
  [/^(Invalid result|Stored score does not match the tournament rules)$/, 'serverErrors.invalidResult'],
  [/^Sport is disabled/, 'serverErrors.sportDisabled'],
]

// Transport and database failures, matched by PostgREST/Postgres code or by text.
const TECHNICAL = [
  { key: 'serverErrors.timeout', codes: ['57014'], text: /statement timeout|canceling statement|timed? ?out|AbortError|TimeoutError/i },
  { key: 'serverErrors.network', codes: [], text: /Failed to fetch|NetworkError|Network request failed|Load failed|fetch failed|ERR_NETWORK|ERR_INTERNET_DISCONNECTED/i },
  { key: 'serverErrors.conflict', codes: ['23505', '40001', '40P01'], text: /duplicate key value|could not serialize access|deadlock detected/i },
  { key: 'serverErrors.outdated', codes: ['PGRST202', 'PGRST204', 'PGRST205', '42883'], text: /schema cache|Could not find the (function|table)|function .* does not exist/i },
  { key: 'serverErrors.sessionExpired', codes: ['PGRST301', 'PGRST302', 'PGRST303'], text: /JWT expired|invalid JWT|refresh token/i },
  { key: 'serverErrors.notAllowed', codes: ['42501'], text: /permission denied|row-level security/i },
]

const KEY_LIKE = /^[a-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)+$/

function parts(error) {
  if (typeof error === 'string') return { message: error, code: '', name: '' }
  if (!error || typeof error !== 'object') return { message: '', code: '', name: '' }
  return { message: String(error.message ?? ''), code: String(error.code ?? ''), name: String(error.name ?? '') }
}

/** i18n key for an error, or null when nothing matches. Accepts an Error-like object or a message. */
export function errorKey(error) {
  const { message, code, name } = parts(error)
  const text = message.trim()
  for (const [prefix, namespace] of Object.entries(NAMESPACES)) {
    if (text.startsWith(prefix) && KEY_LIKE.test(text)) return namespace + text.slice(prefix.length)
  }
  for (const [match, key] of SERVER_ERRORS) {
    if (typeof match === 'string' ? text === match : match.test(text)) return key
  }
  for (const rule of TECHNICAL) {
    if (rule.codes.includes(code) || rule.text.test(text) || rule.text.test(name)) return rule.key
  }
  return null
}

/**
 * Translated text for an error. `fallbackKey` is used for empty and unknown errors; an unknown
 * message that is itself an existing i18n key (for example a new SQL error raised as a key) is
 * translated directly.
 */
export function errorMessage(error, t, fallbackKey = 'errors.generic') {
  const key = errorKey(error)
  if (key) return t(key)
  const { message } = parts(error)
  const text = message.trim()
  if (KEY_LIKE.test(text)) {
    const translated = t(text)
    if (translated && translated !== text) return translated
  }
  if (text && typeof console !== 'undefined') console.warn('[bracketa] untranslated error:', text)
  return t(fallbackKey)
}

/** Network or timeout failures: the action may be retried as is. */
export function isTransientError(error) {
  const key = errorKey(error)
  return key === 'serverErrors.network' || key === 'serverErrors.timeout'
}
