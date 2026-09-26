<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { supabase } from '../lib/supabase'
import { accessError, browserClientId } from '../lib/access'

const props = defineProps({
  slug: { type: String, required: true },
})
const emit = defineEmits(['unlocked'])
const { t } = useI18n()
const password = ref('')
const loading = ref(false)
const errorText = ref('')

async function submit() {
  if (loading.value || !password.value) return
  loading.value = true
  errorText.value = ''
  try {
    const { data, error } = await supabase.rpc('unlock_tournament', {
      p_slug: props.slug, p_password: password.value, p_client_id: browserClientId(),
    })
    if (error) throw error
    // Failures come back as data so the server can keep counting attempts.
    if (!data?.ok) {
      errorText.value = accessError(data?.error || 'access.wrongPassword', t)
      return
    }
    password.value = ''
    emit('unlocked', { tournament_id: data.tournament_id, token: data.token, expires_at: data.expires_at })
  } catch (error) {
    errorText.value = accessError(error?.message, t)
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <form class="card card--elevated stack stack--sm unlock" @submit.prevent="submit">
    <div>
      <h2 class="section-title" style="margin: 0">{{ t('access.unlock.title') }}</h2>
      <p class="muted" style="margin: 6px 0 0">{{ t('access.unlock.hint') }}</p>
    </div>
    <div class="form-field">
      <label for="unlock-password">{{ t('access.unlock.label') }}</label>
      <input id="unlock-password" v-model="password" class="input" type="password" autocomplete="current-password" :disabled="loading" required />
    </div>
    <button class="btn btn--primary" type="submit" :disabled="loading || !password">
      <span v-if="loading" class="spinner" aria-hidden="true" />
      {{ t('access.unlock.button') }}
    </button>
    <p v-if="errorText" class="alert alert--error" role="alert" style="margin: 0">{{ errorText }}</p>
  </form>
</template>

<style scoped>
.unlock { max-width: 480px; margin: 0 auto; }
</style>
