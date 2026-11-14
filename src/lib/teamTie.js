// Team ties (category 'team'): a tie between two teams is made of lines (singles, doubles,
// mixed). The server normalizes the template (team_tie_config) and computes the tie score;
// this module mirrors the template rules for forms and reads lines and lineups from the
// sync snapshot. Spec: docs/TEAM_FORMATS.md.

export const TEAM_FLAG = 'feature.teams'

// MS men's singles, WS women's singles, XS any singles,
// MD men's doubles, WD women's doubles, XD mixed doubles, AD any doubles.
export const LINE_TYPES = ['MS', 'WS', 'XS', 'MD', 'WD', 'XD', 'AD']
export const MAX_LINES = 9
export const TEAM_FORMATS = ['round_robin', 'groups_playoff', 'single_elimination']

export const TIE_PRESETS = [
  { id: 'singles_doubles', lines: ['XS', 'XS', 'AD'] },
  { id: 'mixed_cup', lines: ['MS', 'WS', 'XD'] },
  { id: 'three_pairs', lines: ['AD', 'AD', 'AD'] },
  { id: 'club_league', lines: ['MD', 'MD', 'MD', 'WD', 'XD'] },
]

export const DEFAULT_TIE = { lines: ['XS', 'XS', 'AD'], win_rule: 'rubbers', decider: 'AD', roster_min: 2, roster_max: 16 }

export const isTeamCategory = category => category === 'team'
export const isTeamTournament = tournament => tournament?.category === 'team'
export const isRubber = match => Boolean(match?.parent_match_id)

export const lineSize = type => (['MS', 'WS', 'XS'].includes(type) ? 1 : 2)
export const isSinglesLine = type => lineSize(type) === 1

/** Template from tournament.format_config.tie (server-normalized) in the flat form shape. */
export function tieFromConfig(raw) {
  const lines = Array.isArray(raw?.lines) ? raw.lines.map(l => (typeof l === 'string' ? l : l?.type)).filter(t => LINE_TYPES.includes(t)) : []
  return {
    lines: lines.length ? lines : [...DEFAULT_TIE.lines],
    win_rule: raw?.win_rule === 'games' ? 'games' : 'rubbers',
    decider: LINE_TYPES.includes(raw?.decider?.type) ? raw.decider.type : DEFAULT_TIE.decider,
    roster_min: Number.isInteger(raw?.roster_min) ? raw.roster_min : DEFAULT_TIE.roster_min,
    roster_max: Number.isInteger(raw?.roster_max) ? raw.roster_max : DEFAULT_TIE.roster_max,
  }
}

/** The flat form shape as the server's format_config.tie. */
export function tieToConfig(tie) {
  return {
    lines: tie.lines.map(type => ({ type })),
    win_rule: tie.win_rule,
    decider: { type: tie.decider },
    roster_min: Number(tie.roster_min),
    roster_max: Number(tie.roster_max),
  }
}

/** i18n key of the first problem in a template, or null (mirrors team_tie_config). */
export function tieError(tie) {
  if (!Array.isArray(tie?.lines) || tie.lines.length < 1 || tie.lines.length > MAX_LINES) return 'team.template.errorLines'
  if (tie.lines.some(type => !LINE_TYPES.includes(type))) return 'team.template.errorLines'
  const min = Number(tie.roster_min)
  const max = Number(tie.roster_max)
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max > 30 || min > max) return 'team.template.errorRoster'
  return null
}

export const presetOf = lines => TIE_PRESETS.find(p => p.lines.join() === (lines || []).join())?.id ?? 'custom'

/** Players one team needs at least, when everyone plays one singles and one doubles line. */
export function playersNeeded(lines) {
  const singles = lines.filter(isSinglesLine).length
  const doublesSlots = lines.filter(t => !isSinglesLine(t)).length * 2
  return Math.max(singles, doublesSlots, 1)
}

/** Type of line `lineNo` of a tie: template lines first, then the decider. */
export function lineType(tie, lineNo) {
  return lineNo <= tie.lines.length ? tie.lines[lineNo - 1] : tie.decider
}

/** Whether a player of this gender may play this line type (null gender: only open lines). */
export function genderFits(type, gender) {
  if (type === 'XS' || type === 'AD') return true
  if (!gender) return false
  if (type === 'MS' || type === 'MD') return gender === 'male'
  if (type === 'WS' || type === 'WD') return gender === 'female'
  return true // XD: the pair needs one of each; checked on the pair
}

/** Server rule for a full side of a line: genders right, mixed = one of each. */
export function lineGendersOk(type, genders) {
  if (!genders.length) return true
  if (type === 'XS' || type === 'AD') return true
  if (genders.some(g => !g)) return false
  if (type === 'MS' || type === 'MD') return genders.every(g => g === 'male')
  if (type === 'WS' || type === 'WD') return genders.every(g => g === 'female')
  if (type === 'XD') return genders.length === 1 || new Set(genders).size === 2
  return true
}

/** Splits snapshot matches into ties/ordinary matches and lines grouped by their tie. */
export function splitRubbers(matches) {
  const main = []
  const linesByTie = {}
  for (const m of matches || []) {
    if (m.parent_match_id) (linesByTie[m.parent_match_id] ||= []).push(m)
    else main.push(m)
  }
  for (const list of Object.values(linesByTie)) list.sort((a, b) => a.line_no - b.line_no)
  return { main, linesByTie }
}

/** Lineup rows of the snapshot as { [lineId]: { A: [memberId…], B: [memberId…] } }. */
export function lineupsByLine(rows) {
  const out = {}
  for (const r of [...(rows || [])].sort((a, b) => a.slot - b.slot)) {
    const line = (out[r.line_id] ||= { A: [], B: [] })
    line[r.side].push(r.member_id)
  }
  return out
}

/** Submitted sides of each tie: { [tieId]: { A: iso|null, B: iso|null } }. */
export function submissionsByTie(rows) {
  const out = {}
  for (const r of rows || []) (out[r.tie_id] ||= { A: null, B: null })[r.side] = r.submitted_at
  return out
}

/** Roster members by id across all entries. */
export function membersById(entries) {
  const out = {}
  for (const e of entries || []) for (const m of e.entry_members || []) out[m.id] = { ...m, entry_id: e.id }
  return out
}

/** "Anna K. / Boris P." for one side of a line, or '' when its lineup is not visible yet. */
export function lineSideNames(lineups, members, lineId, side) {
  return (lineups[lineId]?.[side] || []).map(id => members[id]?.member_name).filter(Boolean).join(' / ')
}

/** A line copy carrying player names, so score and live modals show who plays. */
export function labelledLine(line, lineups, members, teamName) {
  const label = side => {
    const names = lineSideNames(lineups, members, line.id, side.toUpperCase())
    const team = teamName(line[`side_${side}_entry_id`])
    return names ? `${names} (${team})` : team
  }
  return { ...line, side_a_label: label('a'), side_b_label: label('b') }
}

/** Editable lineup draft for one side: { [lineNo]: [memberId|'' …] } sized to each line. */
export function lineupDraft(tie, lines, lineups, side) {
  const draft = {}
  for (const line of lines) {
    const size = lineSize(lineType(tie, line.line_no))
    const current = lineups[line.id]?.[side] || []
    draft[line.line_no] = Array.from({ length: size }, (_, i) => current[i] || '')
  }
  return draft
}

/** First problem of a lineup draft for one side, as an i18n key, or null. */
export function lineupDraftError(tie, lines, draft, members, { complete = false } = {}) {
  const singles = {}
  const doubles = {}
  for (const line of lines) {
    const type = lineType(tie, line.line_no)
    const ids = (draft[line.line_no] || []).filter(Boolean)
    if (complete && ids.length !== lineSize(type)) return 'team.errors.lineupIncomplete'
    if (new Set(ids).size !== ids.length) return 'team.errors.invalidLineup'
    if (!lineGendersOk(type, ids.map(id => members[id]?.gender || null))) return 'team.errors.genderMismatch'
    if (line.line_no > tie.lines.length) continue
    for (const id of ids) {
      const bucket = isSinglesLine(type) ? singles : doubles
      bucket[id] = (bucket[id] || 0) + 1
    }
  }
  if (Object.values(singles).some(n => n > 1) || Object.values(doubles).some(n => n > 1)) return 'team.errors.playerLineLimit'
  return null
}

/** A line has started: result, score or live row. */
export const lineStarted = (line, liveByMatch = {}) => Boolean(
  line.status === 'finished' || line.winner_entry_id || line.side_a_score != null || line.side_b_score != null || liveByMatch[line.id],
)
