<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { lockPageScroll } from '../lib/modalScrollLock'

defineProps({
  label: { type: String, required: true },
  role: { type: String, default: 'dialog' },
})

const emit = defineEmits(['close'])
const dialog = ref(null)
let unlockPage = null
let returnFocus = null
let backdropPointer = false

onMounted(() => {
  returnFocus = document.activeElement
  unlockPage = lockPageScroll()
  // The browser's top layer also makes every underlying page/dialog inert.
  dialog.value.showModal()
})

onBeforeUnmount(() => {
  dialog.value?.close()
  unlockPage?.()
  if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true })
})

function onKeydown(event) {
  // Keep global shortcuts (e.g. bracket panning) off the underlying page.
  event.stopPropagation()
  if (event.key !== 'Tab') return
  const focusable = [...dialog.value.querySelectorAll(
    'button, [href], input, select, textarea, [tabindex], [contenteditable="true"]',
  )].filter((element) => element.tabIndex >= 0 && !element.matches(':disabled') && element.getClientRects().length > 0)
  const first = focusable[0]
  const last = focusable[focusable.length - 1]
  if (!first) {
    event.preventDefault()
  } else if (event.shiftKey && (document.activeElement === first || !focusable.includes(document.activeElement))) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && (document.activeElement === last || !focusable.includes(document.activeElement))) {
    event.preventDefault()
    first.focus()
  }
}

function onBackdropClick(event) {
  // Dragging from inside the form onto the backdrop must not discard the form.
  if (event.target === dialog.value && backdropPointer) emit('close')
  backdropPointer = false
}
</script>

<template>
  <Teleport to="body">
    <dialog
      ref="dialog"
      class="modal-backdrop"
      :role="role"
      aria-modal="true"
      :aria-label="label"
      @cancel.prevent="emit('close')"
      @keydown="onKeydown"
      @pointerdown="backdropPointer = $event.target === dialog"
      @click="onBackdropClick"
    >
      <slot />
    </dialog>
  </Teleport>
</template>
