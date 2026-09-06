// Realtime is an invalidation signal. Only a complete server snapshot is applied.
// A single flight coalesces bursts; events during a read invalidate that response.
export function createSnapshotRefresh({ read, apply, onError, delay = 150, retryDelay = 2000 }) {
  let version = 0, pending = false, disposed = false, timer = null, running = null
  function schedule(wait = delay) {
    if (!disposed && !timer && !running) timer = setTimeout(() => { timer = null; void run() }, wait)
  }
  async function run() {
    if (disposed) return false
    if (running) return running
    clearTimeout(timer); timer = null
    running = (async () => {
      while (pending && !disposed) {
        pending = false
        const request = version
        try {
          const value = await read()
          if (disposed) return false
          if (request !== version) { pending = true; continue }
          apply(value)
        } catch (error) {
          if (disposed) return false
          if (request !== version) { pending = true; continue }
          onError(error)
          pending = true
          return false
        }
      }
      return !disposed
    })()
    try { return await running }
    finally { running = null; if (pending) schedule(retryDelay) }
  }
  return {
    request() { if (!disposed) { version++; pending = true; schedule() } },
    refresh() { if (disposed) return Promise.resolve(false); version++; pending = true; return run() },
    dispose() { disposed = true; version++; pending = false; clearTimeout(timer) },
  }
}

// Kept for existing callers; database reads live in the repository.
export { readTournamentSnapshot } from './tournamentRepository.js'

// DELETE cannot be filtered reliably by tournament_id and RLS may send only PKs.
// Match those IDs against the last snapshot; never ingest an unscoped payload.
export function isTournamentEvent(payload, tournamentId, state) {
  const { table, eventType, new: row, old } = payload
  if (eventType !== 'DELETE') {
    if (table === 'tournaments') return row?.id === tournamentId
    if (row?.tournament_id) return row.tournament_id === tournamentId
    if (table === 'match_sets') return state.matches.some(m => m.id === row?.match_id)
    if (table === 'group_entries') return state.groups.some(g => g.id === row?.group_id)
    return false
  }
  if (table === 'tournaments') return old?.id === tournamentId
  if (old?.tournament_id) return old.tournament_id === tournamentId
  const key = { entries: 'entries', matches: 'matches', match_sets: 'sets', live_scores: 'live', groups: 'groups' }[table]
  if (key) return Boolean(old?.id && state[key].some(r => r.id === old.id))
  // Membership DELETEs can contain only a membership PK, which isn't part of
  // the displayed snapshot. A scoped reread is safe even for an unrelated ID.
  if (table === 'group_entries') return true
  // Membership deletion may revoke this page's access. Reread using RLS.
  return table === 'tournament_admins'
}

// Page recovery outlives any particular channel/ID. Public routes also need it
// while the slug is temporarily absent or access has been revoked.
export function subscribeRefreshTriggers({ refresh, windowTarget = globalThis.window,
  documentTarget = globalThis.document, pollMs = 30000 }) {
  let disposed = false
  const request = payload => { if (!disposed) refresh(payload) }
  const visible = () => { if (!documentTarget || documentTarget.visibilityState === 'visible') request() }
  windowTarget?.addEventListener('online', request)
  windowTarget?.addEventListener('focus', visible)
  documentTarget?.addEventListener('visibilitychange', visible)
  const poll = setInterval(visible, pollMs)
  return () => {
    disposed = true
    clearInterval(poll)
    windowTarget?.removeEventListener('online', request)
    windowTarget?.removeEventListener('focus', visible)
    documentTarget?.removeEventListener('visibilitychange', visible)
  }
}

export function subscribeTournament({ client, id, name, getState, refresh, onStatus,
  windowTarget = globalThis.window, documentTarget = globalThis.document, pollMs = 30000,
  recover = true }) {
  let disposed = false
  const request = payload => { if (!disposed) refresh(payload) }
  const channel = client.channel(`${name}-${id}`)
  for (const table of ['tournaments', 'entries', 'matches', 'live_scores', 'groups', 'tournament_admins']) {
    const filter = `${table === 'tournaments' ? 'id' : 'tournament_id'}=eq.${id}`
    const receive = payload => { if (!disposed && isTournamentEvent(payload, id, getState())) request(payload) }
    for (const event of ['INSERT', 'UPDATE']) channel.on('postgres_changes', { event, schema: 'public', table, filter }, receive)
    channel.on('postgres_changes', { event: 'DELETE', schema: 'public', table }, receive)
  }
  for (const table of ['match_sets', 'group_entries']) {
    channel.on('postgres_changes', { event: '*', schema: 'public', table }, payload => {
      if (!disposed && isTournamentEvent(payload, id, getState())) request(payload)
    })
  }
  // Postgres' listener can become ready after the channel joins. Close both gaps.
  channel.on('system', {}, payload => {
    if (payload.extension === 'postgres_changes' && payload.status === 'ok') request()
  })
  channel.subscribe(status => {
    if (disposed) return
    onStatus?.(status)
    if (status === 'SUBSCRIBED') request()
  })
  const stopRecovery = recover ? subscribeRefreshTriggers({ refresh: request, windowTarget, documentTarget, pollMs }) : null
  return () => {
    disposed = true
    stopRecovery?.()
    void client.removeChannel(channel)
  }
}
