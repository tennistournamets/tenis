<script setup>
import { useI18n } from 'vue-i18n'
import { SPORTS } from '../lib/sportConfig'

defineProps({
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const icons = {
  tennis: '🎾',
  padel: '🏸',
  football: '⚽',
}
</script>

<template>
  <div class="picker-grid">
    <button
      v-for="s in SPORTS"
      :key="s"
      type="button"
      class="picker-card"
      :class="{ 'picker-card--active': modelValue === s }"
      @click="emit('update:modelValue', s)"
    >
      <span class="picker-card__icon">{{ icons[s] }}</span>
      <span class="picker-card__label">{{ t('sport.' + s) }}</span>
    </button>
  </div>
</template>

<style scoped>
.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-3, 12px);
}
.picker-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px 12px;
  border: 2px solid var(--border, #d0d5dd);
  border-radius: var(--radius, 12px);
  background: var(--surface, #fff);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, transform 0.1s;
}
.picker-card:hover {
  border-color: var(--primary, #3b82f6);
}
.picker-card:active {
  transform: scale(0.98);
}
.picker-card--active {
  border-color: var(--primary, #3b82f6);
  background: var(--primary-soft, rgba(59, 130, 246, 0.08));
}
.picker-card__icon {
  font-size: 2rem;
  line-height: 1;
}
.picker-card__label {
  font-weight: 600;
  font-size: var(--font-sm, 0.9rem);
}
</style>
