// Registration conditions: capacity (approved entries take places), deadline
// and displayed entry fee. The server decides; these helpers mirror its codes
// and shape the organizer's form.
import { errorMessage } from './errorMessages.js'
import { scoringFamily } from './sportConfig.js'

export const FEE_CURRENCIES = ['EUR', 'USD', 'GBP', 'PLN']
export const FEE_UNITS = ['player', 'pair', 'team']
export const REGISTRATION_DRAFT_KEYS = ['registration_capacity', 'capacity_public', 'registration_deadline',
  'entry_fee_mode', 'entry_fee_amount', 'entry_fee_currency', 'entry_fee_unit', 'waitlist_enabled']

export function registrationError(message, t, fallbackKey = 'errors.generic') {
  return errorMessage(message, t, fallbackKey)
}

/** Client view of the server state; a deadline reached between snapshots closes the form locally. */
export function registrationDisplayState(registration, nowMs = Date.now(), tournament = null) {
  if (!registration) {
    const accepting = tournament?.status === 'registration_open'
    return { accepting, reason: accepting ? null : 'status', deadlinePassed: false, waitlistOpen: false, known: false }
  }
  const deadlineAt = registration.deadline_at ? new Date(registration.deadline_at).getTime() : NaN
  const deadlinePassed = Boolean(registration.deadline_passed) || (Number.isFinite(deadlineAt) && deadlineAt <= nowMs)
  let reason = registration.closed_reason || null
  if (!reason && deadlinePassed && registration.status === 'registration_open') reason = 'deadline'
  const waitlistOpen = reason === 'full' && Boolean(registration.waitlist_enabled)
  return { accepting: !reason, reason, deadlinePassed, waitlistOpen, known: true }
}

export function closedReasonKey(reason) {
  if (reason === 'full') return 'registrationRules.closedFull'
  if (reason === 'deadline') return 'registrationRules.closedDeadline'
  return 'registrationRules.closedStatus'
}

export function currencyDigits(currency) {
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits
  } catch {
    return 2
  }
}

export function minorToAmount(minor, currency) {
  if (minor == null || !Number.isFinite(Number(minor))) return ''
  const digits = currencyDigits(currency)
  return (Number(minor) / 10 ** digits).toFixed(digits)
}

export function amountToMinor(amount, currency) {
  const text = String(amount ?? '').trim().replace(',', '.')
  if (!text) return null
  const value = Number(text)
  if (!Number.isFinite(value) || value < 0) return null
  return Math.round(value * 10 ** currencyDigits(currency))
}

export function formatFee(fee, locale = 'en') {
  if (!fee || fee.mode !== 'paid' || fee.amount_minor == null || !fee.currency) return ''
  const amount = Number(fee.amount_minor) / 10 ** currencyDigits(fee.currency)
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency: fee.currency }).format(amount)
  } catch {
    return `${amount} ${fee.currency}`
  }
}

export function formatDeadline(iso, locale = 'en') {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  const dayOptions = { day: 'numeric', month: 'long' }
  if (date.getFullYear() !== new Date().getFullYear()) dayOptions.year = 'numeric'
  const timeOptions = { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  const format = (lang, options) => new Intl.DateTimeFormat(lang, options).format(date)
  try {
    return `${format(locale, dayOptions)}, ${format(locale, timeOptions)}`
  } catch {
    return `${format('en', dayOptions)}, ${format('en', timeOptions)}`
  }
}

export function feeUnitDefault(tournament) {
  if (scoringFamily(tournament?.sport || 'tennis') === 'goals') return 'team'
  return tournament?.category === 'doubles' ? 'pair' : 'player'
}

export function feeUnitKey(unit) {
  return unit === 'pair' ? 'registrationRules.unitPair' : unit === 'team' ? 'registrationRules.unitTeam' : 'registrationRules.unitPlayer'
}

const pad = n => String(n).padStart(2, '0')

export function toDatetimeLocal(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function fromDatetimeLocal(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Form draft fields derived from a tournament row (or an empty object for the wizard). */
export function registrationDraftFields(data = {}) {
  return {
    registration_capacity: data.registration_capacity == null ? '' : String(data.registration_capacity),
    capacity_public: data.capacity_public !== false,
    registration_deadline: toDatetimeLocal(data.registration_deadline),
    entry_fee_mode: data.entry_fee_mode || '',
    entry_fee_amount: data.entry_fee_mode === 'paid' ? minorToAmount(data.entry_fee_minor, data.entry_fee_currency) : '',
    entry_fee_currency: data.entry_fee_currency || 'EUR',
    entry_fee_unit: data.entry_fee_unit || '',
    waitlist_enabled: data.waitlist_enabled === true,
  }
}

export function pickRegistrationDraft(form) {
  return Object.fromEntries(REGISTRATION_DRAFT_KEYS.map(key => [key, form[key]]))
}

/** Returns an i18n key describing the first invalid field, or null. */
export function validateRegistrationForm(form) {
  const capacity = String(form.registration_capacity ?? '').trim()
  if (capacity !== '' && !(/^\d+$/.test(capacity) && Number(capacity) > 0)) return 'registrationRules.errors.invalidCapacity'
  if (form.entry_fee_mode === 'paid') {
    if (!FEE_CURRENCIES.includes(form.entry_fee_currency)) return 'registrationRules.errors.invalidFee'
    if (amountToMinor(form.entry_fee_amount, form.entry_fee_currency) == null) return 'registrationRules.errors.invalidFee'
  }
  return null
}

export function hasRegistrationRules(form) {
  return String(form.registration_capacity ?? '').trim() !== '' || Boolean(form.registration_deadline) || Boolean(form.entry_fee_mode) || Boolean(form.waitlist_enabled)
}

/** Settings patch for update_tournament_settings; only real columns are included. */
export function registrationPatch(form, tournament = null) {
  const capacity = String(form.registration_capacity ?? '').trim()
  const patch = {
    registration_capacity: capacity === '' ? null : Number(capacity),
    capacity_public: form.capacity_public !== false,
    registration_deadline: fromDatetimeLocal(form.registration_deadline),
    entry_fee_mode: form.entry_fee_mode || null,
    entry_fee_minor: null,
    entry_fee_currency: null,
    entry_fee_unit: null,
    waitlist_enabled: form.waitlist_enabled === true,
  }
  if (patch.entry_fee_mode === 'paid') {
    patch.entry_fee_currency = form.entry_fee_currency
    patch.entry_fee_unit = form.entry_fee_unit || feeUnitDefault(tournament)
    patch.entry_fee_minor = amountToMinor(form.entry_fee_amount, form.entry_fee_currency)
  }
  return patch
}
