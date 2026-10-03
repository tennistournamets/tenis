import { formatDeadline } from './registrationRules.js'

// One tournament status reads the same everywhere: the list, the admin header
// and the public page share this mapping, so a colour always means one thing.
const STATUS_BADGE = {
  draft: 'badge--neutral',
  registration_open: 'badge--warn',
  registration_closed: 'badge--closed',
  in_progress: 'badge--live',
  completed: 'badge--done',
}

export function statusBadgeClass(status) {
  return STATUS_BADGE[status] || 'badge--neutral'
}

/**
 * Status shown on the badge. Registration that is still "open" past its
 * deadline accepts nothing, so it reads (and is coloured) as closed.
 */
export function displayStatus(tournament, nowMs = Date.now()) {
  const status = tournament?.status
  if (status !== 'registration_open' || !tournament?.registration_deadline) return status
  const deadline = new Date(tournament.registration_deadline).getTime()
  return Number.isFinite(deadline) && deadline <= nowMs ? 'registration_closed' : status
}

/**
 * Status text. Registration that ended by its deadline (the organizer has not
 * closed it yet) says so, with the date, so "ended" is not a mystery.
 */
export function statusText(t, locale, tournament, status = displayStatus(tournament)) {
  if (status === 'registration_closed' && tournament?.status === 'registration_open' && tournament.registration_deadline) {
    return t('tournament.registrationEndedByDeadline', { date: formatDeadline(tournament.registration_deadline, locale) })
  }
  return t(`tournament.${status}`)
}
