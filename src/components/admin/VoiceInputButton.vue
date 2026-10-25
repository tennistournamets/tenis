<script setup>
// Microphone inside an AI text field: tap to record, tap again to stop; the transcript is
// emitted as text. Sits in the field's bottom-right corner (see AiTextSource). The speech
// language (LT/RU/EN) is picked next to it: Whisper takes Lithuanian for Russian on its own.
import { computed, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { errorMessage } from '../../lib/errorMessages'
import { VOICE_LANGUAGES, VOICE_MAX_SECONDS, canRecord, saveVoiceLanguage, savedVoiceLanguage, startRecording, transcribeAudio } from '../../lib/voice'

const props = defineProps({
  disabled: Boolean,
  tournamentId: { type: String, default: null },
})
const emit = defineEmits(['text', 'busy', 'error'])
const { t, locale } = useI18n()
const language = ref(savedVoiceLanguage(locale.value))
function pickLanguage(value) {
  language.value = value
  saveVoiceLanguage(value)
}

const state = ref('idle') // idle | recording | transcribing
const seconds = ref(0)
const supported = canRecord()
let recording = null
let ticker = null

const clock = computed(() => `${Math.floor(seconds.value / 60)}:${String(seconds.value % 60).padStart(2, '0')}`)
const label = computed(() => (state.value === 'recording' ? t('ai.voice.stop')
  : state.value === 'transcribing' ? t('ai.voice.transcribing') : t('ai.voice.start')))

function setState(next) {
  state.value = next
  emit('busy', next !== 'idle')
}

async function toggle() {
  if (state.value === 'recording') { recording?.stop(); return }
  if (props.disabled || state.value !== 'idle') return
  emit('error', '')
  try {
    recording = await startRecording()
  } catch (err) {
    emit('error', errorMessage(err, t, 'ai.errors.mic'))
    return
  }
  seconds.value = 0
  ticker = setInterval(() => { seconds.value = Math.min(VOICE_MAX_SECONDS, seconds.value + 1) }, 1000)
  setState('recording')
  // The time limit stops the recording on its own; the same path then transcribes it.
  recording.done.then(audio => finish(audio))
}

async function finish(audio) {
  clearInterval(ticker)
  recording = null
  if (!audio) { setState('idle'); return }
  setState('transcribing')
  try {
    emit('text', await transcribeAudio(audio, { language: language.value, tournamentId: props.tournamentId }))
  } catch (err) {
    emit('error', errorMessage(err, t, 'ai.errors.unavailable'))
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
  <div v-if="supported" class="mic" :class="`mic--${state}`">
    <span v-if="state === 'recording'" class="mic__timer" aria-hidden="true">
      <span class="mic__dot"></span>{{ clock }}
    </span>
    <label v-else class="mic__lang" :title="t('ai.voice.language')">
      <span class="sr-only">{{ t('ai.voice.language') }}</span>
      <select :value="language" :disabled="state !== 'idle'" @change="pickLanguage($event.target.value)">
        <option v-for="code in VOICE_LANGUAGES" :key="code" :value="code">{{ code.toUpperCase() }}</option>
      </select>
    </label>
    <button
      type="button"
      class="mic__button"
      :aria-label="label"
      :title="label"
      :aria-pressed="state === 'recording'"
      :aria-busy="state === 'transcribing'"
      :disabled="(disabled && state === 'idle') || state === 'transcribing'"
      @click="toggle"
    >
      <!-- Microphone / stop square / spinner -->
      <svg v-if="state === 'idle'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="9" y="3" width="6" height="12" rx="3" /><path d="M5 11a7 7 0 0 0 14 0" /><path d="M12 18v3" />
      </svg>
      <svg v-else-if="state === 'recording'" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="5" y="5" width="14" height="14" rx="3" fill="currentColor" />
      </svg>
      <svg v-else class="mic__spinner" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-6.2-8.56" />
      </svg>
    </button>
    <span class="sr-only" role="status">{{ state === 'recording' ? t('ai.voice.recording') : state === 'transcribing' ? t('ai.voice.transcribing') : '' }}</span>
  </div>
</template>

<style scoped>
.mic {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.mic__button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border-radius: 50%;
  border: 1px solid var(--border-strong, var(--border));
  background: var(--surface);
  color: var(--text);
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}
.mic__button:hover:not(:disabled) {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-soft);
}
.mic__button:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.mic__button:disabled {
  cursor: default;
  opacity: 0.55;
}
.mic--recording .mic__button {
  color: #fff;
  border-color: var(--danger);
  background: var(--danger);
  animation: mic-pulse 1.4s ease-out infinite;
}
.mic--transcribing .mic__button:disabled {
  opacity: 1;
  color: var(--primary);
}
.mic__timer {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 0.8125rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--danger);
  background: var(--danger-bg);
}
.mic__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: currentColor;
  animation: mic-blink 1s ease-in-out infinite;
}
.mic__spinner {
  animation: mic-spin 0.8s linear infinite;
}
/* Speech language: a small pill; the native select keeps keyboard and screen readers working. */
.mic__lang select {
  appearance: none;
  height: 28px;
  padding: 0 22px 0 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  font: inherit;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--muted);
  background: var(--surface) url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E") no-repeat right 8px center;
  cursor: pointer;
}
.mic__lang select:hover:not(:disabled) {
  color: var(--text);
  border-color: var(--border-strong, var(--border));
}
.mic__lang select:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
@keyframes mic-pulse {
  0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--danger) 45%, transparent); }
  100% { box-shadow: 0 0 0 12px color-mix(in srgb, var(--danger) 0%, transparent); }
}
@keyframes mic-blink {
  50% { opacity: 0.3; }
}
@keyframes mic-spin {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .mic--recording .mic__button,
  .mic__dot,
  .mic__spinner { animation: none; }
}
</style>
