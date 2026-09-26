// Restoring the create-wizard draft from sessionStorage and small wizard checks.
import { fromDatetimeLocal } from './registrationRules.js'

/**
 * Stored draft fields that still fit the current form shape. Nullable fields (map point)
 * accept numbers/strings, and a number typed into a text-default field (the capacity
 * input is type=number, v-model stores a number) is kept as its string.
 */
export function restoreDraftFields(initial, stored) {
  const restored = {}
  if (!stored || typeof stored !== 'object') return restored
  for (const [key, fallback] of Object.entries(initial)) {
    const value = stored[key]
    if (value === undefined) continue
    if (fallback === null) {
      if (value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value))) restored[key] = value
    } else if (typeof fallback === 'object') {
      if (value && typeof value === 'object' && !Array.isArray(value)) restored[key] = JSON.parse(JSON.stringify(value))
    } else if (typeof value === typeof fallback) {
      restored[key] = value
    } else if (typeof fallback === 'string' && typeof value === 'number' && Number.isFinite(value)) {
      restored[key] = String(value)
    }
  }
  return restored
}

/** A registration deadline that has already passed (intake would close at once). */
export function deadlineInPast(localValue, nowMs = Date.now()) {
  const iso = fromDatetimeLocal(localValue)
  return Boolean(iso) && new Date(iso).getTime() <= nowMs
}
