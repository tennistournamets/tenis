<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useUnsavedChanges, confirmDiscard } from '../lib/unsavedChanges'
import { cloneForm, sameForm } from '../lib/formDraft'
import { supabase } from '../lib/supabase'
import { scoringFamily } from '../lib/sportConfig'

const props = defineProps({
  tournament: {
    type: Object,
    required: true,
  },
})

const emit = defineEmits(['submitted', 'dirty'])

const { t } = useI18n()
const entryType = computed(() => props.tournament.category)
const isTeamSport = computed(() => scoringFamily(props.tournament.sport || 'tennis') === 'goals')
const memberOneLabel = computed(() => {
  if (isTeamSport.value) return t('registrationForm.teamName')
  return entryType.value === 'doubles' ? t('registrationForm.memberOne') : t('registrationForm.member')
})
// «Тип участия» дублирует чипы в шапке для одиночного разряда — показываем
// только там, где он несёт смысл (пары и командные виды).
const showEntryType = computed(() => entryType.value === 'doubles' || isTeamSport.value)
const entryTypeLabel = computed(() =>
  isTeamSport.value ? t('tournament.team') : t(`tournament.${entryType.value}`),
)
const pairingMode = computed(() => props.tournament.doubles_pairing_mode || 'pre_agreed')
const showMemberTwo = computed(() => entryType.value === 'doubles' && pairingMode.value === 'pre_agreed')
const showMemberTwoOptional = computed(() => entryType.value === 'doubles' && pairingMode.value === 'pick_random')

const form = reactive({
  displayName: '',
  phoneOrEmail: '',
  memberOne: '',
  memberTwo: '',
})

const loading = ref(false)
const errorText = ref('')
const submitted = ref(false)
const contactTouched = ref(false)

const initialForm = cloneForm(form)
const dirty = computed(() => !sameForm(form, initialForm))
const conditions = () => ({ category: props.tournament.category, sport: props.tournament.sport, pairing: props.tournament.doubles_pairing_mode })
const reviewedConditions = ref(conditions())
const conditionsChanged = computed(() => dirty.value && !sameForm(conditions(), reviewedConditions.value))
const registrationClosed = computed(() => props.tournament.status !== 'registration_open')
useUnsavedChanges(() => dirty.value, () => loading.value)
watch(dirty, value => emit('dirty', value), { flush: 'sync' })
watch(conditions, value => { if (!dirty.value) reviewedConditions.value = cloneForm(value) }, { deep: true })
async function discard() {
  if (!(await confirmDiscard(t, dirty.value, loading.value))) return
  Object.assign(form, cloneForm(initialForm))
  reviewedConditions.value = conditions()
}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phonePattern = /^\+?[\d\s\-()]{7,20}$/

function isValidContact(value) {
  const trimmed = value.trim()
  return emailPattern.test(trimmed) || phonePattern.test(trimmed)
}

const contactInvalid = computed(() => contactTouched.value && form.phoneOrEmail && !isValidContact(form.phoneOrEmail))

async function submit() {
  if (loading.value || registrationClosed.value || conditionsChanged.value) return
  loading.value = true
  errorText.value = ''
  submitted.value = false
  contactTouched.value = true

  if (!isValidContact(form.phoneOrEmail)) {
    errorText.value = t('registrationForm.invalidContact')
    loading.value = false
    return
  }

  const memberTwo = entryType.value === 'doubles' && form.memberTwo.trim()
    ? form.memberTwo
    : null

  const { error } = await supabase.rpc('register_entry', {
    p_slug: props.tournament.slug,
    p_entry_type: entryType.value,
    p_phone_or_email: form.phoneOrEmail,
    p_member_one: form.memberOne,
    p_member_two: memberTwo,
    p_display_name: form.displayName || null,
  })

  loading.value = false

  if (error) {
    errorText.value = error.message || t('registrationForm.error')
    return
  }

  submitted.value = true
  form.displayName = ''
  form.phoneOrEmail = ''
  form.memberOne = ''
  form.memberTwo = ''
  contactTouched.value = false
  emit('submitted')
}
</script>

<template>
  <form class="card card--elevated stack stack--sm" @submit.prevent="submit">
    <div>
      <h3 class="section-title">{{ t('registrationForm.title') }}</h3>
      <p v-if="showEntryType" class="muted">
        {{ t('registrationForm.entryType') }}:
        <span class="badge badge--neutral">{{ entryTypeLabel }}</span>
      </p>
    </div>

    <p v-if="registrationClosed" class="alert alert--info" role="status">{{ t('drafts.registrationClosed') }}</p>
    <div v-else-if="conditionsChanged" class="alert alert--info" role="status">
      {{ t('drafts.registrationChanged') }}
      <button class="btn btn--ghost btn--sm" type="button" @click="reviewedConditions = conditions()">{{ t('drafts.review') }}</button>
    </div>
    <div class="form-field">
      <label for="reg-member-one">{{ memberOneLabel }}</label>
      <input
        id="reg-member-one"
        v-model="form.memberOne"
        class="input"
        type="text"
        autocomplete="name"
        :disabled="loading"
        required
      />
    </div>

    <div v-if="showMemberTwo" class="form-field">
      <label for="reg-member-two">{{ t('registrationForm.memberTwo') }}</label>
      <input
        id="reg-member-two"
        v-model="form.memberTwo"
        class="input"
        type="text"
        autocomplete="name"
        :disabled="loading"
        required
      />
    </div>

    <div v-if="showMemberTwoOptional" class="form-field">
      <label for="reg-member-two">{{ t('registrationForm.memberTwoOptional') }}</label>
      <input
        id="reg-member-two"
        v-model="form.memberTwo"
        class="input"
        type="text"
        autocomplete="name"
        :disabled="loading"
      />
    </div>

    <div class="form-field">
      <label for="reg-display-name">{{ showEntryType ? t('registrationForm.displayName') : t('registrationForm.displayNameSolo') }}</label>
      <input
        id="reg-display-name"
        v-model="form.displayName"
        class="input"
        type="text"
        :disabled="loading"
      />
    </div>

    <div class="form-field">
      <label for="reg-contact">{{ t('registrationForm.contact') }}</label>
      <input
        id="reg-contact"
        v-model="form.phoneOrEmail"
        class="input"
        :class="{ 'input--error': contactInvalid }"
        type="text"
        inputmode="email"
        autocomplete="email"
        :disabled="loading"
        required
        @blur="contactTouched = true"
      />
    </div>

    <button class="btn btn--primary" :disabled="loading || registrationClosed || conditionsChanged" type="submit">
      <span v-if="loading" class="spinner" aria-hidden="true" />
      {{ t('registrationForm.submit') }}
    </button>

    <button v-if="dirty" class="btn btn--ghost" type="button" :disabled="loading" @click="discard">{{ t('drafts.discardLeave') }}</button>
    <div v-if="submitted" class="alert alert--success" role="status">{{ t('registrationForm.success') }}</div>
    <div v-if="errorText" class="alert alert--error" role="alert">{{ errorText }}</div>
  </form>
</template>
