<script setup>
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { useUnsavedChanges } from '../lib/unsavedChanges'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const auth = useAuthStore()
const displayName = ref('')
const savedDisplayName = ref('')
const profileLoading = ref(true)
const profileSaving = ref(false)
const profileError = ref('')
const profileSuccess = ref('')

const profileDirty = computed(() => displayName.value !== savedDisplayName.value)
const canSaveProfile = computed(() => (
  !profileLoading.value
  && !profileSaving.value
  && Boolean(displayName.value.trim())
  && profileDirty.value
))

function preferredDisplayName() {
  return auth.currentPlayer?.display_name
    || auth.user?.user_metadata?.full_name
    || auth.user?.email
    || ''
}

const accountName = computed(preferredDisplayName)
const accountAvatar = computed(() => (
  auth.currentPlayer?.avatar_url
  || auth.user?.user_metadata?.avatar_url
  || auth.user?.user_metadata?.picture
  || ''
))

function acceptProfileName(name = preferredDisplayName()) {
  displayName.value = name
  savedDisplayName.value = name
}

function discardProfileDraft() {
  displayName.value = savedDisplayName.value
  profileError.value = ''
  profileSuccess.value = ''
}

useUnsavedChanges(
  () => profileDirty.value,
  () => profileSaving.value,
  discardProfileDraft,
)

const accountInitials = computed(() => {
  const src = accountName.value || '?'
  return src
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
})

onMounted(async () => {
  acceptProfileName()
  try {
    await auth.init()
    await auth.loadPlayerContext()
    acceptProfileName()
  } catch {
    profileError.value = t('sync.loadFailed')
  } finally {
    profileLoading.value = false
  }
})

function clearProfileFeedback() {
  if (!profileLoading.value && !profileSaving.value) {
    profileError.value = ''
    profileSuccess.value = ''
  }
}

async function saveProfile() {
  if (!canSaveProfile.value) return

  const submittedName = displayName.value.trim().replace(/\s+/g, ' ')
  profileSaving.value = true
  profileError.value = ''
  profileSuccess.value = ''
  try {
    const profile = await auth.savePlayerProfile(submittedName)
    const acceptedName = profile?.display_name || submittedName
    displayName.value = acceptedName
    savedDisplayName.value = acceptedName
    profileSuccess.value = t('admin.settingsProfileSaved')
  } catch {
    profileError.value = t('admin.settingsProfileError')
  } finally {
    profileSaving.value = false
  }
}
</script>

<template>
  <div class="stack" style="max-width: 720px">
    <h1 class="page-title">{{ t('admin.settingsTitle') }}</h1>

    <section class="card stack stack--sm">
      <h2 class="section-title">{{ t('admin.settingsAccount') }}</h2>
      <div class="account-identity">
        <img
          v-if="accountAvatar"
          class="account-identity__avatar"
          :src="accountAvatar"
          alt=""
        />
        <span v-else class="account-identity__avatar account-identity__avatar--fallback">{{ accountInitials }}</span>
        <div class="account-identity__info">
          <span class="account-identity__name">{{ accountName || '—' }}</span>
          <span class="account-identity__email">{{ auth.user?.email || '—' }}</span>
        </div>
      </div>

      <form class="settings-profile-form stack stack--sm" @submit.prevent="saveProfile">
        <div class="form-field">
          <label for="settings-profile-name">{{ t('admin.settingsProfileName') }}</label>
          <input
            id="settings-profile-name"
            v-model="displayName"
            class="input"
            type="text"
            autocomplete="name"
            required
            aria-describedby="settings-profile-name-hint"
            :disabled="profileLoading || profileSaving"
            @input="clearProfileFeedback"
          />
          <p id="settings-profile-name-hint" class="settings-profile-form__hint muted">
            {{ t('admin.settingsProfileNameHint') }}
          </p>
        </div>
        <div class="inline-actions">
          <button
            class="btn btn--primary"
            type="submit"
            :disabled="!canSaveProfile"
            :aria-busy="profileSaving"
          >
            {{ t('admin.settingsProfileSave') }}
          </button>
          <span v-if="profileDirty && !profileSaving" class="muted" role="status">{{ t('drafts.unsaved') }}</span>
        </div>
        <p v-if="profileSuccess" class="success-text" role="status">{{ profileSuccess }}</p>
        <p v-if="profileError" class="error-text" role="alert">{{ profileError }}</p>
      </form>
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
  overflow-wrap: anywhere;
  font-family: var(--font-display);
  font-weight: 700;
  font-size: 1.05rem;
  color: var(--text);
}

.account-identity__email {
  overflow-wrap: anywhere;
  font-size: 0.875rem;
  color: var(--muted);
}

.settings-profile-form {
  padding-top: var(--space-3);
  border-top: 1px solid var(--border);
}

.settings-profile-form__hint {
  margin: 0;
  font-size: 0.8125rem;
}
</style>
