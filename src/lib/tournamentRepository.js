// Absence is a successful read with no visible tournament. Query failures remain
// errors so a caller can preserve the last snapshot and show a retry state.
export async function readTournamentSnapshot(client, id) {
  const { data, error } = await client.rpc('get_tournament_sync_state', { p_tournament_id: id })
  if (error) throw error
  return data
}

export async function readAdminTournamentSnapshot(client, id, { includeAdmins = false } = {}) {
  const [data, roleResult] = await Promise.all([
    readTournamentSnapshot(client, id),
    client.rpc('get_my_tournament_role', { p_tournament_id: id }),
  ])
  if (roleResult.error) throw roleResult.error
  const role = roleResult.data
  let adminRows
  if (includeAdmins) {
    if (['owner', 'editor'].includes(role)) {
      const result = await client.rpc('get_tournament_admins_with_email', { p_tournament_id: id })
      if (result.error) throw result.error
      adminRows = result.data || []
    } else adminRows = []
  }
  return { data, role, adminRows }
}

async function findTournamentId(client, slug) {
  const { data, error } = await client.from('tournaments').select('id').eq('slug', slug).maybeSingle()
  if (error) throw error
  return data?.id || null
}

// Create one reader per route/slug and run it through createSnapshotRefresh.
// Only the ID is cached; every refresh still reads the complete snapshot under
// current RLS. A renamed tournament must never appear at its former public URL.
// onResolve(null) should also clear the displayed snapshot: a later replacement
// lookup may fail after the previous tournament has already become invalid.
export function createPublicTournamentReader(client, slug, { onResolve } = {}) {
  let id = null
  function resolve(nextId) {
    if (id === nextId) return
    id = nextId
    onResolve?.(id)
  }

  return async function read() {
    if (!id) resolve(await findTournamentId(client, slug))
    if (!id) return null

    const previousId = id
    const data = await readTournamentSnapshot(client, id)
    if (data?.tournament?.slug === slug) return data

    // Deletion, access revocation or a slug change invalidates the cached ID.
    // Resolve once more in case another tournament has taken this public URL.
    // Do not retry the same invisible/mismatched ID in the same read.
    resolve(null)
    const replacementId = await findTournamentId(client, slug)
    if (!replacementId || replacementId === previousId) return null
    resolve(replacementId)
    const replacement = await readTournamentSnapshot(client, replacementId)
    if (replacement?.tournament?.slug === slug) return replacement
    resolve(null)
    return null
  }
}
