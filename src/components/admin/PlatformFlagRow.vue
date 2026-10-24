<script setup>
// One platform switch row in /admin/platform: icon, name, hint, key + last change, on/off switch.
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'

defineProps({
  flagKey: { type: String, required: true },
  title: { type: String, required: true },
  hint: { type: String, default: '' },
  icon: { type: String, default: '' },
  enabled: { type: Boolean, default: false },
  busy: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  // Replaces the "updated …" note, e.g. "off by the master switch".
  note: { type: String, default: '' },
  updatedAt: { type: String, default: null },
  missing: { type: Boolean, default: false },
  muted: { type: Boolean, default: false },
  ariaLabel: { type: String, default: '' },
})
defineEmits(['toggle'])

const { t, locale } = useI18n()

function formatDate(value) {
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return ''
  }
}
</script>

<template>
  <li class="flag-row" :class="{ 'flag-row--muted': muted }">
    <span v-if="icon" class="flag-row__icon" aria-hidden="true"><AppIcon :name="icon" :size="22" /></span>
    <div class="flag-row__text">
      <span class="flag-row__name">{{ title }}</span>
      <span v-if="hint" class="flag-row__meta">{{ hint }}</span>
      <span class="flag-row__meta">
        <code>{{ flagKey }}</code>
        <template v-if="note"> · <strong class="flag-row__note">{{ note }}</strong></template>
        <template v-else-if="updatedAt"> · {{ t('admin.platformUpdated', { date: formatDate(updatedAt) }) }}</template>
        <template v-else-if="missing"> · {{ t('admin.platformNoRow') }}</template>
      </span>
    </div>
    <label class="switch" :class="{ 'switch--busy': busy }">
      <input
        type="checkbox"
        :checked="enabled"
        :disabled="disabled || busy"
        :aria-label="ariaLabel || title"
        @change="$emit('toggle', $event.target.checked)"
      />
      <span class="switch__track"><span class="switch__thumb"></span></span>
      <span class="switch__label">{{ enabled ? t('admin.platformOn') : t('admin.platformOff') }}</span>
    </label>
  </li>
</template>

<style scoped>
.flag-row {
  display: flex;
  align-items: center;
  gap: var(--space-3, 12px);
  padding: 12px 0;
  border-top: 1px solid var(--border);
}
.flag-row:first-child {
  border-top: none;
}
.flag-row__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: 10px;
  flex: none;
  color: var(--primary);
  background: var(--primary-soft);
}
.flag-row__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  flex: 1;
}
.flag-row__name {
  font-weight: 600;
}
.flag-row__meta {
  font-size: 0.75rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.flag-row__meta code {
  font-size: 0.75rem;
}
.flag-row__note {
  font-weight: 600;
  color: var(--warning-text);
}
.flag-row--muted .flag-row__name {
  color: var(--muted);
}
.switch--busy {
  opacity: 0.6;
}
</style>
