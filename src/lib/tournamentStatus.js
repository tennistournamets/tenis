// One tournament status reads the same everywhere: the list, the admin header
// and the public page share this mapping, so a colour always means one thing.
const STATUS_BADGE = {
  draft: 'badge--neutral',
  registration_open: 'badge--warn',
  registration_closed: 'badge--warn',
  in_progress: 'badge--live',
  completed: 'badge--done',
}

export function statusBadgeClass(status) {
  return STATUS_BADGE[status] || 'badge--neutral'
}
