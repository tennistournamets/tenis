<script setup>
// Results by voice or text: the organizer or a results-only counter says "Petraitis –
// Kazlauskas 6:4 6:3"; AI finds the open match and reads the score; the person checks each
// result and saves it through the same RPCs and correction flow as the score editors.
// Hidden unless the `ai` and `ai.score` switches are on.
import { computed, inject, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'
import AiTextSource from './AiTextSource.vue'
import { callAi } from '../../lib/ai'
import { useAiFeature } from '../../lib/aiFeatures'
import { scoreContextMatches, scoreDraft, scoreMatchList } from '../../lib/aiScore'
import { errorMessage } from '../../lib/errorMessages'
import { saveMatchResult } from '../../lib/saveMatchResult'
import { pointsTarget, scoringFamily } from '../../lib/sportConfig'
import { scoringError, tennisRules } from '../../lib/tennisRules'

const props = defineProps({
  tournament: { type: Object, required: true },
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  groups: { type: Array, default: () => [] },
  canEdit: Boolean,
  busy: Boolean,
})
const emit = defineEmits(['update:busy', 'saved'])
const { t, locale } = useI18n()
const aiScoreOn = useAiFeature('score')
const aiVoiceOn = useAiFeature('voice')
const scheduleView = inject('matchScheduleView', computed(() => ({ byMatch: {}, courtsById: {} })))

// Kept open between visits: at the court the panel is the whole point of the tab.
const OPEN_KEY = 'bracketa:ai-score-open'
const open = ref(readOpen())
function readOpen() {
  try { return localStorage.getItem(OPEN_KEY) === '1' } catch { return false }
}
watch(open, value => {
  try { localStorage.setItem(OPEN_KEY, value ? '1' : '0') } catch { /* storage blocked */ }
})

const text = ref('')
const rows = ref([])
const unmatched = ref([])
const remarks = ref([])
const working = ref(false)
const error = ref('')
const success = ref('')

const family = computed(() => scoringFamily(props.tournament.sport || 'tennis', props.tournament.format))
const visible = computed(() => aiScoreOn() && props.canEdit && props.tournament.status === 'in_progress')
const disabled = computed(() => working.value || props.busy)
const inPreview = computed(() => rows.value.length > 0 || unmatched.value.length > 0)
const ready = computed(() => rows.value.filter(row => row.include && row.draft?.rpc))

function setBusy(value) {
  working.value = value
  emit('update:busy', value)
}

function openList() {
  return scoreMatchList({
    tournament: props.tournament,
    matches: props.matches,
    entriesMap: props.entriesMap,
    liveScoresByMatch: props.liveScoresByMatch,
    scheduleByMatch: scheduleView.value.byMatch || {},
    courtsById: scheduleView.value.courtsById || {},
    groups: props.groups,
  }, t)
}

let rowKey = 0
function makeRow(result, item, candidates = []) {
  const draft = item ? scoreDraft(result, item.match, props.tournament) : null
  return { key: `s${++rowKey}`, result, item, candidates, draft, include: Boolean(draft?.rpc), error: '', saved: false }
}

async function recognize() {
  if (disabled.value) return
  error.value = ''
  success.value = ''
  if (!text.value.trim()) { error.value = t('ai.errors.empty'); return }
  const list = openList()
  if (!list.length) { error.value = t('ai.score.noMatches'); return }
  const byRef = Object.fromEntries(list.map(item => [item.ref, item]))
  setBusy(true)
  try {
    const { result } = await callAi('score', {
      input: text.value,
      context: {
        tournamentId: props.tournament.id,
        locale: locale.value,
        family: family.value,
        setFormat: props.tournament.set_format || 'best_of_3',
        finalSet: tennisRules(props.tournament.scoring_config || {}).final_set_rule,
        target: pointsTarget(props.tournament),
        matches: scoreContextMatches(list),
      },
    })
    rows.value = result.results.map(found => (found.match
      ? makeRow(found, byRef[found.match])
      : makeRow(found, null, found.candidates.map(ref => byRef[ref]).filter(Boolean))))
    unmatched.value = result.unmatched
    remarks.value = result.remarks
    if (!rows.value.length && !unmatched.value.length) error.value = t('ai.score.nothing')
  } catch (err) {
    error.value = errorMessage(err, t, 'ai.errors.unavailable')
  } finally {
    setBusy(false)
  }
}

// One of several matches the result could belong to.
function choose(row, ref) {
  const item = row.candidates.find(candidate => candidate.ref === ref)
  if (!item) return
  Object.assign(row, makeRow(row.result, item), { key: row.key })
}

// The score read the wrong way round: each side takes the other's numbers. When the numbers
// contradicted the winner the text named, that fixes them; otherwise the person overrules the
// whole reading, the named winner included.
function swap(row) {
  const flip = pair => (pair ? { a: pair.b, b: pair.a } : pair)
  const result = { ...row.result }
  if (row.draft?.problem !== 'ai.score.problems.winnerMismatch' && result.winner) result.winner = result.winner === 'a' ? 'b' : 'a'
  if (result.sets) result.sets = result.sets.map(set => ({ ...flip(set), ...(set.tb ? { tb: flip(set.tb) } : {}) }))
  if (result.score) result.score = flip(result.score)
  if (result.pens) result.pens = flip(result.pens)
  Object.assign(row, makeRow(result, row.item), { key: row.key })
}

function sideClass(row, side) {
  return { 'ai-score__side--winner': row.draft?.winner === side }
}

function problemText(row) {
  const problem = row.draft?.problem
  if (!problem) return ''
  return problem.startsWith('ai.') ? t(problem, { target: pointsTarget(props.tournament) }) : scoringError(problem, t)
}

function editText() {
  rows.value = []
  unmatched.value = []
  remarks.value = []
  error.value = ''
}

async function save() {
  if (disabled.value || !ready.value.length) return
  error.value = ''
  success.value = ''
  setBusy(true)
  let saved = 0
  try {
    for (const row of ready.value) {
      row.error = ''
      const { error: saveError, cancelled } = await saveMatchResult(row.draft.rpc, row.draft.payload, t, { matches: props.matches })
      if (cancelled) continue
      if (saveError) { row.error = scoringError(saveError.message, t); continue }
      row.saved = true
      saved++
    }
  } finally {
    setBusy(false)
  }
  rows.value = rows.value.filter(row => !row.saved)
  if (saved) {
    success.value = t('ai.score.saved', { n: saved })
    // The remarks were about the whole text; what is left is checked row by row.
    remarks.value = []
    emit('saved')
  }
  if (!rows.value.length) {
    unmatched.value = []
    remarks.value = []
    text.value = ''
  } else if (rows.value.some(row => row.error)) {
    error.value = t('ai.score.failed', { n: rows.value.filter(row => row.error).length })
  }
}
</script>

<template>
  <section v-if="visible" class="ai-score">
    <div class="admin-add-entry ai-score__box" :class="{ 'admin-add-entry--open': open }">
      <h2 class="admin-add-entry__heading">
        <button
          id="adm-ai-score-trigger"
          type="button"
          class="admin-add-entry__trigger"
          :aria-expanded="open"
          aria-controls="adm-ai-score-panel"
          @click="open = !open"
        >
          <span class="admin-add-entry__trigger-text ai-score__title">
            <AppIcon name="sparkles" :size="18" />
            {{ t('ai.score.title') }}
            <span class="ai-score__chip">AI</span>
          </span>
          <svg class="admin-add-entry__chevron" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </h2>

      <div
        v-show="open"
        id="adm-ai-score-panel"
        class="admin-add-entry__panel stack stack--sm"
        role="region"
        aria-labelledby="adm-ai-score-trigger"
      >
        <template v-if="!inPreview">
          <p class="muted admin-add-entry__hint">{{ t(`ai.score.hint.${family}`) }}</p>
          <AiTextSource
            id="adm-ai-score-text"
            v-model="text"
            :label="t('ai.score.label')"
            :placeholder="t(`ai.score.placeholder.${family}`)"
            :disabled="disabled"
            :rows="3"
            :files="false"
            :voice="aiVoiceOn()"
            :tournament-id="tournament.id"
          />
          <div class="ai-score__actions">
            <button type="button" class="btn btn--primary" :disabled="disabled || !text.trim()" @click="recognize">
              {{ working ? t('ai.score.recognizing') : t('ai.score.recognize') }}
            </button>
          </div>
        </template>

        <template v-else>
          <h3 class="ai-score__subtitle">{{ t('ai.score.previewTitle') }}</h3>
          <ul class="ai-score__list">
            <li v-for="row in rows" :key="row.key" class="ai-score__row" :class="{ 'ai-score__row--problem': row.draft?.problem || row.error }">
              <template v-if="row.item">
                <div class="ai-score__head">
                  <span class="ai-score__heading">{{ row.item.heading }}</span>
                  <label v-if="row.draft?.rpc" class="ai-score__include">
                    <input v-model="row.include" type="checkbox" :disabled="disabled" />
                    {{ t('ai.score.include') }}
                  </label>
                </div>
                <p class="ai-score__sides">
                  <span :class="sideClass(row, 'a')">{{ row.item.a }}</span>
                  <span class="ai-score__dash" aria-hidden="true">—</span>
                  <span :class="sideClass(row, 'b')">{{ row.item.b }}</span>
                </p>
                <div class="ai-score__result">
                  <strong class="ai-score__value">{{ row.draft?.text || '—' }}</strong>
                  <button type="button" class="btn btn--ghost btn--sm" :disabled="disabled" :title="t('ai.score.swapHint')" @click="swap(row)">
                    {{ t('ai.score.swap') }}
                  </button>
                </div>
              </template>
              <template v-else>
                <p class="ai-score__heading">{{ t('ai.score.choose') }}</p>
                <div class="ai-score__candidates">
                  <button
                    v-for="candidate in row.candidates"
                    :key="candidate.ref"
                    type="button"
                    class="btn btn--outline btn--sm ai-score__candidate"
                    :disabled="disabled"
                    @click="choose(row, candidate.ref)"
                  >
                    <span class="ai-score__heading">{{ candidate.heading }}</span>
                    <span>{{ candidate.a }} — {{ candidate.b }}</span>
                  </button>
                </div>
              </template>
              <p v-if="row.result.heard" class="ai-score__heard">«{{ row.result.heard }}»</p>
              <p v-if="problemText(row)" class="ai-score__problem">{{ problemText(row) }}</p>
              <p v-if="row.error" class="ai-score__problem" role="alert">{{ row.error }}</p>
            </li>
          </ul>

          <div v-if="unmatched.length || remarks.length" class="ai-score__notes">
            <template v-if="unmatched.length">
              <p class="ai-score__notes-title">{{ t('ai.score.unmatched') }}</p>
              <ul><li v-for="(line, index) in unmatched" :key="`u${index}`">{{ line }}</li></ul>
            </template>
            <template v-if="remarks.length">
              <p class="ai-score__notes-title">{{ t('ai.import.remarks') }}</p>
              <ul><li v-for="(line, index) in remarks" :key="`r${index}`">{{ line }}</li></ul>
            </template>
          </div>

          <div class="ai-score__actions">
            <button type="button" class="btn btn--primary" :disabled="disabled || !ready.length" @click="save">
              {{ working ? t('ai.score.saving') : t('ai.score.save', { n: ready.length }) }}
            </button>
            <button type="button" class="btn btn--ghost" :disabled="disabled" @click="editText">{{ t('ai.import.editText') }}</button>
          </div>
        </template>

        <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
        <p v-if="success" class="alert alert--success" role="status">{{ success }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.ai-score {
  margin-bottom: var(--space-4, 16px);
}
/* The disclosure is the card itself: same surface and corners as the cards below it. */
.ai-score__box {
  border-radius: var(--radius);
  background: var(--surface);
  box-shadow: var(--shadow-sm);
}
.ai-score__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ai-score__title .app-icon {
  color: var(--primary);
}
.ai-score__chip {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--primary);
  background: var(--primary-soft);
}
.ai-score__subtitle {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}
.ai-score__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 8px);
}
.ai-score__list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2, 8px);
  margin: 0;
  padding: 0;
  list-style: none;
}
.ai-score__row {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 10px);
  background: var(--surface);
}
.ai-score__row--problem {
  border-color: var(--danger);
}
.ai-score__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-score__heading {
  font-size: 0.8125rem;
  color: var(--muted);
}
.ai-score__include {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 32px;
  font-size: 0.875rem;
  cursor: pointer;
}
.ai-score__sides {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 8px;
  margin: 0;
  overflow-wrap: anywhere;
}
.ai-score__side--winner {
  font-weight: 700;
}
.ai-score__dash {
  color: var(--muted);
}
.ai-score__result {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.ai-score__value {
  font-size: 1.25rem;
  font-variant-numeric: tabular-nums;
}
.ai-score__heard {
  margin: 0;
  font-size: 0.8125rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.ai-score__problem {
  margin: 0;
  font-size: 0.875rem;
  color: var(--danger);
}
.ai-score__candidates {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.ai-score__candidate {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  height: auto;
  padding: 8px 12px;
  text-align: left;
  white-space: normal;
}
.ai-score__notes {
  font-size: 0.8125rem;
  color: var(--muted);
}
.ai-score__notes ul {
  margin: 4px 0 8px;
  padding-left: 18px;
  overflow-wrap: anywhere;
}
.ai-score__notes-title {
  margin: 0;
  font-weight: 600;
}
</style>
