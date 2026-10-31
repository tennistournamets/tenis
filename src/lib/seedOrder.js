// Draft seed order in the seed editor: a list of entry ids, strongest first.
// The editor moves ids around and saves the whole list with
// set_entry_seed_order; these helpers never mutate their input.

/** `order` with `id` moved to 1-based `position` (clamped to the list). */
export function moveToPosition(order, id, position) {
  const from = order.indexOf(id)
  if (from < 0) return order.slice()
  const target = Math.min(Math.max(Math.trunc(Number(position)) || 1, 1), order.length) - 1
  const next = order.slice()
  next.splice(from, 1)
  next.splice(target, 0, id)
  return next
}

/** `order` with the id at `from` moved to index `to` (0-based). */
export function moveIndex(order, from, to) {
  if (from === to || from < 0 || from >= order.length) return order.slice()
  const next = order.slice()
  const [id] = next.splice(from, 1)
  next.splice(Math.min(Math.max(to, 0), next.length), 0, id)
  return next
}

/** The field in registration order (created_at, then id: the server's tie-break). */
export function registrationOrder(entries = []) {
  return entries.slice()
    .sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || String(a.id).localeCompare(String(b.id)))
    .map(e => e.id)
}

/**
 * Keeps a draft in step with the approved field while it is being edited:
 * entries that left drop out, entries that arrived go to the end in the
 * field's own order.
 */
export function mergeOrder(draft, fieldIds) {
  const present = new Set(fieldIds)
  const kept = draft.filter(id => present.has(id))
  const known = new Set(kept)
  return [...kept, ...fieldIds.filter(id => !known.has(id))]
}

/** Parses what was typed into the "№" field; null when it is not a whole number. */
export function parsePosition(raw) {
  const text = String(raw ?? '').trim()
  return /^\d+$/.test(text) && Number(text) >= 1 ? Number(text) : null
}
