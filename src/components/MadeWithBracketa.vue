<script setup>
// Footer of every public tournament page: spectators and players are the next organizers.
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import BrandLogo from './BrandLogo.vue'
import { track } from '../lib/analytics'

const router = useRouter()
const { t } = useI18n()

const href = computed(() => router.resolve({
  name: 'home',
  query: { utm_source: 'bracketa', utm_medium: 'tournament_page', utm_campaign: 'made_with' },
}).href)
</script>

<template>
  <footer class="made-with">
    <a class="made-with__link" :href="href" target="_blank" rel="noopener" @click="track('made_with_click')">
      <BrandLogo :size="20" />
      <span class="made-with__text">{{ t('app.madeWith') }}</span>
      <span class="made-with__cta">{{ t('app.madeWithCta') }} →</span>
    </a>
  </footer>
</template>

<style scoped>
.made-with {
  display: flex;
  justify-content: center;
  padding:
    0
    calc(var(--space-4) + var(--safe-area-right))
    calc(var(--space-5) + var(--safe-area-bottom))
    calc(var(--space-4) + var(--safe-area-left));
}

.made-with__link {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 44px;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  font-size: 0.875rem;
  text-decoration: none;
  box-shadow: var(--shadow-sm);
  transition: border-color 0.15s ease, color 0.15s ease;
}

.made-with__link:hover {
  border-color: var(--primary);
  color: var(--text);
}

.made-with__link:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}

.made-with__cta {
  color: var(--primary);
  font-weight: 600;
}
</style>
