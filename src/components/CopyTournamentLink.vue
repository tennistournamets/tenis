<script setup>
import { computed, onUnmounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { copyTournamentLink, tournamentShareUrl } from '../lib/shareLink'
import AppIcon from './AppIcon.vue'
import { track } from '../lib/analytics'

// `compact` renders icon-only buttons with tooltips (tournament header); the label stays for screen readers.
const props = defineProps({
  slug: { type: String, required: true },
  name: { type: String, default: '' },
  compact: { type: Boolean, default: false },
})
const { t } = useI18n()
const status = ref('idle')
const inputId = useId()
const url = computed(() => tournamentShareUrl(props.slug))
const copyLabel = computed(() => (status.value === 'copied' ? t('share.copied') : t('share.copyLink')))
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
    track('share_link_copied')
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
  <div class="copy-link" :class="{ 'copy-link--compact': compact }" @click.stop @keydown.enter.stop @keydown.space.stop>
    <span v-if="canShare" class="tooltip-wrapper" :data-tooltip="compact ? t('share.qrShare') : undefined">
      <button class="btn btn--outline btn--sm" :class="{ 'btn--icon': compact }" type="button" :aria-label="compact ? t('share.qrShare') : undefined" @click="share">
        <AppIcon v-if="compact" name="share" :size="18" />
        <span v-else>{{ t('share.qrShare') }}</span>
      </button>
    </span>
    <span class="tooltip-wrapper" :data-tooltip="compact ? copyLabel : undefined">
      <button class="btn btn--outline btn--sm" :class="{ 'btn--icon': compact, 'btn--copied': compact && status === 'copied' }" type="button" :disabled="status === 'pending'" aria-live="polite" @click="copy">
        <AppIcon v-if="compact" :name="status === 'copied' ? 'check' : 'link'" :size="18" />
        <span :class="{ 'sr-only': compact }">{{ copyLabel }}</span>
      </button>
    </span>
    <div v-if="status === 'failed'" class="copy-link__fallback">
      <p class="error-text" role="alert">{{ t('share.copyFailed') }}</p>
      <label :for="inputId">{{ t('share.manualCopy') }}</label>
      <input :id="inputId" class="input" type="text" readonly :value="url" @focus="$event.target.select()" @click="$event.target.select()" />
    </div>
  </div>
</template>

<style scoped>
.copy-link { min-width: 0; display: flex; flex-wrap: wrap; gap: 8px; }
.copy-link--compact { gap: var(--space-2, 8px); }
.btn--copied { border-color: var(--success-border); color: var(--success-text); }
.copy-link__fallback { width: 100%; max-width: 22rem; margin-top: var(--space-2); text-align: left; }
.copy-link__fallback p { margin: 0 0 var(--space-2); }
.copy-link__fallback label { font-size: 0.8rem; }
</style>
