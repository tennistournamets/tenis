<script setup>
// "Create tournament": straight to the wizard, or — while `ai.create` is on — a menu with
// "Manually" (the wizard) and "Quick with AI" (describe it, AI proposes the tournament).
import { nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'
import { useAiFeature } from '../../lib/aiFeatures'

defineProps({
  size: { type: String, default: 'sm' }, // 'sm' | 'md'
})
const { t } = useI18n()
const aiCreateOn = useAiFeature('create')
const open = ref(false)
const root = ref(null)
const menu = ref(null)

async function toggle() {
  open.value = !open.value
  if (open.value) {
    await nextTick()
    menu.value?.querySelector('a')?.focus()
  }
}
function close(focusTrigger = false) {
  open.value = false
  if (focusTrigger) root.value?.querySelector('button')?.focus()
}
function onDocMouseDown(event) {
  if (open.value && root.value && !root.value.contains(event.target)) close()
}
function onMenuKeydown(event) {
  const items = [...(menu.value?.querySelectorAll('a') ?? [])]
  const index = items.indexOf(document.activeElement)
  if (event.key === 'Escape') { event.preventDefault(); close(true) }
  else if (event.key === 'ArrowDown') { event.preventDefault(); items[(index + 1) % items.length]?.focus() }
  else if (event.key === 'ArrowUp') { event.preventDefault(); items[(index - 1 + items.length) % items.length]?.focus() }
}
onMounted(() => document.addEventListener('mousedown', onDocMouseDown))
onBeforeUnmount(() => document.removeEventListener('mousedown', onDocMouseDown))
</script>

<template>
  <RouterLink v-if="!aiCreateOn()" class="btn btn--primary" :class="{ 'btn--sm': size === 'sm' }" :to="{ name: 'admin-tournament-new' }">
    {{ t('admin.createTournament') }}
  </RouterLink>
  <div v-else ref="root" class="create-menu">
    <button
      type="button"
      class="btn btn--primary create-menu__trigger"
      :class="{ 'btn--sm': size === 'sm' }"
      aria-haspopup="menu"
      :aria-expanded="open"
      @click="toggle"
    >
      {{ t('admin.createTournament') }}
      <svg class="create-menu__chevron" :class="{ 'create-menu__chevron--open': open }" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    <div v-if="open" ref="menu" class="create-menu__pop" role="menu" @keydown="onMenuKeydown">
      <RouterLink class="create-menu__item" role="menuitem" :to="{ name: 'admin-tournament-new-ai' }" @click="close()">
        <span class="create-menu__icon create-menu__icon--ai" aria-hidden="true"><AppIcon name="sparkles" :size="18" /></span>
        <span class="create-menu__text">
          <span class="create-menu__title">{{ t('ai.create.menu.quick') }}</span>
          <span class="create-menu__hint">{{ t('ai.create.menu.quickHint') }}</span>
        </span>
      </RouterLink>
      <RouterLink class="create-menu__item" role="menuitem" :to="{ name: 'admin-tournament-new' }" @click="close()">
        <span class="create-menu__icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6h16" /><path d="M4 12h10" /><path d="M4 18h7" /></svg>
        </span>
        <span class="create-menu__text">
          <span class="create-menu__title">{{ t('ai.create.menu.manual') }}</span>
          <span class="create-menu__hint">{{ t('ai.create.menu.manualHint') }}</span>
        </span>
      </RouterLink>
    </div>
  </div>
</template>

<style scoped>
.create-menu {
  position: relative;
  display: inline-block;
}
.create-menu__trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.create-menu__chevron {
  transition: transform 0.15s ease;
}
.create-menu__chevron--open {
  transform: rotate(180deg);
}
.create-menu__pop {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 50;
  width: min(320px, calc(100vw - 32px));
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 10px);
  box-shadow: var(--shadow-lg, 0 12px 32px rgba(0, 0, 0, 0.3));
}
.create-menu__item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  color: var(--text);
  text-decoration: none;
}
.create-menu__item:hover,
.create-menu__item:focus-visible {
  background: var(--surface-hover);
  outline: none;
}
.create-menu__item:focus-visible {
  box-shadow: inset 0 0 0 2px var(--primary);
}
.create-menu__icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: 10px;
  color: var(--muted);
  background: var(--surface-row);
}
.create-menu__icon--ai {
  color: var(--primary);
  background: var(--primary-soft);
}
.create-menu__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.create-menu__title {
  font-weight: 600;
}
.create-menu__hint {
  font-size: 0.8125rem;
  color: var(--muted);
  white-space: normal;
}
</style>
