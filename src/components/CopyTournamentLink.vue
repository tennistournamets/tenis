<script setup>
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { copyTournamentLink, tournamentShareUrl } from '../lib/shareLink'

const props = defineProps({ slug: { type: String, required: true }, name: { type: String, default: '' } })
const { t } = useI18n()
const status = ref('idle')
const inputId = useId()
const url = computed(() => tournamentShareUrl(props.slug))
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
let timer
let request = 0
function reset() {
  request += 1
  clearTimeout(timer)
  status.value = 'idle'
}
watch(() => props.slug, reset)
onUnmounted(reset)

async function copy() {
  if (status.value === 'pending') return
  reset()
  const current = request
  status.value = 'pending'
  try {
    await copyTournamentLink(props.slug)
    if (current !== request) return
    status.value = 'copied'
    timer = setTimeout(() => { status.value = 'idle' }, 2000)
  } catch {
    if (current === request) status.value = 'failed'
  }
}

async function share() {
  if (!canShare || status.value === 'pending') return
  try {
    await navigator.share({ title: props.name || undefined, url: url.value })
  } catch (error) {
    if (error?.name !== 'AbortError') await copy()
  }
}
</script>

<template>
  <div class="copy-link" @click.stop @keydown.enter.stop @keydown.space.stop>
    <button v-if="canShare" class="btn btn--outline btn--sm" type="button" @click="share">
      {{ t('share.qrShare') }}
    </button>
    <button class="btn btn--outline btn--sm" type="button" :disabled="status === 'pending'" aria-live="polite" @click="copy">
      {{ status === 'copied' ? t('share.copied') : t('share.copyLink') }}
    </button>
    <div v-if="status === 'failed'" class="copy-link__fallback">
      <p class="error-text" role="alert">{{ t('share.copyFailed') }}</p>
      <label :for="inputId">{{ t('share.manualCopy') }}</label>
      <input :id="inputId" class="input" type="text" readonly :value="url" @focus="$event.target.select()" @click="$event.target.select()" />
    </div>
  </div>
</template>

<style scoped>
.copy-link { min-width: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.copy-link__fallback { width: 100%; max-width: 22rem; margin-top: var(--space-2); text-align: left; }
.copy-link__fallback p { margin: 0 0 var(--space-2); }
.copy-link__fallback label { font-size: 0.8rem; }
</style>
