<script setup>
// "Dictate" next to an AI text field: record, stop, and the transcript is emitted as text.
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'
import { errorMessage } from '../../lib/errorMessages'
import { VOICE_MAX_SECONDS, canRecord, startRecording, transcribeAudio } from '../../lib/voice'

const props = defineProps({
  disabled: Boolean,
  tournamentId: { type: String, default: null },
})
const emit = defineEmits(['text', 'busy'])
const { t, locale } = useI18n()

const state = ref('idle') // idle | recording | transcribing
const seconds = ref(0)
const error = ref('')
const supported = canRecord()
let recording = null
let ticker = null

const clock = computed(() => {
  const left = Math.max(0, VOICE_MAX_SECONDS - seconds.value)
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`
})

function setState(next) {
  state.value = next
  emit('busy', next !== 'idle')
}

async function start() {
  if (props.disabled || state.value !== 'idle') return
  error.value = ''
  try {
    recording = await startRecording()
  } catch (err) {
    error.value = errorMessage(err, t, 'ai.errors.mic')
    return
  }
  seconds.value = 0
  ticker = setInterval(() => { seconds.value += 1 }, 1000)
  setState('recording')
  // The time limit stops the recording on its own; the same path then transcribes it.
  recording.done.then(audio => finish(audio))
}

function stop() {
  recording?.stop()
}

async function finish(audio) {
  clearInterval(ticker)
  recording = null
  if (!audio) { setState('idle'); return }
  setState('transcribing')
  try {
    const text = await transcribeAudio(audio, { locale: locale.value, tournamentId: props.tournamentId })
    emit('text', text)
  } catch (err) {
    error.value = errorMessage(err, t, 'ai.errors.unavailable')
  } finally {
    setState('idle')
  }
}

onBeforeUnmount(() => {
  clearInterval(ticker)
  recording?.cancel()
})
</script>

<template>
  <span v-if="supported" class="voice-input">
    <button
      v-if="state !== 'recording'"
      type="button"
      class="btn btn--outline btn--sm voice-input__button"
      :disabled="disabled || state === 'transcribing'"
      @click="start"
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />
      </svg>
      {{ state === 'transcribing' ? t('ai.voice.transcribing') : t('ai.voice.start') }}
    </button>
    <button v-else type="button" class="btn btn--danger btn--sm voice-input__button" @click="stop">
      <span class="voice-input__dot" aria-hidden="true"></span>
      {{ t('ai.voice.stop', { time: clock }) }}
    </button>
    <span v-if="state === 'recording'" class="sr-only" role="status">{{ t('ai.voice.recording') }}</span>
    <span v-if="error" class="voice-input__error" role="alert">{{ error }}</span>
  </span>
</template>

<style scoped>
.voice-input {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.voice-input__button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-variant-numeric: tabular-nums;
}
.voice-input__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
  animation: voice-pulse 1s ease-in-out infinite;
}
.voice-input__error {
  font-size: 0.8125rem;
  color: var(--danger);
}
@keyframes voice-pulse {
  50% { opacity: 0.3; }
}
@media (prefers-reduced-motion: reduce) {
  .voice-input__dot { animation: none; }
}
</style>
