<script setup>
// "Describe the tournament" on the first step of the create wizard: text, a file, a picture or
// dictation -> the `create` AI task -> the wizard fields and, if the text had one, the
// participant list. Hidden unless the `ai` and `ai.create` switches are on.
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'
import AiTextSource from './AiTextSource.vue'
import { callAi } from '../../lib/ai'
import { useAiFeature } from '../../lib/aiFeatures'
import { errorMessage } from '../../lib/errorMessages'

const props = defineProps({
  disabled: Boolean,
  // The sport chosen in the wizard and the sports it offers.
  sport: { type: String, default: 'tennis' },
  enabledSports: { type: Array, default: () => [] },
})
const emit = defineEmits(['apply'])
const { t, locale } = useI18n()
const aiVoiceOn = useAiFeature('voice')

const text = ref('')
const working = ref(false)
const error = ref('')

function localToday() {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

async function fill() {
  if (props.disabled || working.value) return
  error.value = ''
  if (!text.value.trim()) { error.value = t('ai.errors.empty'); return }
  working.value = true
  try {
    const { result } = await callAi('create', {
      input: text.value,
      context: {
        enabledSports: props.enabledSports,
        sport: props.sport,
        today: localToday(),
        weekday: new Intl.DateTimeFormat('en', { weekday: 'long' }).format(new Date()),
        locale: locale.value,
      },
    })
    if (!Object.keys(result.fields).length && !result.participants.entries.length) {
      error.value = t('ai.create.nothing')
      return
    }
    emit('apply', result)
  } catch (err) {
    error.value = errorMessage(err, t, 'ai.errors.unavailable')
  } finally {
    working.value = false
  }
}
</script>

<template>
  <section class="ai-create" aria-labelledby="ai-create-title">
    <h2 id="ai-create-title" class="ai-create__title">
      <AppIcon name="sparkles" :size="18" />
      {{ t('ai.create.title') }}
      <span class="ai-create__chip">AI</span>
    </h2>
    <p class="ai-create__hint">{{ t('ai.create.hint') }}</p>
    <AiTextSource
      id="ai-create-text"
      v-model="text"
      :label="t('ai.create.label')"
      :placeholder="t('ai.create.placeholder')"
      :rows="5"
      :disabled="disabled || working"
      :voice="aiVoiceOn()"
    />
    <div class="ai-create__actions">
      <button type="button" class="btn btn--primary" :disabled="disabled || working || !text.trim()" @click="fill">
        {{ working ? t('ai.create.filling') : t('ai.create.fill') }}
      </button>
    </div>
    <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
  </section>
</template>

<style scoped>
.ai-create {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
  padding: var(--space-4, 16px);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 10px);
  background: var(--surface-row);
}
.ai-create__title {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
}
.ai-create__title .app-icon {
  color: var(--primary);
}
.ai-create__chip {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--primary);
  background: var(--primary-soft);
}
.ai-create__hint {
  margin: 0;
  font-size: 0.875rem;
  color: var(--muted);
  max-width: 72ch;
}
.ai-create__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 8px);
}
</style>
