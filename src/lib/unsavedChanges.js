import { onBeforeUnmount } from 'vue'
import { confirmDialog, confirmState } from './confirmDialog.js'

const forms = new Map()
let approvedDeparture = false
export async function withApprovedDeparture(action) {
  approvedDeparture = true
  try { return await action() } finally { approvedDeparture = false }
}
export const hasUnsavedChanges = () => [...forms.values()].some(f => f.dirty() || f.busy())
const hasPendingSave = () => [...forms.values()].some(f => f.busy())
export function registerUnsavedForm(dirty, busy = () => false, discard = null) {
  const key = Symbol('form')
  forms.set(key, { dirty, busy, discard })
  return () => forms.delete(key)
}
export function useUnsavedChanges(dirty, busy, discard = null) {
  const unregister = registerUnsavedForm(dirty, busy, discard)
  onBeforeUnmount(unregister)
  return unregister
}
export async function confirmDiscard(t, dirty, busy = false) {
  if (busy) return false
  return !dirty || await confirmDialog(t('drafts.leave'), { danger: true, confirmLabel: t('drafts.discardLeave') })
}
export async function confirmLeaveForms(t) {
  if (approvedDeparture) return true
  // Do not interrupt a score-correction confirmation or an in-flight save.
  if (hasPendingSave() || confirmState.open) return false
  const changed = [...forms.values()].filter(form => form.dirty())
  const confirmed = await confirmDiscard(t, changed.length > 0)
  if (confirmed) changed.forEach(form => form.discard?.())
  return confirmed
}
export function beforeUnload(event) {
  if (!hasUnsavedChanges()) return
  event.preventDefault()
  event.returnValue = ''
}
