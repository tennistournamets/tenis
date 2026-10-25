<script setup>
// "Post with AI": three ready texts (Instagram, Facebook, WhatsApp) about the results or a
// finished round. The facts are worked out here (aiPostFacts); the model gets tokens instead
// of names and only writes; the texts come back with names and a tagged link, editable.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import AppIcon from '../AppIcon.vue'
import { callAi } from '../../lib/ai'
import { buildPostFacts, postMoments, restorePost } from '../../lib/aiPostFacts'
import { POST_CHANNELS } from '../../lib/aiSchemas'
import { errorMessage } from '../../lib/errorMessages'
import { tournamentShareUrl } from '../../lib/shareLink'
import { taggedUrl } from '../../lib/shareChannels'
import { track } from '../../lib/analytics'

const props = defineProps({
  tournament: { type: Object, required: true },
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  sets: { type: Array, default: () => [] },
  standings: { type: Array, default: () => [] },
  pointsStandings: { type: Array, default: () => [] },
})
const emit = defineEmits(['close'])
const { t, locale } = useI18n()

const LANGUAGES = ['lt', 'ru', 'en']
const moments = computed(() => postMoments({ tournament: props.tournament, matches: props.matches }, t))
const moment = ref(moments.value[0]?.key ?? null)
const language = ref(LANGUAGES.includes(locale.value) ? locale.value : 'lt')
const note = ref('')
const posts = ref(null)
const unknownNames = ref(false)
const checkNames = ref(false)
const working = ref(false)
const error = ref('')
const copied = ref('')

const url = tournamentShareUrl(props.tournament.slug)
const linkFor = channel => (channel === 'instagram' ? '' : taggedUrl(url, channel, 'ai_post'))

async function generate() {
  if (working.value || !moment.value) return
  error.value = ''
  copied.value = ''
  working.value = true
  try {
    const { facts, names } = buildPostFacts({
      tournament: props.tournament,
      matches: props.matches,
      entriesMap: props.entriesMap,
      sets: props.sets,
      standings: props.standings,
      pointsStandings: props.pointsStandings,
      moment: moment.value,
    }, t)
    const { result } = await callAi('posts', {
      input: note.value,
      context: { tournamentId: props.tournament.id, locale: locale.value, postLanguage: language.value, facts },
    })
    posts.value = Object.fromEntries(POST_CHANNELS.map(channel => [channel, restorePost(result.posts[channel], { names, link: linkFor(channel) })]))
    unknownNames.value = result.unknownNames
    checkNames.value = result.checkNames
    track('ai_post_generated', { moment: moment.value.startsWith('round') ? 'round' : 'results' })
  } catch (err) {
    error.value = errorMessage(err, t, 'ai.errors.unavailable')
  } finally {
    working.value = false
  }
}

async function copy(channel) {
  try {
    await navigator.clipboard.writeText(posts.value[channel])
    copied.value = channel
  } catch {
    // No clipboard access: select the text so the person can copy it by hand.
    copied.value = ''
    error.value = t('ai.posts.copyFailed')
    const field = document.getElementById(`ai-post-${channel}`)
    field?.focus()
    field?.select()
  }
}

const whatsappHref = computed(() => (posts.value?.whatsapp ? `https://wa.me/?text=${encodeURIComponent(posts.value.whatsapp)}` : null))
</script>

<template>
  <AppModal :label="t('ai.posts.title')" @close="emit('close')">
    <div class="modal-dialog ai-post">
      <div class="modal-dialog__head">
        <div>
          <h2 class="ai-post__title"><AppIcon name="sparkles" :size="20" />{{ t('ai.posts.title') }}</h2>
          <p class="muted">{{ t('ai.posts.hint') }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <p v-if="!moments.length" class="alert alert--info" role="status">{{ t('ai.posts.noResults') }}</p>
      <template v-else>
        <fieldset class="ai-post__group">
          <legend class="ai-post__label">{{ t('ai.posts.about') }}</legend>
          <div class="ai-post__chips">
            <label v-for="item in moments" :key="item.key" class="ai-post__chip" :class="{ 'ai-post__chip--on': moment === item.key }">
              <input v-model="moment" class="sr-only" type="radio" name="ai-post-moment" :value="item.key" :disabled="working" />
              {{ item.label }}
            </label>
          </div>
        </fieldset>

        <div class="ai-post__row">
          <label class="form-field ai-post__lang">
            <span class="ai-post__label">{{ t('ai.posts.language') }}</span>
            <select v-model="language" class="input input--sm" :disabled="working">
              <option v-for="code in LANGUAGES" :key="code" :value="code">{{ t(`ai.posts.languages.${code}`) }}</option>
            </select>
          </label>
          <label class="form-field ai-post__note">
            <span class="ai-post__label">{{ t('ai.posts.note') }}</span>
            <input v-model="note" class="input input--sm" type="text" maxlength="300" :placeholder="t('ai.posts.notePlaceholder')" :disabled="working" />
          </label>
        </div>

        <div class="ai-post__actions">
          <button type="button" class="btn btn--primary" :disabled="working || !moment" @click="generate">
            {{ working ? t('ai.posts.writing') : posts ? t('ai.posts.again') : t('ai.posts.write') }}
          </button>
          <span class="ai-post__notice"><AppIcon name="sparkles" :size="14" />{{ t('ai.posts.privacy') }}</span>
        </div>

        <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
        <p v-if="unknownNames" class="alert alert--warning" role="status">{{ t('ai.posts.unknownNames') }}</p>
        <p v-if="checkNames" class="alert alert--warning" role="status">{{ t('ai.posts.checkNames') }}</p>

        <div v-if="posts" class="ai-post__list">
          <section v-for="channel in POST_CHANNELS" :key="channel" class="ai-post__card">
            <div class="ai-post__card-head">
              <h3 class="ai-post__channel">{{ t(`ai.posts.channel.${channel}`) }}</h3>
              <div class="ai-post__card-actions">
                <a
                  v-if="channel === 'whatsapp' && whatsappHref"
                  class="btn btn--ghost btn--sm"
                  :href="whatsappHref"
                  target="_blank"
                  rel="noopener"
                >{{ t('ai.posts.openWhatsapp') }}</a>
                <button type="button" class="btn btn--outline btn--sm" @click="copy(channel)">
                  {{ copied === channel ? t('ai.posts.copied') : t('ai.posts.copy') }}
                </button>
              </div>
            </div>
            <label class="sr-only" :for="`ai-post-${channel}`">{{ t(`ai.posts.channel.${channel}`) }}</label>
            <textarea :id="`ai-post-${channel}`" v-model="posts[channel]" class="input ai-post__text" rows="7"></textarea>
          </section>
          <p class="sr-only" role="status">{{ copied ? t('ai.posts.copied') : '' }}</p>
        </div>
      </template>
    </div>
  </AppModal>
</template>

<style scoped>
.ai-post {
  max-width: 640px;
  text-align: left;
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
}
.ai-post__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ai-post__title .app-icon {
  color: var(--primary);
}
.ai-post__group {
  margin: 0;
  padding: 0;
  border: 0;
  min-width: 0;
}
.ai-post__label {
  display: block;
  margin-bottom: 6px;
  font-size: 0.875rem;
  font-weight: 600;
}
.ai-post__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ai-post__chip {
  display: inline-flex;
  align-items: center;
  min-height: 36px;
  padding: 6px 14px;
  border: 1px solid var(--border-strong, var(--border));
  border-radius: 999px;
  font-size: 0.875rem;
  cursor: pointer;
  transition: background 0.15s ease, border-color 0.15s ease, color 0.15s ease;
}
.ai-post__chip:hover {
  border-color: var(--primary);
}
.ai-post__chip--on {
  color: var(--primary);
  border-color: var(--primary);
  background: var(--primary-soft);
  font-weight: 600;
}
.ai-post__chip:focus-within {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
.ai-post__row {
  display: grid;
  grid-template-columns: minmax(120px, 160px) 1fr;
  gap: var(--space-3, 12px);
}
@media (max-width: 520px) {
  .ai-post__row {
    grid-template-columns: 1fr;
  }
}
.ai-post__lang,
.ai-post__note {
  margin: 0;
  min-width: 0;
}
.ai-post__actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2, 8px) var(--space-3, 12px);
}
.ai-post__notice {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 0.8125rem;
  color: var(--muted);
}
.ai-post__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3, 12px);
}
.ai-post__card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 10px);
  background: var(--surface);
}
.ai-post__card-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-post__channel {
  margin: 0;
  font-size: 0.95rem;
}
.ai-post__card-actions {
  display: flex;
  gap: 6px;
}
.ai-post__text {
  width: 100%;
  resize: vertical;
  font-size: 0.9rem;
  line-height: 1.5;
}
</style>
