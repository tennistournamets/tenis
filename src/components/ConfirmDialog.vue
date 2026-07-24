<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { confirmState, settleConfirm } from '../lib/confirmDialog'

const { t } = useI18n()
const confirmBtn = ref(null)

function onKeydown(e) {
  if (!confirmState.open) return
  if (e.key === 'Escape') {
    e.preventDefault()
    settleConfirm(false)
  }
}

watch(
  () => confirmState.open,
  (open) => {
    if (open) {
      requestAnimationFrame(() => confirmBtn.value?.focus())
    }
  },
)

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div
      v-if="confirmState.open"
      class="modal-backdrop"
      role="presentation"
      @click.self="settleConfirm(false)"
    >
      <div
        class="modal-dialog confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        :aria-label="confirmState.message"
      >
        <p class="confirm-dialog__message">{{ confirmState.message }}</p>
        <div class="confirm-dialog__actions">
          <button class="btn btn--ghost" type="button" @click="settleConfirm(false)">
            {{ t('actions.cancel') }}
          </button>
          <button
            ref="confirmBtn"
            class="btn"
            :class="confirmState.danger ? 'btn--danger' : 'btn--primary'"
            type="button"
            @click="settleConfirm(true)"
          >
            {{ t('actions.confirm') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.confirm-dialog {
  width: min(420px, 100%);
}

.confirm-dialog__message {
  margin: 0 0 var(--space-4);
  font-size: 0.95rem;
  line-height: 1.55;
  color: var(--text);
  white-space: pre-line;
}

.confirm-dialog__actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
