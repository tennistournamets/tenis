// Checks for AI answers, shared by the server (api/_ai-tasks.js) and the browser. The model is
// never trusted: every field is cleaned, cut to the database limits or dropped.
import { MEMBER_NAME_MAX } from './registrationRules.js'
import { isIndividualFormat } from './sportConfig.js'

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
