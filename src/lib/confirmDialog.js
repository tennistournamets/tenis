import { reactive } from 'vue'

// Global state for the app-wide confirm dialog (rendered in App.vue).
export const confirmState = reactive({
  open: false,
  message: '',
  danger: false,
  details: null,
  confirmLabel: '',
  disabled: false,
  resolve: null,
})

// Drop-in replacement for window.confirm: `if (!(await confirmDialog(msg))) return`
export function confirmDialog(message, { danger = false, details = null, confirmLabel = '', disabled = false } = {}) {
  return new Promise((resolve) => {
    // If a dialog is already open, cancel it first.
    if (confirmState.resolve) {
      confirmState.resolve(false)
    }
    confirmState.message = message
    confirmState.danger = danger
    confirmState.details = details
    confirmState.confirmLabel = confirmLabel
    confirmState.disabled = disabled
    confirmState.resolve = resolve
    confirmState.open = true
  })
}

export function settleConfirm(result) {
  if (result && confirmState.disabled) return
  confirmState.open = false
  const resolve = confirmState.resolve
  confirmState.resolve = null
  resolve?.(result)
}
