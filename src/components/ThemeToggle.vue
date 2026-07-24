<script setup>
import { useI18n } from 'vue-i18n'

import { theme, toggleTheme } from '../lib/theme'

const { t } = useI18n()
</script>

<template>
  <button
    class="theme-toggle"
    type="button"
    :aria-label="t('nav.toggleTheme')"
    :title="t('nav.toggleTheme')"
    @click="toggleTheme"
  >
    <!-- Луна в светлой теме (переключит в тёмную), солнце — в тёмной -->
    <svg v-if="theme === 'dark'" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2" /><path d="M12 20v2" /><path d="m4.93 4.93 1.41 1.41" /><path d="m17.66 17.66 1.41 1.41" />
      <path d="M2 12h2" /><path d="M20 12h2" /><path d="m6.34 17.66-1.41 1.41" /><path d="m19.07 4.93-1.41 1.41" />
    </svg>
    <svg v-else width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z" />
    </svg>
  </button>
</template>

<style scoped>
.theme-toggle {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 38px;
  height: 38px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.theme-toggle:hover {
  color: var(--text);
  border-color: var(--border-strong);
}
</style>
