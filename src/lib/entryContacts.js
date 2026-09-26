// Applicants' contacts for organizers. The contact columns are closed to every
// API role; owners and editors read them through get_entry_contacts, which
// returns nothing for a results-only counter.

/** { [entryId]: { phone, email } } from the RPC rows; placeholders never reach here. */
export function indexEntryContacts(rows = []) {
  const index = {}
  for (const row of rows || []) {
    if (!row?.entry_id || (!row.contact_phone && !row.contact_email)) continue
    index[row.entry_id] = { phone: row.contact_phone || null, email: row.contact_email || null }
  }
  return index
}

/** Phone link target: digits and a leading plus only. */
export function phoneHref(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '')
  return digits ? `tel:${digits}` : ''
}

export async function loadEntryContacts(client, tournamentId) {
  const { data, error } = await client.rpc('get_entry_contacts', { p_tournament_id: tournamentId })
  if (error) throw error
  return indexEntryContacts(data)
}
