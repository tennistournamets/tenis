// Users page (super-admin): search, filter and sort over platform_users_overview().users.
// Plain functions so the page and the tests share them.

export const USER_FILTERS = ['all', 'withTournaments', 'withoutTournaments']
export const USER_SORTS = ['created', 'lastSeen', 'tournaments']

const time = (value) => {
  const ms = value ? new Date(value).getTime() : NaN
  return Number.isFinite(ms) ? ms : -Infinity
}

const tournamentCount = (user) => user.tournaments?.length ?? 0

/** Newest tournament the user organizes (the list arrives newest first). */
export function latestTournament(user) {
  return user.tournaments?.[0] ?? null
}

export function filterUsers(users, { query = '', filter = 'all' } = {}) {
  const needle = query.trim().toLocaleLowerCase()
  return users.filter((user) => {
    if (filter === 'withTournaments' && !tournamentCount(user)) return false
    if (filter === 'withoutTournaments' && tournamentCount(user)) return false
    if (!needle) return true
    return [user.name, user.email].some((text) => text?.toLocaleLowerCase().includes(needle))
  })
}

export function filterCounts(users) {
  const withTournaments = users.filter((user) => tournamentCount(user)).length
  return { all: users.length, withTournaments, withoutTournaments: users.length - withTournaments }
}

/** Sorted copy; ties fall back to the newest account. */
export function sortUsers(users, key = 'created') {
  const byCreated = (a, b) => time(b.created_at) - time(a.created_at)
  const compare = {
    created: byCreated,
    lastSeen: (a, b) => time(b.last_seen_at) - time(a.last_seen_at),
    tournaments: (a, b) => tournamentCount(b) - tournamentCount(a)
      || time(latestTournament(b)?.created_at) - time(latestTournament(a)?.created_at),
  }[key] ?? byCreated
  return [...users].sort((a, b) => compare(a, b) || byCreated(a, b))
}
