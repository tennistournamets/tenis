<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

// Sponsorship is paid: before the constructor opens, the owner asks the platform
// for it. Shows where the request stands and, when allowed, the request form.
const props = defineProps({
  row: { type: Object, default: null }, // sponsorship_requests row, null = never asked
  isOwner: Boolean,
  busy: Boolean,
  error: { type: String, default: '' },
})
const emit = defineEmits(['request', 'refresh'])
const { t, locale } = useI18n()

const message = ref('')
const status = computed(() => props.row?.status || 'none')
const canAsk = computed(() => props.isOwner && (status.value === 'none' || status.value === 'rejected'))
const FEATURES = ['logos', 'banners', 'partners', 'uploads']

function formatDate(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return ''
  }
}

function submit() {
  emit('request', message.value.trim())
}
</script>

<template>
  <section v-if="status === 'approved'" class="alert alert--success sponsorship-access__ok" role="status">
    <strong>{{ t('sponsor.access.approvedTitle') }}</strong>
    <span v-if="row.decided_at" class="muted">{{ t('sponsor.access.approvedAt', { date: formatDate(row.decided_at) }) }}</span>
  </section>

  <section v-else class="card stack stack--sm admin-settings-card sponsorship-access" aria-labelledby="sponsorship-access-title">
    <div class="settings-section__head">
      <h2 id="sponsorship-access-title" class="section-title" style="margin: 0">
        {{ status === 'pending' ? t('sponsor.access.pendingTitle') : t('sponsor.access.title') }}
      </h2>
      <span class="badge" :class="status === 'pending' ? 'badge--warn' : status === 'rejected' ? 'badge--danger' : 'badge--neutral'">
        {{ t(`sponsor.access.status.${status}`) }}
      </span>
    </div>

    <template v-if="status === 'pending'">
      <p class="muted" style="margin: 0">{{ t('sponsor.access.pendingText') }}</p>
      <p class="sponsorship-access__meta">{{ t('sponsor.access.sentAt', { date: formatDate(row.created_at) }) }}</p>
      <blockquote v-if="row.message" class="sponsorship-access__quote">{{ row.message }}</blockquote>
      <div><button class="btn btn--outline btn--sm" type="button" :disabled="busy" @click="emit('refresh')">{{ t('sponsor.access.refresh') }}</button></div>
    </template>

    <template v-else>
      <p class="muted" style="margin: 0">{{ t('sponsor.access.text') }}</p>
      <ul class="sponsorship-access__features">
        <li v-for="key in FEATURES" :key="key">{{ t(`sponsor.access.feature.${key}`) }}</li>
      </ul>
      <p v-if="status === 'rejected'" class="alert alert--error" role="status" style="margin: 0">
        {{ t('sponsor.access.rejectedText', { date: formatDate(row.decided_at || row.updated_at) }) }}
      </p>

      <form v-if="canAsk" class="stack stack--sm" @submit.prevent="submit">
        <div class="form-field" style="margin: 0">
          <label for="sponsorship-message">{{ t('sponsor.access.message') }}</label>
          <textarea
            id="sponsorship-message"
            v-model="message"
            class="input"
            rows="3"
            maxlength="500"
            :placeholder="t('sponsor.access.messagePlaceholder')"
            :disabled="busy"
          />
          <p class="field-hint">{{ t('sponsor.access.messageHint') }}</p>
        </div>
        <div>
          <button class="btn btn--primary" type="submit" :disabled="busy">
            <span v-if="busy" class="spinner" aria-hidden="true" />
            {{ t('sponsor.access.request') }}
          </button>
        </div>
      </form>
      <p v-else-if="!isOwner" class="alert alert--info" role="status" style="margin: 0">{{ t('sponsor.access.ownerOnly') }}</p>
    </template>

    <p v-if="error" class="error-text" role="alert" style="margin: 0">{{ error }}</p>
  </section>
</template>

<style scoped>
.sponsorship-access__ok { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 12px; margin: 0; }
.sponsorship-access__features { display: grid; gap: 6px; margin: 0; padding-left: 20px; font-size: 0.875rem; color: var(--text); }
.sponsorship-access__meta { margin: 0; font-size: 0.8125rem; color: var(--muted); }
.sponsorship-access__quote {
  margin: 0;
  padding: 10px 14px;
  font-size: 0.875rem;
  color: var(--text);
  border-left: 3px solid var(--border-strong);
  background: var(--surface-2);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  overflow-wrap: anywhere;
}
</style>
