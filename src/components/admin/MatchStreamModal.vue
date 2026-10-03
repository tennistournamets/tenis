<script setup>
// Organizers paste the YouTube broadcast link of one match (set_match_stream).
// Opened from the live/score surfaces of every format; the public boards show it
// as a "Watch" link (MatchStreamLink).
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import { matchSideLabel } from '../../lib/entryDisplay'
import { errorMessage } from '../../lib/errorMessages'
import { matchStreamUrl, normalizeStreamUrl } from '../../lib/matchStream'
import { confirmDiscard } from '../../lib/unsavedChanges'
import { supabase } from '../../lib/supabase'

const props = defineProps({
  match: { type: Object, required: true },
  entriesMap: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['close', 'saved'])
const { t } = useI18n()

const stored = matchStreamUrl(props.match)
const input = ref(stored)
const saving = ref(false)
const errorText = ref('')
const inputId = `stream-url-${props.match.id}`

const title = computed(() => `${matchSideLabel(props.match, 'a', props.entriesMap, t('bracket.tbd'))} vs ${matchSideLabel(props.match, 'b', props.entriesMap, t('bracket.tbd'))}`)
const normalized = computed(() => normalizeStreamUrl(input.value))
const dirty = computed(() => (normalized.value ?? input.value.trim()) !== stored)
watch(input, () => { if (!saving.value) errorText.value = '' })

async function close() {
  if (!(await confirmDiscard(t, dirty.value, saving.value))) return
  emit('close')
}

async function submit(url) {
  if (saving.value) return
  if (url === null) { errorText.value = t('stream.errors.invalidUrl'); return }
  saving.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('set_match_stream', { p_match_id: props.match.id, p_url: url })
    if (error) { errorText.value = errorMessage(error, t); return }
    emit('saved')
    emit('close')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal :label="t('stream.title')" @close="close">
    <form class="modal-dialog stream-modal" novalidate @submit.prevent="submit(normalized)">
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('stream.title') }}</h2>
          <p class="muted stream-modal__match">{{ title }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="close">×</button>
      </div>

      <div class="form-field">
        <label :for="inputId">{{ t('stream.label') }}</label>
        <input
          :id="inputId"
          v-model="input"
          class="input"
          type="url"
          inputmode="url"
          autocomplete="off"
          spellcheck="false"
          :placeholder="t('stream.placeholder')"
          :disabled="saving"
          :aria-invalid="Boolean(errorText)"
          :aria-describedby="`${inputId}-hint`"
        />
        <p :id="`${inputId}-hint`" class="muted stream-modal__hint">{{ t('stream.hint') }}</p>
      </div>

      <a v-if="normalized" class="stream-modal__check" :href="normalized" target="_blank" rel="noopener noreferrer">
        {{ t('stream.open') }} <span aria-hidden="true">↗</span>
      </a>

      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>

      <footer class="stream-modal__actions">
        <button v-if="stored" class="btn btn--ghost" type="button" :disabled="saving" @click="submit('')">{{ t('stream.remove') }}</button>
        <button class="btn btn--primary" type="submit" :disabled="saving || !dirty || !input.trim()">{{ t('stream.save') }}</button>
      </footer>
    </form>
  </AppModal>
</template>

<style scoped>
.stream-modal { gap: var(--space-3); }
.stream-modal__match { overflow-wrap: anywhere; }
.stream-modal__hint { margin: 6px 0 0; font-size: var(--font-sm); line-height: 1.45; }
.stream-modal__check { justify-self: start; font-size: 0.875rem; font-weight: 600; overflow-wrap: anywhere; }
.stream-modal__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
</style>
