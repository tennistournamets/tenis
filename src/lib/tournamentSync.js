// Realtime is an invalidation signal. Only a complete server snapshot is applied.
// A single flight coalesces bursts; events during a read invalidate that response.
// An invalidated response is discarded once. A second invalidated response, or one
// that took longer than `slowReadMs`, is still applied (it is newer than what is on
// screen) and followed by another read: on a slow link the 30 s poll alone would
// otherwise invalidate every read and the page would never update.
export function createSnapshotRefresh({ read, apply, onError, delay = 150, retryDelay = 2000,
  slowReadMs = 10000, now = () => Date.now() }) {
  let version = 0, pending = false, disposed = false, timer = null, running = null
  function schedule(wait = delay) {
    if (!disposed && !timer && !running) timer = setTimeout(() => { timer = null; void run() }, wait)
  }
  async function run() {
    if (disposed) return false
    if (running) return running
    clearTimeout(timer); timer = null
    running = (async () => {
      let discarded = 0
      while (pending && !disposed) {
        pending = false
        const request = version
        const started = now()
        try {
          const value = await read()
          if (disposed) return false
          if (request !== version) {
            pending = true
            if (discarded < 1 && now() - started < slowReadMs) { discarded++; continue }
          }
          discarded = 0
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
  documentTarget = globalThis.document, pollMs = 30000, healthyPollMs = pollMs, healthy = () => false }) {
  let disposed = false
  let timer = null
  const request = payload => { if (!disposed) refresh(payload) }
  const visible = () => { if (!documentTarget || documentTarget.visibilityState === 'visible') request() }
  // The blind poll exists because a live channel can stop delivering without
  // saying so. While the channel still reports itself healthy that is a rare
  // fault, so the page asks far less often; a returning user is covered by
  // focus and visibility, which refresh immediately.
  const arm = () => {
    if (disposed) return
    clearTimeout(timer)
    timer = setTimeout(() => { visible(); arm() }, healthy() ? healthyPollMs : pollMs)
  }
  windowTarget?.addEventListener('online', request)
  windowTarget?.addEventListener('focus', visible)
  documentTarget?.addEventListener('visibilitychange', visible)
  arm()
  const stop = () => {
    disposed = true
    clearTimeout(timer)
    windowTarget?.removeEventListener('online', request)
    windowTarget?.removeEventListener('focus', visible)
    documentTarget?.removeEventListener('visibilitychange', visible)
  }
  // Losing the channel must shorten the next wait immediately, not after the
  // long interval that was armed while everything still looked fine.
  stop.retime = arm
  return stop
}

export function subscribeTournament({ client, id, name, getState, refresh, onStatus,
  windowTarget = globalThis.window, documentTarget = globalThis.document, pollMs = 30000,
  healthyPollMs = 120000, readyDelay = 700, recover = true }) {
  let disposed = false
  let subscribed = false
  let readyTimer = null
  const request = payload => { if (!disposed) refresh(payload) }
  // A join reports readiness twice: the channel says SUBSCRIBED, and postgres
  // says its listener is live a moment later — measured at 300 ms and 561 ms
  // against the live project. Both mean "events may start now", and a read must
  // follow, but one read after the last of them closes the same gap; reading on
  // each made every page load fetch the whole snapshot twice over.
  const requestReady = () => {
    if (disposed) return
    clearTimeout(readyTimer)
    readyTimer = setTimeout(() => { readyTimer = null; request() }, readyDelay)
  }
  const channel = client.channel(`${name}-${id}`)
  for (const table of ['tournaments', 'entries', 'matches', 'live_scores', 'groups', 'tournament_admins', 'courts', 'match_schedule']) {
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
    if (payload.extension === 'postgres_changes' && payload.status === 'ok') requestReady()
  })
  const stopRecovery = recover
    ? subscribeRefreshTriggers({ refresh: request, windowTarget, documentTarget, pollMs, healthyPollMs, healthy: () => subscribed })
    : null
  channel.subscribe(status => {
    if (disposed) return
    const wasSubscribed = subscribed
    subscribed = status === 'SUBSCRIBED'
    onStatus?.(status)
    if (subscribed) requestReady()
    if (subscribed !== wasSubscribed) stopRecovery?.retime?.()
  })
  return () => {
    disposed = true
    clearTimeout(readyTimer)
    stopRecovery?.()
    void client.removeChannel(channel)
  }
}
