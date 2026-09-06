<script setup>
import { useI18n } from 'vue-i18n'
import AppModal from './AppModal.vue'
import { confirmState, settleConfirm } from '../lib/confirmDialog'

const { t } = useI18n()
</script>

<template>
  <AppModal
    v-if="confirmState.open"
    role="alertdialog"
    :label="confirmState.message"
    @close="settleConfirm(false)"
  >
    <div class="modal-dialog confirm-dialog" :class="{ 'confirm-dialog--details': confirmState.details }">
      <p class="confirm-dialog__message">{{ confirmState.message }}</p>
      <div v-if="confirmState.details" class="confirm-dialog__details">
        <p>{{ confirmState.details.intro }}</p>
        <ul class="confirm-dialog__matches">
          <li v-for="item in confirmState.details.items" :key="item.id">
            <span class="muted">{{ item.title }}</span>
            <strong>{{ item.teams }}</strong>
            <span>{{ item.effect }}</span>
          </li>
        </ul>
      </div>
      <p v-if="confirmState.details" class="alert alert--info confirm-dialog__warning" role="status">{{ confirmState.details.warning }}</p>
      <div class="confirm-dialog__actions">
        <button class="btn btn--ghost" type="button" autofocus @click="settleConfirm(false)">
          {{ t('actions.cancel') }}
        </button>
        <button
          class="btn"
          :disabled="confirmState.disabled"
          :class="confirmState.danger ? 'btn--danger' : 'btn--primary'"
          type="button"
          @click="settleConfirm(true)"
        >
          {{ confirmState.confirmLabel || t('actions.confirm') }}
        </button>
      </div>
    </div>
  </AppModal>
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
.confirm-dialog--details {
  width: min(620px, 100%);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.confirm-dialog--details .confirm-dialog__message { flex-shrink: 0; font-weight: 600; }
.confirm-dialog__warning { flex-shrink: 0; margin: var(--space-3) 0 0; }
.confirm-dialog__details { min-height: 0; overflow: auto; overscroll-behavior: contain; }
.confirm-dialog--details .confirm-dialog__actions { flex-shrink: 0; padding-top: var(--space-3); }
.confirm-dialog__matches { list-style: none; padding: 0; display: grid; gap: 10px; }
.confirm-dialog__matches li { display: grid; gap: 4px; padding: 10px; border: 1px solid var(--border); border-radius: 8px; overflow-wrap: anywhere; }
.confirm-dialog__actions { flex-wrap: wrap; }
</style>
