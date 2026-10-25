// Checks for AI answers, shared by the server (api/_ai-tasks.js) and the browser. The model is
// never trusted: every field is cleaned, cut to the database limits or dropped.
import { FEE_CURRENCIES, MEMBER_NAME_MAX, entryNamesError, feeUnitsFor } from './registrationRules.js'
import { SPORTS, getSportConfig, isIndividualFormat, isPointsFormat, pointsTargetOptions, resolveCategory } from './sportConfig.js'

export const IMPORT_MAX_ENTRIES = 256
const NOTE_MAX = 120
const REMARK_MAX = 200
const UNPARSED_MAX = 50

// Same patterns as add_manual_entry() on the server.
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/
const PHONE = /^\+?[0-9\s\-()]{7,20}$/

/**
 * How many people one entry holds: 'single' (singles, teams, Americano-style formats),
 * 'pair' (doubles with agreed partners) or 'pairOptional' (doubles, partner may be drawn).
 */
export function entryShape(tournament) {
  if (isIndividualFormat(tournament?.format) || tournament?.category !== 'doubles') return 'single'
  return tournament?.doubles_pairing_mode === 'pick_random' ? 'pairOptional' : 'pair'
}

const text = value => (typeof value === 'string' || typeof value === 'number' ? String(value) : '')

/** A name as written, without list numbering, bullets or extra spaces. */
export function cleanName(value) {
  return text(value)
    .replace(/[​-‍﻿]/g, '')
    .replace(/^\s*(?:\d{1,3}\s*[.)\]:-]\s*|[-–—•*·▪●]\s*)/u, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MEMBER_NAME_MAX)
}

export function cleanContact(value) {
  const contact = text(value).trim()
  if (EMAIL.test(contact)) return contact.toLowerCase()
  return PHONE.test(contact) ? contact : null
}

const cleanList = (value, max, length) => (Array.isArray(value) ? value : [])
  .map(item => text(item).replace(/\s+/g, ' ').trim().slice(0, length))
  .filter(Boolean)
  .slice(0, max)

/**
 * Import answer -> { entries: [{ members, contact, note, incomplete }], unparsed, remarks, notices }.
 * `notices` are i18n codes of changes made here (split pairs, cut list).
 */
export function checkImport(json, { shape = 'single' } = {}) {
  if (!json || !Array.isArray(json.entries)) throw Object.assign(new Error('ai.badResponse'), { code: 'ai.badResponse' })
  const size = shape === 'single' ? 1 : 2
  const entries = []
  const notices = new Set()
  for (const raw of json.entries) {
    if (!raw || typeof raw !== 'object') continue
    const members = (Array.isArray(raw.members) ? raw.members : [raw.members]).map(cleanName).filter(Boolean)
    if (!members.length) continue
    if (members.length > size) notices.add(shape === 'single' ? 'splitPairs' : 'splitGroups')
    const note = text(raw.note).replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) || null
    for (let start = 0; start < members.length; start += size) {
      const group = members.slice(start, start + size)
      entries.push({
        members: group,
        contact: start === 0 ? cleanContact(raw.contact) : null,
        note: start === 0 ? note : null,
        incomplete: shape === 'pair' && group.length < 2,
      })
    }
  }
  if (entries.length > IMPORT_MAX_ENTRIES) notices.add('cut')
  return {
    entries: entries.slice(0, IMPORT_MAX_ENTRIES),
    unparsed: cleanList(json.unparsed, UNPARSED_MAX, REMARK_MAX),
    remarks: cleanList(json.warnings, 5, REMARK_MAX),
    notices: [...notices],
  }
}

/** Name key for duplicate checks: case, spaces and Lithuanian/Russian diacritics ignored. */
export function nameKey(value) {
  return text(value).normalize('NFD').replace(/\p{M}/gu, '').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim().toLowerCase()
}

/**
 * i18n key of what stops a preview row from being saved, or null. Mirrors add_manual_entry();
 * the server still decides. `team`: one team name per entry (football).
 */
export function importRowProblem(row, { shape = 'single', team = false } = {}) {
  const members = (row.members ?? []).map(name => text(name).trim()).filter(Boolean)
  if (shape === 'pair' && !team && members.length < 2) return 'ai.import.incomplete'
  const key = entryNamesError(shape === 'single' ? 'singles' : 'doubles', members[0], members[1] ?? '')
  if (key) return key
  return row.contact && !cleanContact(row.contact) ? 'registrationForm.invalidContact' : null
}

/** Rows in the shape of the tournament: pairs split into players where every entry is one. */
export function rowsForShape(rows, shape) {
  if (shape !== 'single') return rows
  return rows.flatMap(row => {
    const members = (row.members ?? []).map(name => text(name).trim()).filter(Boolean)
    if (members.length < 2) return [row]
    return members.map((name, index) => ({ ...row, key: `${row.key}-${index}`, members: [name], contact: index === 0 ? row.contact : null, note: index === 0 ? row.note : null }))
  })
}

/** Entry row for add_manual_entries(). Pairs get the usual "A / B" name from the server. */
export function importRow(entry) {
  const [one, two] = entry.members
  return {
    member_one: one,
    member_two: two ?? null,
    display_name: null,
    contact: entry.contact ?? null,
  }
}

// --- Tournament from text -------------------------------------------------------------

const NAME_MAX = 100
const DESCRIPTION_MAX = 1000
const VENUE_MAX = 200
const FEE_MAX = 100000
const enumOf = (value, values) => (values.includes(value) ? value : null)
const shortText = (value, max) => text(value).replace(/[ \t]+/g, ' ').trim().slice(0, max) || null
const wholeNumber = (value, min, max) => {
  const n = Number(value)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}
// The wizard's datetime-local value: a local date and time, no zone.
const localDateTime = value => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(text(value).trim())
  if (!match) return null
  const [, y, m, d, hh, mm] = match.map(Number)
  const date = new Date(y, m - 1, d, hh, mm)
  return date.getFullYear() === y && date.getMonth() === m - 1 && date.getDate() === d && hh < 24 && mm < 60 ? match[0] : null
}
// A date written without a year means the next one: the model sometimes picks a past year.
function upcomingYear(value, today) {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(String(today ?? ''))) return value
  const year = Number(today.slice(0, 4))
  if (Number(value.slice(0, 4)) >= year || value.slice(0, 10) >= today) return value
  const thisYear = `${year}${value.slice(4)}`
  return localDateTime(thisYear.slice(0, 10) >= today ? thisYear : `${year + 1}${value.slice(4)}`)
}

const amountText = value => {
  const n = Number(String(value ?? '').replace(',', '.'))
  if (!Number.isFinite(n) || n <= 0 || n > FEE_MAX) return null
  return Number.isInteger(n) ? String(n) : n.toFixed(2)
}

// Wizard fields from one raw "tournament" object (text values, or text + AI suggestions).
function tournamentFields(raw, rawEntries, { enabledSports, sport: currentSport, today }) {
  const fields = {}
  const notices = new Set()

  // Sport: a switched-off sport is not offered; a points format means padel.
  let sport = enumOf(raw.sport, SPORTS)
  if (sport && !enabledSports.includes(sport)) { notices.add('sportOff'); sport = null }
  let format = enumOf(raw.format, getSportConfig('padel').allowedFormats)
  if (!sport && format && isPointsFormat(format) && enabledSports.includes('padel')) sport = 'padel'
  if (sport) fields.sport = sport
  const cfg = getSportConfig(sport ?? currentSport)
  if (format && !cfg.allowedFormats.includes(format)) { notices.add('formatOff'); format = null }
  if (format) fields.format = format
  const points = isPointsFormat(format)
  const individual = isIndividualFormat(format)

  // Participants decide doubles when the text names pairs but not the category.
  const pairsListed = rawEntries.filter(e => Array.isArray(e?.members) && e.members.filter(m => cleanName(m)).length > 1).length
  let category = cfg.supportsCategory ? enumOf(raw.category, ['singles', 'doubles']) : null
  if (!category && cfg.supportsCategory && !individual && pairsListed > rawEntries.length / 2) {
    category = 'doubles'
    notices.add('doublesFromList')
  }
  if (category) fields.category = category
  const effectiveCategory = resolveCategory(sport ?? currentSport, category ?? 'singles')
  const doubles = effectiveCategory === 'doubles'
  if (doubles && !individual && cfg.supportsDoublesPairing && raw.pairing === 'pick_random') fields.doubles_pairing_random = true

  const name = shortText(raw.name, NAME_MAX)
  if (name) fields.name = name
  const description = shortText(raw.description, DESCRIPTION_MAX)
  if (description) fields.description = description
  const venue = shortText(raw.venue_address, VENUE_MAX)
  if (venue) fields.venue_address = venue
  const phone = text(raw.contact_phone).trim()
  if (/^\+?[\d\s\-()]{7,20}$/.test(phone)) fields.contact_phone = phone
  const email = text(raw.contact_email).trim().toLowerCase()
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.contact_email = email

  if (cfg.supportsSetFormat && !points) {
    const setFormat = enumOf(raw.set_format, ['best_of_3', 'best_of_5'])
    if (setFormat) fields.set_format = setFormat
    if ((sport ?? currentSport) === 'padel') {
      const tiebreak = enumOf(Number(raw.tiebreak_to), [7, 10])
      if (tiebreak) fields.tiebreak_to = tiebreak
    }
  }
  if (points && raw.points_per_match != null) {
    const target = Number(raw.points_per_match)
    if (pointsTargetOptions(format).includes(target)) fields.points_per_match = target
    else notices.add('pointsOption')
  }
  const gender = enumOf(raw.gender, ['men', 'women', 'mixed'])
  if (gender && (gender !== 'mixed' || (doubles && !individual))) fields.gender = gender
  if (format === 'groups_playoff') {
    const advance = wholeNumber(raw.advance_per_group, 1, 4)
    if (advance) fields.advance_per_group = advance
  }

  const capacity = wholeNumber(raw.capacity, 2, 512)
  if (capacity) fields.registration_capacity = String(capacity)
  const deadline = upcomingYear(localDateTime(raw.deadline), today)
  if (deadline) fields.registration_deadline = deadline
  if (raw.fee && typeof raw.fee === 'object') {
    if (raw.fee.mode === 'free') fields.entry_fee_mode = 'free'
    const amount = amountText(raw.fee.amount)
    if (raw.fee.mode === 'paid' && amount) {
      fields.entry_fee_mode = 'paid'
      fields.entry_fee_amount = amount
      fields.entry_fee_currency = enumOf(raw.fee.currency, FEE_CURRENCIES) ?? 'EUR'
      const unit = enumOf(raw.fee.unit, feeUnitsFor({ sport: sport ?? currentSport, category: effectiveCategory }))
      if (unit) fields.entry_fee_unit = unit
    }
  }
  if (raw.waitlist === true && fields.registration_capacity) fields.waitlist_enabled = true
  if (raw.visibility != null) {
    const visibility = enumOf(raw.visibility, ['public', 'link', 'private'])
    if (visibility) fields.visibility = visibility
  }
  // Courts are not a wizard field: the quick screen creates them after the tournament.
  const courts = wholeNumber(raw.courts, 1, 20)
  if (courts) fields.courts = courts

  return { fields, notices, format, effectiveCategory, pairing: fields.doubles_pairing_random ? 'pick_random' : null }
}

const QUESTIONS_MAX = 3
// A question names the "tournament" key it settles ("date" for the day and start time, which
// has no field). A key the text or the answers already give is never asked; after the
// organizer's answers, neither is one the AI has already chosen (it kept re-asking the courts).
function cleanQuestions(value, { given, chosen, answered }) {
  return (Array.isArray(value) ? value : [])
    .filter(item => {
      const field = typeof item?.field === 'string' ? item.field : null
      if (!field) return true
      return !Object.hasOwn(given, field) && !(answered && Object.hasOwn(chosen, field))
    })
    .map(item => ({
      question: shortText(item?.question, 140),
      options: cleanList(item?.options, 5, 40),
    }))
    .filter(item => item.question)
    .slice(0, QUESTIONS_MAX)
}

const present = raw => Object.fromEntries(Object.entries(raw && typeof raw === 'object' ? raw : {}).filter(([, value]) => value != null && value !== ''))

/**
 * "Tournament from text" answer -> { fields, suggested, questions, participants, remarks, notices }.
 * `fields` holds what the create form accepts (keys of its form, plus `courts`): the text's own
 * values with the AI's suggestions for what the text left out; `suggested` names the keys that
 * came from a suggestion, so the screen can mark them. `questions` (≤ 3) ask about what matters
 * and cannot be guessed. `notices` are i18n codes of what was dropped or changed here.
 * context: { enabledSports, sport, today, answered } — the sports on offer, the current sport, the
 * organizer's date (YYYY-MM-DD) and whether the organizer has answered earlier questions.
 */
export function checkCreate(json, { enabledSports = SPORTS, sport: currentSport = 'tennis', today = null, answered = false } = {}) {
  if (!json || typeof json !== 'object' || (json.tournament != null && typeof json.tournament !== 'object')) {
    throw Object.assign(new Error('ai.badResponse'), { code: 'ai.badResponse' })
  }
  const context = { enabledSports, sport: currentSport, today }
  const rawEntries = Array.isArray(json.participants) ? json.participants : []
  const fromText = tournamentFields(json.tournament ?? {}, rawEntries, context)
  const merged = tournamentFields({ ...present(json.suggested), ...present(json.tournament) }, rawEntries, context)
  const suggested = Object.keys(merged.fields).filter(key => !Object.hasOwn(fromText.fields, key) || fromText.fields[key] !== merged.fields[key])
  const notices = new Set(fromText.notices)

  // The list in the shape this tournament takes (pairs split for Americano and the like).
  const shape = entryShape({ format: merged.format ?? null, category: merged.effectiveCategory, doubles_pairing_mode: merged.pairing })
  const list = checkImport({ entries: rawEntries, unparsed: json.unparsed, warnings: json.warnings }, { shape })
  for (const code of list.notices) notices.add(code)
  const people = list.entries.reduce((sum, entry) => sum + entry.members.length, 0)
  if (merged.format === 'king_of_court' && people && people % 4 !== 0) notices.add('kotcPlayers')
  const capacity = Number(merged.fields.registration_capacity)
  if (capacity && list.entries.length > capacity) notices.add('capacityLow')

  return {
    fields: merged.fields,
    suggested,
    questions: cleanQuestions(json.questions, { given: present(json.tournament), chosen: present(json.suggested), answered }),
    participants: { entries: list.entries, unparsed: list.unparsed },
    remarks: list.remarks,
    notices: [...notices],
  }
}

const SCORE_RESULTS_MAX = 24
const SCORE_SETS_MAX = 5
const score = value => (value == null || value === '' ? null : wholeNumber(value, 0, 999))

// One side's numbers of a set or a match: integers 0–999, else null.
function scorePair(raw) {
  if (Array.isArray(raw)) raw = { a: raw[0], b: raw[1] }
  if (!raw || typeof raw !== 'object') return null
  const a = score(raw.a)
  const b = score(raw.b)
  if (a == null || b == null) return null
  return { a, b }
}

/**
 * "Score from speech or text" answer -> { results, unmatched, remarks }. Each result names a
 * match by its reference from the list sent to the model (`refs`: ref -> anything); a result
 * whose match is unknown is dropped, one naming several candidates keeps them for the screen.
 * Scores are as seen from the listed side A: `sets` [{a, b, tb?: {a, b}}] for the sets family,
 * `score` {a, b} (+ `pens` {a, b} for football) otherwise. `winner` is the side the text says
 * won ('a' | 'b' | null), so the screen can catch a score read the wrong way round.
 */
export function checkScore(json, { refs = {}, family = 'sets' } = {}) {
  if (!json || !Array.isArray(json.results)) throw Object.assign(new Error('ai.badResponse'), { code: 'ai.badResponse' })
  const known = ref => (typeof ref === 'string' && Object.hasOwn(refs, ref) ? ref : null)
  const results = []
  const unmatched = cleanList(json.unmatched, UNPARSED_MAX, REMARK_MAX)
  for (const raw of json.results.slice(0, SCORE_RESULTS_MAX)) {
    if (!raw || typeof raw !== 'object') continue
    const heard = shortText(raw.heard, REMARK_MAX)
    const match = known(raw.match)
    const candidates = [...new Set((Array.isArray(raw.candidates) ? raw.candidates : []).map(known).filter(Boolean))].slice(0, 5)
    if (!match && candidates.length < 2) {
      if (heard) unmatched.push(heard)
      continue
    }
    const result = { match, candidates: match ? [] : candidates, heard, winner: enumOf(raw.winner, ['a', 'b']) }
    if (family === 'sets') {
      result.sets = (Array.isArray(raw.sets) ? raw.sets : []).slice(0, SCORE_SETS_MAX).map(set => {
        const games = scorePair(set)
        if (!games) return null
        const tb = scorePair(set?.tb)
        return tb ? { ...games, tb } : games
      }).filter(Boolean)
      if (!result.sets.length) result.sets = null
    } else {
      result.score = scorePair(raw.score)
      if (family === 'goals') result.pens = scorePair(raw.pens)
    }
    results.push(result)
  }
  return { results, unmatched: unmatched.slice(0, UNPARSED_MAX), remarks: cleanList(json.warnings, 5, REMARK_MAX) }
}
