<script setup>
// Text for an AI task: typed or pasted, or read from an attached file (TXT/CSV/XLSX/DOCX/PDF).
// Only the text leaves the browser.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'
import VoiceInputButton from './VoiceInputButton.vue'
import { FILE_ACCEPT, TEXT_MAX, fileToText } from '../../lib/aiFileText'

const props = defineProps({
  modelValue: { type: String, default: '' },
  id: { type: String, required: true },
  label: { type: String, required: true },
  placeholder: { type: String, default: '' },
  disabled: Boolean,
  rows: { type: Number, default: 8 },
  // Show "Dictate" (the `ai.voice` switch is on); the recording counts for this tournament.
  voice: Boolean,
  tournamentId: { type: String, default: null },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const fileInput = ref(null)
const reading = ref(false)
// Picture recognition progress, 0–100 (null for documents, which read at once).
const progress = ref(null)
const fileNote = ref('')
const fileError = ref('')
const clipped = computed(() => props.modelValue.length > TEXT_MAX)
const dictating = ref(false)

function addText(text) {
  const current = props.modelValue.trim()
  emit('update:modelValue', current ? `${current}\n${text}` : text)
}

function pickFile() {
  fileInput.value?.click()
}

async function onFile(event) {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file) return
  fileError.value = ''
  fileNote.value = ''
  reading.value = true
  progress.value = null
  try {
    const text = await fileToText(file, { onProgress: percent => { progress.value = percent } })
    const current = props.modelValue.trim()
    emit('update:modelValue', current ? `${current}\n\n${text}` : text)
    fileNote.value = t('ai.source.fileAdded', { name: file.name })
  } catch (error) {
    fileError.value = t(`ai.file.errors.${error?.code ?? 'unreadable'}`)
  } finally {
    reading.value = false
    progress.value = null
  }
}
</script>

<template>
  <div class="ai-source stack stack--sm">
    <div class="form-field">
      <label :for="id">{{ label }}</label>
      <textarea
        :id="id"
        class="input ai-source__text"
        :rows="rows"
        :value="modelValue"
        :placeholder="placeholder"
        :disabled="disabled || reading || dictating"
        spellcheck="false"
        @input="emit('update:modelValue', $event.target.value)"
      ></textarea>
    </div>
    <div class="ai-source__bar">
      <button type="button" class="btn btn--outline btn--sm" :disabled="disabled || reading || dictating" @click="pickFile">
        <AppIcon name="attach" :size="16" />
        {{ !reading ? t('ai.source.attach') : progress == null ? t('ai.source.reading') : t('ai.source.readingImage', { percent: progress }) }}
      </button>
      <VoiceInputButton
        v-if="voice"
        :disabled="disabled || reading"
        :tournament-id="tournamentId"
        @busy="dictating = $event"
        @text="addText"
      />
      <span class="ai-source__formats">{{ t('ai.source.formats') }}</span>
      <input ref="fileInput" type="file" hidden :accept="FILE_ACCEPT" @change="onFile" />
    </div>
    <p v-if="fileError" class="alert alert--error" role="alert">{{ fileError }}</p>
    <p v-else-if="fileNote" class="ai-source__note" role="status">{{ fileNote }}</p>
    <p v-if="clipped" class="alert alert--warning" role="status">{{ t('ai.source.clipped', { max: TEXT_MAX.toLocaleString() }) }}</p>
    <p class="ai-source__notice">
      <AppIcon name="sparkles" :size="14" />
      {{ t('ai.notice') }}
    </p>
  </div>
</template>

<style scoped>
.ai-source__text {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.875rem;
  line-height: 1.5;
  min-height: 9rem;
  resize: vertical;
}
.ai-source__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2, 8px) var(--space-3, 12px);
}
.ai-source__bar .btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.ai-source__formats,
.ai-source__note,
.ai-source__notice {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted);
}
.ai-source__notice {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
