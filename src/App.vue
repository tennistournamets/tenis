<script setup>
import { computed, nextTick, onMounted, ref, useId, watch, watchEffect } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'

import ConfirmDialog from './components/ConfirmDialog.vue'
import LanguageSwitcher from './components/LanguageSwitcher.vue'
import ThemeToggle from './components/ThemeToggle.vue'
import { confirmLeaveForms, withApprovedDeparture } from './lib/unsavedChanges'
import { headerTitle } from './lib/headerTitle'
import { useOnlineStatus } from './lib/useOnlineStatus'
import { useAuthStore } from './stores/auth'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const { t, locale } = useI18n()
const isOnline = useOnlineStatus()

const profileOpen = ref(false)
const profileRoot = ref(null)
const profileTrigger = ref(null)
const profileId = useId()
const mainContent = ref(null)

watchEffect(() => {
  document.documentElement.lang = ['ru', 'en', 'lt'].includes(locale.value) ? locale.value : 'ru'
  const pages = {
    'admin-tournaments': 'admin.tournamentsListTitle',
    'admin-tournament-new': 'admin.createTournament',
    'admin-settings': 'admin.settingsTitle',
    'admin-tournament': 'a11y.manageTournament',
    'public-tournament': 'a11y.tournamentPage',
  }
  const namedTournament = ['admin-tournament', 'public-tournament'].includes(route.name) && headerTitle.value
  const title = namedTournament || (pages[route.name] ? t(pages[route.name]) : '')
  document.title = title ? `${title} — ${t('app.title')}` : t('app.title')
})
watch(() => route.fullPath, () => closeProfile())

async function loadAccountContext() {
  await Promise.allSettled([
    auth.loadTournamentRoles(),
    auth.loadPlayerContext(),
  ])
}

onMounted(async () => {
  try {
    await auth.init()
  } catch {
    // Route-level loading surfaces the actionable authentication error.
  }
})

watch(
  [() => auth.ready, () => auth.user?.id],
  ([ready]) => { if (ready) void loadAccountContext() },
  { immediate: true },
)

const layout = computed(() => {
  if (route.name === 'home') {
    return 'login'
  }
  if (route.path.startsWith('/admin')) {
    return 'admin'
  }
  if (route.name === 'public-tournament') {
    return 'public'
  }
  return 'default'
})

const profileName = computed(() => (
  auth.currentPlayer?.display_name
  || auth.user?.user_metadata?.full_name
  || auth.user?.email
  || ''
))

const userInitial = computed(() => profileName.value.charAt(0).toUpperCase())

const profileAvatar = computed(() => (
  auth.currentPlayer?.avatar_url
  || auth.user?.user_metadata?.avatar_url
  || auth.user?.user_metadata?.picture
  || ''
))

async function toggleProfile() {
  profileOpen.value = !profileOpen.value
  if (profileOpen.value) {
    await nextTick()
    profileRoot.value?.querySelector('.profile-menu__item')?.focus()
  }
}

function closeProfile(restoreFocus = false) {
  if (!profileOpen.value) return
  profileOpen.value = false
  if (restoreFocus) profileTrigger.value?.focus()
}

function profileFocusOut(event) {
  if (!profileRoot.value?.contains(event.relatedTarget)) closeProfile()
}

async function handleSignOut() {
  profileOpen.value = false
  if (!(await confirmLeaveForms(t))) return
  await withApprovedDeparture(async () => {
    await auth.signOut()
    await router.push({ name: 'home' })
  })
}

function goToSettings() {
  profileOpen.value = false
  router.push({ name: 'admin-settings' })
}
</script>

<template>
  <div class="app-root" @click="closeProfile()">
    <a class="skip-link" href="#main-content" @click.prevent="mainContent?.focus()">{{ t('a11y.skipContent') }}</a>
    <header v-if="layout === 'admin'" class="app-header">
      <RouterLink class="app-header__brand" :to="{ name: 'admin-tournaments' }">
        <svg class="app-header__logo" width="24" height="24" viewBox="0 0 28 28" fill="none" aria-hidden="true">
          <rect width="28" height="28" rx="8" fill="var(--primary)" />
          <path d="M11 8H9.5A1.5 1.5 0 0 0 8 9.5v9A1.5 1.5 0 0 0 9.5 20H11" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" />
          <path d="M17 8h1.5A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5H17" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" />
          <circle cx="14" cy="14" r="2.2" fill="var(--lime)" />
        </svg>
        {{ t('app.title') }}
      </RouterLink>
      <div class="app-header__actions">
        <ThemeToggle />
        <LanguageSwitcher />
        <div v-if="auth.user" ref="profileRoot" class="profile-menu" @click.stop @focusout="profileFocusOut" @keydown.esc.stop.prevent="closeProfile(true)">
          <button
            ref="profileTrigger"
            class="profile-menu__trigger"
            type="button"
            :aria-expanded="profileOpen"
            :aria-label="t('a11y.profileMenu')"
            :aria-controls="profileOpen ? profileId : undefined"
            @click="toggleProfile"
          >
            <img v-if="profileAvatar" class="profile-menu__avatar profile-menu__avatar--image" :src="profileAvatar" alt="" />
            <span v-else class="profile-menu__avatar">{{ userInitial }}</span>
          </button>
          <div v-if="profileOpen" :id="profileId" class="profile-menu__dropdown" role="group" :aria-label="t('a11y.profileMenu')">
            <div class="profile-menu__info">
              <span class="profile-menu__name">{{ profileName }}</span>
              <span class="profile-menu__email">{{ auth.user.email }}</span>
            </div>
            <div class="profile-menu__divider" />
            <button class="profile-menu__item" type="button" @click="goToSettings">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M13.3 10a1.1 1.1 0 0 0 .2 1.2l.04.04a1.33 1.33 0 1 1-1.89 1.89l-.04-.04a1.1 1.1 0 0 0-1.2-.2 1.1 1.1 0 0 0-.67 1.01v.11a1.33 1.33 0 1 1-2.67 0v-.06A1.1 1.1 0 0 0 6 12.8a1.1 1.1 0 0 0-1.2.2l-.04.04a1.33 1.33 0 1 1-1.89-1.89l.04-.04a1.1 1.1 0 0 0 .2-1.2 1.1 1.1 0 0 0-1.01-.67h-.11a1.33 1.33 0 0 1 0-2.67H2.06A1.1 1.1 0 0 0 3.2 6a1.1 1.1 0 0 0-.2-1.2l-.04-.04a1.33 1.33 0 1 1 1.89-1.89l.04.04a1.1 1.1 0 0 0 1.2.2h.05a1.1 1.1 0 0 0 .67-1.01v-.11a1.33 1.33 0 1 1 2.67 0V2.06A1.1 1.1 0 0 0 10 3.2a1.1 1.1 0 0 0 1.2-.2l.04-.04a1.33 1.33 0 1 1 1.89 1.89l-.04.04a1.1 1.1 0 0 0-.2 1.2v.05a1.1 1.1 0 0 0 1.01.67h.11a1.33 1.33 0 0 1 0 2.67h-.06a1.1 1.1 0 0 0-1.01.67Z"/></svg>
              {{ t('admin.settingsTitle') }}
            </button>
            <button class="profile-menu__item profile-menu__item--danger" type="button" @click="handleSignOut">
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 14H3.33A1.33 1.33 0 0 1 2 12.67V3.33A1.33 1.33 0 0 1 3.33 2H6"/><polyline points="10.67 11.33 14 8 10.67 4.67"/><line x1="14" y1="8" x2="6" y2="8"/></svg>
              {{ t('auth.logout') }}
            </button>
          </div>
        </div>
      </div>
    </header>

    <header v-else-if="layout === 'public'" class="app-header">
      <span class="app-header__brand">{{ t('app.title') }}</span>
      <div class="app-header__actions">
        <ThemeToggle />
        <LanguageSwitcher />
      </div>
    </header>

    <div
      v-if="!isOnline"
      class="app-offline-banner alert alert--error"
      :class="{ 'app-offline-banner--login': layout === 'login' }"
      role="status"
    >
      {{ t('sync.offline') }}
    </div>

    <main
      id="main-content"
      ref="mainContent"
      tabindex="-1"
      class="app-main"
      :class="{
        'app-main--wide': layout === 'admin' || layout === 'public',
        'app-main--flush': layout === 'login',
      }"
    >
      <RouterView />
    </main>
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.profile-menu__avatar--image {
  width: 100%;
  height: 100%;
  border-radius: inherit;
  object-fit: cover;
}

.app-offline-banner {
  width: auto;
  max-width: 1400px;
  margin: var(--space-3) calc(var(--space-4) + var(--safe-area-right)) 0 calc(var(--space-4) + var(--safe-area-left));
}

.app-offline-banner--login {
  margin-top: calc(64px + var(--space-3));
}
</style>
