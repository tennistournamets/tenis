<script setup>
// Unknown addresses. On Vercel they also get HTTP 404 (vercel.json serves the SPA only on
// known routes, dist/404.html otherwise); the noindex tag covers the dev server and old links.
import { onBeforeUnmount, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useI18n } from 'vue-i18n'
import BrandLogo from '../components/BrandLogo.vue'
import { setRobotsMeta } from '../lib/access'

const { t } = useI18n()

onMounted(() => setRobotsMeta(false))
onBeforeUnmount(() => setRobotsMeta(true))
</script>

<template>
  <section class="card empty-state not-found" role="alert">
    <RouterLink class="not-found__brand" :to="{ name: 'home' }"><BrandLogo :size="28" />{{ t('app.title') }}</RouterLink>
    <p class="not-found__code" aria-hidden="true">404</p>
    <h1 class="empty-state__title">{{ t('app.notFoundTitle') }}</h1>
    <p class="empty-state__hint">{{ t('app.notFoundText') }}</p>
    <RouterLink class="btn btn--primary" :to="{ name: 'home' }">{{ t('app.notFoundHome') }}</RouterLink>
  </section>
</template>

<style scoped>
.not-found {
  max-width: 520px;
  margin: 10vh auto 0;
}

.not-found__brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-family: var(--font-display);
  font-weight: 800;
  font-size: 1.125rem;
  color: var(--text);
  text-decoration: none;
}

.not-found__code {
  margin: var(--space-4) 0 0;
  font-family: var(--font-mono);
  font-size: 3rem;
  font-weight: 600;
  line-height: 1;
  color: var(--primary);
}
</style>
