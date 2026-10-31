// A match that ended without being played out (matches.result_type):
// W.O. — a side did not come, RET — a side retired during the match.
const TAGS = { walkover: 'W.O.', retired: 'RET' }

/** 'W.O.', 'RET' or '' for an ordinary result. */
export function resultTag(match) {
  return TAGS[match?.result_type] || ''
}

export function isWalkover(match) {
  return match?.result_type === 'walkover'
}
