<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { getSportConfig } from '../lib/sportConfig'

const props = defineProps({
  modelValue: { type: String, default: '' },
  sport: { type: String, default: 'tennis' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const formats = computed(() => getSportConfig(props.sport).allowedFormats)

const icons = {
  single_elimination: '🏆',
  round_robin: '🔄',
  groups_playoff: '🗂️',
  double_elimination: '➿',
}
</script>

<template>
  <div class="picker-grid">
    <button
      v-for="f in formats"
      :key="f"
      type="button"
      class="picker-card"
      :class="{ 'picker-card--active': modelValue === f }"
      @click="emit('update:modelValue', f)"
    >
      <span class="picker-card__icon">{{ icons[f] }}</span>
      <span class="picker-card__label">{{ t('tournamentFormat.' + f) }}</span>
    </button>
  </div>
</template>

<style scoped>
.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
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
  text-align: center;
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
  font-size: 1.8rem;
  line-height: 1;
}
.picker-card__label {
  font-weight: 600;
  font-size: var(--font-sm, 0.9rem);
}
</style>
