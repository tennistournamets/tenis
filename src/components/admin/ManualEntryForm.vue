<script setup>
import { computed, onBeforeUnmount, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { scoringFamily } from '../../lib/sportConfig'
import { useUnsavedChanges } from '../../lib/unsavedChanges'
import { supabase } from '../../lib/supabase'

const props = defineProps({
  tournament: { type: Object, required: true },
  busy: Boolean,
  canManage: Boolean,
})
const emit = defineEmits(['update:busy', 'saved'])
const { t } = useI18n()
const saving = ref(false)
const actionLoading = computed({
  get: () => props.busy || saving.value,
  set: value => { saving.value = value; emit('update:busy', value) },
})
const isTournamentActive = computed(() => props.tournament.status === 'in_progress')
const isTournamentFinished = computed(() => props.tournament.status === 'completed')
const disabled = computed(() => actionLoading.value || !props.canManage || isTournamentActive.value || isTournamentFinished.value)
const isGoalsSport = computed(() => scoringFamily(props.tournament.sport || 'tennis') === 'goals')
const isPickRandomDoubles = computed(() => props.tournament.category === 'doubles' && props.tournament.doubles_pairing_mode === 'pick_random')

const addEntryForm = reactive({
  memberOne: '',
  memberTwo: '',
  displayName: '',
  phoneOrEmail: '',
  asPending: false,
})

const addEntryError = ref('')
const addEntrySuccess = ref('')
const addEntryContactTouched = ref(false)
const addEntryAccordionOpen = ref(false)

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phonePattern = /^\+?[\d\s\-()]{7,20}$/

function isValidContact(value) {
  const trimmed = String(value).trim()
  return emailPattern.test(trimmed) || phonePattern.test(trimmed)
}

const addEntryContactInvalid = computed(() => {
  const v = addEntryForm.phoneOrEmail.trim()
  return addEntryContactTouched.value && Boolean(v) && !isValidContact(addEntryForm.phoneOrEmail)
})

let addEntrySuccessTimer = null

function resetAddEntryFeedback() {
  addEntryError.value = ''
  addEntrySuccess.value = ''
  clearTimeout(addEntrySuccessTimer)
  addEntrySuccessTimer = null
}

async function addEntryManually() {
  if (actionLoading.value || !props.canManage) return
  if (isTournamentActive.value || isTournamentFinished.value) { addEntryError.value = t('drafts.rulesLocked'); return }
  resetAddEntryFeedback()
  addEntryContactTouched.value = true

  const category = props.tournament.category
  const pMode = props.tournament.doubles_pairing_mode
  const m1 = addEntryForm.memberOne.trim()
  const m2 = addEntryForm.memberTwo.trim()

  const requireBothMembers = category === 'doubles' && pMode !== 'pick_random'
  if (!m1 || (requireBothMembers && !m2)) {
    addEntryError.value = t('admin.addEntryInvalidMembers')
    return
  }

  if (addEntryForm.phoneOrEmail.trim() && !isValidContact(addEntryForm.phoneOrEmail)) {
    addEntryError.value = t('registrationForm.invalidContact')
    return
  }

  let phoneOrEmail = addEntryForm.phoneOrEmail.trim()
  if (!phoneOrEmail) {
    phoneOrEmail = `admin-entry-${crypto.randomUUID()}@local.tenis`
  }

  const customName = addEntryForm.displayName.trim()
  const displayName =
    customName || (category === 'singles' ? m1 : (m2 ? `${m1} / ${m2}` : m1))

  actionLoading.value = true

  try {
    const { data: entryRow, error: insertError } = await supabase
      .from('entries')
      .insert({
        tournament_id: props.tournament.id,
        entry_type: category,
        display_name: displayName,
        phone_or_email: phoneOrEmail,
        status: addEntryForm.asPending ? 'pending' : 'approved',
      })
      .select('id')
      .single()

    if (insertError || !entryRow) {
      const msg = insertError?.message || ''
      const dup =
        /duplicate key|unique constraint|already exists/i.test(msg) ||
        insertError?.code === '23505'
      addEntryError.value = dup ? t('admin.addEntryDuplicateContact') : msg || t('errors.generic')
      return
    }

    const memberRows = [{ entry_id: entryRow.id, member_name: m1, member_order: 1 }]
    if (category === 'doubles' && m2) {
      memberRows.push({ entry_id: entryRow.id, member_name: m2, member_order: 2 })
    }

    const { error: membersError } = await supabase.from('entry_members').insert(memberRows)

    if (membersError) {
      await supabase.from('entries').delete().eq('id', entryRow.id)
      addEntryError.value = membersError.message || t('errors.generic')
      return
    }

    addEntryForm.memberOne = ''
    addEntryForm.memberTwo = ''
    addEntryForm.displayName = ''
    addEntryForm.phoneOrEmail = ''
    addEntryForm.asPending = false
    addEntryContactTouched.value = false

    addEntrySuccess.value = t('admin.addEntrySuccess')
    addEntrySuccessTimer = setTimeout(() => {
      addEntrySuccess.value = ''
      addEntrySuccessTimer = null
    }, 5000)

    emit('saved')
  } catch (error) {
    addEntryError.value = error.message || t('errors.generic')
  } finally { actionLoading.value = false }
}

const hasEntryDraft = computed(() => Object.entries(addEntryForm).some(([key, value]) => key === 'asPending' ? value : Boolean(value)))
useUnsavedChanges(() => hasEntryDraft.value, () => actionLoading.value)
onBeforeUnmount(() => clearTimeout(addEntrySuccessTimer))
</script>

<template>
  <div v-if="(!isTournamentActive && !isTournamentFinished) || hasEntryDraft" class="admin-add-entry" :class="{ 'admin-add-entry--open': addEntryAccordionOpen }">
    <p v-if="isTournamentActive || isTournamentFinished" class="alert alert--info" role="status">{{ t('drafts.rulesLocked') }}</p>
    <h3 class="admin-add-entry__heading">
      <button
        id="adm-add-entry-trigger"
        type="button"
        class="admin-add-entry__trigger"
        :aria-expanded="addEntryAccordionOpen"
        aria-controls="adm-add-entry-panel"
        @click="addEntryAccordionOpen = !addEntryAccordionOpen"
      >
        <span class="admin-add-entry__trigger-text">{{ t('admin.addEntryTitle') }}</span>
        <svg
          class="admin-add-entry__chevron"
          width="20"
          height="20"
          viewBox="0 0 20 20"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M5 7.5 10 12.5 15 7.5"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>
    </h3>

    <div
      v-show="addEntryAccordionOpen"
      id="adm-add-entry-panel"
      class="admin-add-entry__panel stack stack--sm"
      role="region"
      aria-labelledby="adm-add-entry-trigger"
    >
      <p class="muted admin-add-entry__hint">{{ t('admin.addEntryHint') }}</p>

      <form class="stack stack--sm" @submit.prevent="addEntryManually">
        <div class="grid-2 grid-2--admin">
          <div class="form-field">
            <label for="adm-add-m1">{{ isGoalsSport ? t('registrationForm.teamName') : tournament.category === 'doubles' ? t('registrationForm.memberOne') : t('registrationForm.member') }}</label>
            <input
              id="adm-add-m1"
              v-model="addEntryForm.memberOne"
              class="input"
              type="text"
              autocomplete="name"
              :disabled="disabled"
              required
            />
          </div>
          <div v-if="tournament.category === 'doubles' && !isPickRandomDoubles" class="form-field">
            <label for="adm-add-m2">{{ t('registrationForm.memberTwo') }}</label>
            <input
              id="adm-add-m2"
              v-model="addEntryForm.memberTwo"
              class="input"
              type="text"
              autocomplete="name"
              :disabled="disabled"
              required
            />
          </div>
          <div v-if="isPickRandomDoubles" class="form-field">
            <label for="adm-add-m2">{{ t('registrationForm.memberTwoOptional') }}</label>
            <input
              id="adm-add-m2"
              v-model="addEntryForm.memberTwo"
              class="input"
              type="text"
              autocomplete="name"
              :disabled="disabled"
            />
          </div>
          <div v-if="tournament.category === 'doubles' || isGoalsSport" class="form-field">
            <label for="adm-add-display">{{ t('registrationForm.displayName') }}</label>
            <input
              id="adm-add-display"
              v-model="addEntryForm.displayName"
              class="input"
              type="text"
              :disabled="disabled"
            />
          </div>
          <div class="form-field">
            <label for="adm-add-contact">{{ t('admin.addEntryContactOptional') }}</label>
            <input
              id="adm-add-contact"
              v-model="addEntryForm.phoneOrEmail"
              class="input"
              type="text"
              inputmode="email"
              autocomplete="off"
              :class="{ 'input--error': addEntryContactInvalid }"
              :disabled="disabled"
              @blur="addEntryContactTouched = true"
            />
          </div>
        </div>

        <label class="checkbox-row" for="adm-add-pending">
          <input id="adm-add-pending" v-model="addEntryForm.asPending" type="checkbox" :disabled="disabled" />
          {{ t('admin.addEntryAsPending') }}
        </label>

        <div class="inline-actions">
          <button class="btn btn--primary btn--sm" type="submit" :disabled="disabled">
            {{ t('admin.addEntrySubmit') }}
          </button>
        </div>

        <div v-if="addEntrySuccess" class="alert alert--success" role="status">{{ addEntrySuccess }}</div>
        <div v-if="addEntryError" class="alert alert--error" role="alert">{{ addEntryError }}</div>
      </form>
    </div>
  </div>
</template>
