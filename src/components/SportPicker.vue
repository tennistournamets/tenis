<script setup>
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { useFeatureFlagsStore } from '../stores/featureFlags'
import AppIcon from './AppIcon.vue'

defineProps({
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const flags = useFeatureFlagsStore()
const sports = computed(() => flags.enabledSports)

onMounted(() => { flags.load().catch(() => {}) })

</script>

<template>
  <p v-if="flags.loaded && sports.length === 0" class="picker-empty">{{ t('admin.noSportsEnabled') }}</p>
  <div v-else class="picker-grid">
    <button
      v-for="s in sports"
      :key="s"
      type="button"
      class="picker-card"
      :class="{ 'picker-card--active': modelValue === s }"
      @click="emit('update:modelValue', s)"
    >
      <span class="picker-card__icon"><AppIcon :name="s" :size="28" /></span>
      <span class="picker-card__label">{{ t('sport.' + s) }}</span>
      <span class="picker-card__tagline">{{ t('sportTagline.' + s) }}</span>
    </button>
  </div>
</template>

<style scoped>
.picker-empty {
  margin: 0;
  padding: 16px;
  border: 1px dashed var(--border, #d0d5dd);
  border-radius: var(--radius, 12px);
  color: var(--muted);
  font-size: var(--font-sm, 0.9rem);
  text-align: center;
}
.picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: var(--space-3, 12px);
}
.picker-card {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 24px 12px 20px;
  border: 1.5px solid var(--border, #d0d5dd);
  border-radius: var(--radius, 12px);
  background: var(--surface, #fff);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s, transform 0.1s;
}
.picker-card:hover {
  border-color: var(--primary, #3b82f6);
  box-shadow: var(--shadow-sm);
}
.picker-card:active {
  transform: scale(0.98);
}
.picker-card--active {
  border-color: var(--primary, #3b82f6);
  background: var(--primary-soft, rgba(59, 130, 246, 0.08));
  box-shadow: inset 0 0 0 1px var(--primary);
}
.picker-card__tagline {
  font-size: 0.75rem;
  color: var(--muted);
}
.picker-card--active::after {
  content: '';
  position: absolute;
  top: 10px;
  right: 10px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  background: var(--primary, #3b82f6) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='11' height='11' viewBox='0 0 24 24' fill='none' stroke='%23ffffff' stroke-width='3.5' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 6 9 17l-5-5'/%3E%3C/svg%3E") center / 11px no-repeat;
}
.picker-card__icon {
  display: inline-flex;
  color: var(--primary);
}
.picker-card__label {
  font-weight: 600;
  font-size: var(--font-sm, 0.9rem);
}
</style>
