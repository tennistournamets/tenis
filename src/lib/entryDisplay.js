/**
 * Ordered player names for an entry.
 * Prefers entry_members rows, falls back to splitting display_name on " / ".
 * @param {object | undefined} entry
 * @returns {string[]}
 */
export function entryMemberNames(entry) {
  if (!entry) {
    return []
  }
  const rows = entry.entry_members
  if (Array.isArray(rows) && rows.length) {
    const names = [...rows]
      .sort((a, b) => (a.member_order ?? 0) - (b.member_order ?? 0))
      .map((m) => (m.member_name ?? '').trim())
      .filter(Boolean)
    if (names.length) {
      return names
    }
  }
  const name = (entry.display_name ?? '').trim()
  if (!name) {
    return []
  }
  if (isDoublesEntry(entry) && name.includes(' / ')) {
    return name
      .split(' / ')
      .map((n) => n.trim())
      .filter(Boolean)
  }
  return [name]
}

export function isDoublesEntry(entry) {
  return entry?.entry_type === 'doubles'
}

/**
 * The name the organizer or applicant chose for the bracket ("Как показывать в
 * сетке"), or '' when display_name is just the member names joined.
 * @param {object | undefined} entry
 * @returns {string}
 */
export function customDisplayName(entry) {
  const name = (entry?.display_name ?? '').trim()
  const rows = Array.isArray(entry?.entry_members) ? entry.entry_members : []
  const members = [...rows]
    .sort((a, b) => (a.member_order ?? 0) - (b.member_order ?? 0))
    .map((m) => (m.member_name ?? '').trim())
    .filter(Boolean)
  if (!name || !members.length) return ''
  return name === members.join(' / ') ? '' : name
}

/**
 * Lines to show for an entry in matches, brackets and tables: the chosen
 * display name when there is one, otherwise the member names.
 * @param {object | undefined} entry
 * @returns {string[]}
 */
export function entryDisplayNames(entry) {
  const custom = customDisplayName(entry)
  return custom ? [custom] : entryMemberNames(entry)
}
