<script setup>
// AI participant import: text or file -> AI reads it -> the organizer checks the preview ->
// add_manual_entries() adds the list in one call. Hidden unless the `ai` and `ai.import`
// switches are on.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'
import AiTextSource from './AiTextSource.vue'
import ParticipantImportPreview from './ParticipantImportPreview.vue'
import { callAi } from '../../lib/ai'
import { useAiFeature } from '../../lib/aiFeatures'
import { cleanContact, entryShape, importRow, nameKey } from '../../lib/aiSchemas'
import { errorMessage } from '../../lib/errorMessages'
import { entryNamesError, registrationError } from '../../lib/registrationRules'
import { scoringFamily } from '../../lib/sportConfig'
import { confirmDialog } from '../../lib/confirmDialog'
import { supabase } from '../../lib/supabase'

const props = defineProps({
  tournament: { type: Object, required: true },
  entries: { type: Array, default: () => [] },
  busy: Boolean,
  canManage: Boolean,
  // A bracket, groups or fixtures already exist: approved additions make them stale.
  hasStructure: Boolean,
})
const emit = defineEmits(['update:busy', 'saved'])
const { t, locale } = useI18n()
const aiImportOn = useAiFeature('import')

const SAVE_LIMIT = 128
const open = ref(false)
const text = ref('')
const rows = ref([])
const unparsed = ref([])
const remarks = ref([])
const notices = ref([])
const working = ref(false)
const error = ref('')
const success = ref('')
const notify = ref(false)
const offerPending = ref(false)
const seedIds = ref([])
// Most lists have no ranking: the seed column appears only when the AI found one.
const listHasSeeds = ref(false)

const shape = computed(() => entryShape(props.tournament))
const team = computed(() => scoringFamily(props.tournament.sport || 'tennis') === 'goals')
const locked = computed(() => ['in_progress', 'completed'].includes(props.tournament.status))
const visible = computed(() => aiImportOn() && props.canManage && !locked.value)
const disabled = computed(() => working.value || props.busy)
const inPreview = computed(() => rows.value.length > 0 || unparsed.value.length > 0)

// Places left: approved entries take places; with drawn partners every person counts.
const freePlaces = computed(() => {
  const capacity = props.tournament.registration_capacity
  if (capacity == null) return null
  const people = props.tournament.doubles_pairing_mode === 'pick_random'
  const taken = props.entries
    .filter(entry => entry.status === 'approved')
    .reduce((sum, entry) => sum + (people ? Math.max(1, entry.entry_members?.length ?? 1) : 1), 0)
  return Math.max(0, capacity - taken)
})
const listPlaces = computed(() => (props.tournament.doubles_pairing_mode === 'pick_random'
  ? rows.value.reduce((sum, row) => sum + Math.max(1, row.members.filter(name => name?.trim()).length), 0)
  : rows.value.length))

function setBusy(value) {
  working.value = value
  emit('update:busy', value)
}

function resetResult() {
  error.value = ''
  success.value = ''
  offerPending.value = false
  seedIds.value = []
}

let rowKey = 0
async function recognize() {
  if (disabled.value) return
  resetResult()
  if (!text.value.trim()) { error.value = t('ai.errors.empty'); return }
  setBusy(true)
  try {
    const { result } = await callAi('import', {
      input: text.value,
      context: { tournamentId: props.tournament.id, shape: shape.value, sport: props.tournament.sport, locale: locale.value },
    })
    rows.value = result.entries.map(entry => ({ ...entry, key: `r${++rowKey}`, error: '' }))
    unparsed.value = result.unparsed
    remarks.value = result.remarks
    notices.value = result.notices
    listHasSeeds.value = rows.value.some(row => row.seed != null)
    if (!rows.value.length && !unparsed.value.length) error.value = t('ai.errors.badResponse')
  } catch (err) {
    error.value = errorMessage(err, t, 'ai.errors.unavailable')
  } finally {
    setBusy(false)
  }
}

function editText() {
  rows.value = []
  unparsed.value = []
  remarks.value = []
  notices.value = []
  resetResult()
}

// Client checks mirror add_manual_entry(); the server still decides.
function checkRows() {
  let problems = 0
  rows.value = rows.value.map(row => {
    const members = row.members.map(name => String(name ?? '').trim()).filter(Boolean)
    let rowError = ''
    if (shape.value === 'pair' && !team.value && members.length < 2) rowError = t('ai.import.incomplete')
    else {
      const key = entryNamesError(shape.value === 'single' ? 'singles' : 'doubles', members[0], members[1] ?? '')
      if (key) rowError = t(key)
      else if (row.contact && !cleanContact(row.contact)) rowError = t('registrationForm.invalidContact')
    }
    if (rowError) problems++
    return { ...row, members, error: rowError }
  })
  return problems
}

async function save(status = 'approved') {
  if (disabled.value || !rows.value.length) return
  resetResult()
  if (rows.value.length > SAVE_LIMIT) { error.value = t('ai.import.tooMany'); return }
  const incomplete = shape.value === 'pair' && !team.value
    ? rows.value.filter(row => row.members.filter(name => String(name ?? '').trim()).length < 2).length
    : 0
  if (checkRows()) {
    error.value = incomplete ? t('ai.import.incompleteBlock', { n: incomplete }) : t('ai.import.failed', { n: rows.value.filter(row => row.error).length })
    return
  }

  const existing = new Set(props.entries
    .filter(entry => ['pending', 'approved', 'waitlisted'].includes(entry.status))
    .flatMap(entry => (entry.entry_members || []).map(member => nameKey(member.member_name))))
  const twin = rows.value.flatMap(row => row.members).find(name => existing.has(nameKey(name)))
  if (twin && !(await confirmDialog(t('admin.addEntrySameName', { name: twin })))) return
  if (props.hasStructure && status === 'approved' && !(await confirmDialog(t('groupsFlow.rosterChangeConfirm')))) return

  setBusy(true)
  try {
    const { data, error: rpcError } = await supabase.rpc('add_manual_entries', {
      p_tournament_id: props.tournament.id,
      p_entries: rows.value.map(importRow),
      p_status: status,
      p_notify: notify.value,
    })
    if (rpcError) throw rpcError
    const results = Array.isArray(data) ? data : []
    const added = results.filter(result => result.ok)
    const failed = new Map(results.filter(result => !result.ok).map(result => [result.index, result.error]))

    // Seeds from the list, for the approved rows just added and only on an unseeded field.
    const seeded = added
      .filter(result => result.status === 'approved' && rows.value[result.index]?.seed)
      .sort((a, b) => rows.value[a.index].seed - rows.value[b.index].seed)
      .map(result => result.id)
    const fieldSeeded = props.entries.some(entry => entry.status === 'approved' && entry.seed_order != null)

    rows.value = rows.value
      .map((row, index) => (failed.has(index) ? { ...row, error: registrationError(failed.get(index), t, 'errors.generic') } : null))
      .filter(Boolean)
    if (added.length) success.value = t('ai.import.added', { n: added.length })
    if (failed.size) error.value = t('ai.import.failed', { n: failed.size })
    offerPending.value = status === 'approved' && [...failed.values()].some(message => message === 'registration.full')
    seedIds.value = seeded.length > 1 && !fieldSeeded ? seeded : []
    if (!rows.value.length) {
      unparsed.value = []
      remarks.value = []
      notices.value = []
      text.value = ''
    }
    if (added.length) emit('saved')
  } catch (err) {
    error.value = registrationError(err?.message, t, 'errors.generic')
  } finally {
    setBusy(false)
  }
}

async function applySeeds() {
  if (disabled.value || !seedIds.value.length) return
  setBusy(true)
  try {
    const { error: rpcError } = await supabase.rpc('set_entry_seed_order', { p_tournament_id: props.tournament.id, p_entry_ids: seedIds.value })
    if (rpcError) throw rpcError
    seedIds.value = []
    success.value = t('ai.import.seedApplied')
    emit('saved')
  } catch (err) {
    error.value = errorMessage(err, t)
  } finally {
    setBusy(false)
  }
}
</script>

<template>
  <div v-if="visible" class="admin-add-entry ai-import" :class="{ 'admin-add-entry--open': open }">
    <h3 class="admin-add-entry__heading">
      <button
        id="adm-ai-import-trigger"
        type="button"
        class="admin-add-entry__trigger"
        :aria-expanded="open"
        aria-controls="adm-ai-import-panel"
        @click="open = !open"
      >
        <span class="admin-add-entry__trigger-text ai-import__title">
          <AppIcon name="sparkles" :size="18" />
          {{ t('ai.import.title') }}
          <span class="ai-import__chip">AI</span>
        </span>
        <svg class="admin-add-entry__chevron" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
          <path d="M5 7.5 10 12.5 15 7.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
    </h3>

    <div
      v-show="open"
      id="adm-ai-import-panel"
      class="admin-add-entry__panel stack stack--sm"
      role="region"
      aria-labelledby="adm-ai-import-trigger"
    >
      <template v-if="!inPreview">
        <p class="muted admin-add-entry__hint">{{ t('ai.import.hint') }}</p>
        <AiTextSource
          id="adm-ai-import-text"
          v-model="text"
          :label="t('ai.import.label')"
          :placeholder="t('ai.import.placeholder')"
          :disabled="disabled"
        />
        <div class="ai-import__actions">
          <button type="button" class="btn btn--primary" :disabled="disabled || !text.trim()" @click="recognize">
            {{ working ? t('ai.import.recognizing') : t('ai.import.recognize') }}
          </button>
        </div>
      </template>

      <template v-else>
        <div class="ai-import__head">
          <h4 class="ai-import__subtitle">{{ t('ai.import.previewTitle') }}</h4>
          <span class="badge badge--neutral">{{ t('ai.import.count', { n: rows.length }) }}</span>
        </div>
        <p v-for="code in notices" :key="code" class="alert alert--info" role="status">{{ t(`ai.import.notices.${code}`) }}</p>
        <p v-if="freePlaces != null" class="alert" :class="listPlaces > freePlaces ? 'alert--warning' : 'alert--info'" role="status">
          {{ listPlaces > freePlaces ? t('ai.import.capacityOver', { free: freePlaces, n: listPlaces }) : t('ai.import.capacity', { free: freePlaces, n: listPlaces }) }}
        </p>

        <ParticipantImportPreview
          v-if="rows.length"
          v-model="rows"
          :shape="shape"
          :team="team"
          :show-seed="listHasSeeds"
          :entries="entries"
          :disabled="disabled"
        />

        <div v-if="unparsed.length || remarks.length" class="ai-import__notes">
          <template v-if="unparsed.length">
            <p class="ai-import__notes-title">{{ t('ai.import.unparsed') }}</p>
            <ul><li v-for="(line, index) in unparsed" :key="`u${index}`"><code>{{ line }}</code></li></ul>
          </template>
          <template v-if="remarks.length">
            <p class="ai-import__notes-title">{{ t('ai.import.remarks') }}</p>
            <ul><li v-for="(line, index) in remarks" :key="`r${index}`">{{ line }}</li></ul>
          </template>
        </div>

        <label class="checkbox-row" for="adm-ai-import-notify">
          <input id="adm-ai-import-notify" v-model="notify" type="checkbox" :disabled="disabled" />
          <span>
            {{ t('ai.import.notify') }}
            <span class="ai-import__hint">{{ t('ai.import.notifyHint') }}</span>
          </span>
        </label>

        <div class="ai-import__actions">
          <button type="button" class="btn btn--primary" :disabled="disabled || !rows.length" @click="save('approved')">
            {{ working ? t('ai.import.saving') : t('ai.import.save', { n: rows.length }) }}
          </button>
          <button v-if="offerPending && rows.length" type="button" class="btn btn--outline" :disabled="disabled" @click="save('pending')">
            {{ t('ai.import.addRestPending') }}
          </button>
          <button type="button" class="btn btn--ghost" :disabled="disabled" @click="editText">{{ t('ai.import.editText') }}</button>
        </div>
      </template>

      <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>
      <p v-if="success" class="alert alert--success" role="status">{{ success }}</p>
      <div v-if="seedIds.length" class="alert alert--info ai-import__seed" role="status">
        <span>{{ t('ai.import.seedOffer') }}</span>
        <button type="button" class="btn btn--outline btn--sm" :disabled="disabled" @click="applySeeds">{{ t('ai.import.seedApply') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ai-import__title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.ai-import__title .app-icon {
  color: var(--primary);
}
.ai-import__chip {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 0.6875rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  color: var(--primary);
  background: var(--primary-soft);
}
.ai-import__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
}
.ai-import__subtitle {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}
.ai-import__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2, 8px);
}
.ai-import__notes {
  font-size: 0.8125rem;
  color: var(--muted);
}
.ai-import__notes ul {
  margin: 4px 0 8px;
  padding-left: 18px;
}
.ai-import__notes code {
  overflow-wrap: anywhere;
}
.ai-import__notes-title {
  margin: 0;
  font-weight: 600;
}
.ai-import__hint {
  display: block;
  font-size: 0.8125rem;
  color: var(--muted);
}
.ai-import__seed {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2, 8px);
}
</style>
