<script setup>
import { computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'

import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const auth = useAuthStore()

const accountInitials = computed(() => {
  const src = auth.currentPlayer?.display_name || auth.user?.email || '?'
  return src
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
})

onMounted(async () => {
  await auth.init()
})
</script>

<template>
  <div class="stack" style="max-width: 720px">
    <h1 class="page-title">{{ t('admin.settingsTitle') }}</h1>

    <section class="card stack stack--sm">
      <h2 class="section-title">{{ t('admin.settingsAccount') }}</h2>
      <div class="account-identity">
        <img
          v-if="auth.currentPlayer?.avatar_url"
          class="account-identity__avatar"
          :src="auth.currentPlayer.avatar_url"
          alt=""
        />
        <span v-else class="account-identity__avatar account-identity__avatar--fallback">{{ accountInitials }}</span>
        <div class="account-identity__info">
          <span class="account-identity__name">{{ auth.currentPlayer?.display_name || auth.user?.email || '—' }}</span>
          <span class="account-identity__email">{{ auth.user?.email || '—' }}</span>
        </div>
      </div>
    </section>

    <section class="card stack stack--sm muted">
      <h2 class="section-title">{{ t('admin.settingsNotifications') }}</h2>
      <p>{{ t('admin.settingsNotificationsPlaceholder') }}</p>
    </section>
  </div>
</template>

<style scoped>
.account-identity {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.account-identity__avatar {
  width: 56px;
  height: 56px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.account-identity__avatar--fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.1rem;
  color: var(--primary);
  background: var(--primary-muted);
}

.account-identity__info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.account-identity__name {
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--text);
}

.account-identity__email {
  font-size: 0.875rem;
  color: var(--muted);
}
</style>
