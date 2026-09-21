<script setup>
import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { useUnsavedChanges, confirmDiscard } from '../lib/unsavedChanges'
import { cloneForm, sameForm } from '../lib/formDraft'
import { supabase } from '../lib/supabase'
import { scoringFamily } from '../lib/sportConfig'
import { registrationDisplayState, registrationError, closedReasonKey } from '../lib/registrationRules'

const props = defineProps({
  tournament: {
    type: Object,
    required: true,
  },
  registration: { type: Object, default: null },
  now: { type: Number, default: 0 },
  accessToken: { type: String, default: '' },
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
  phone: '',
  email: '',
  memberOne: '',
  memberTwo: '',
})

const loading = ref(false)
const errorText = ref('')
const submitted = ref(false)
const submittedStatus = ref('pending')
const phoneTouched = ref(false)
const emailTouched = ref(false)

const initialForm = cloneForm(form)
const dirty = computed(() => !sameForm(form, initialForm))
const conditions = () => ({ category: props.tournament.category, sport: props.tournament.sport, pairing: props.tournament.doubles_pairing_mode, fee: props.registration?.fee ?? null })
const reviewedConditions = ref(conditions())
const conditionsChanged = computed(() => dirty.value && !sameForm(conditions(), reviewedConditions.value))
const regState = computed(() => registrationDisplayState(props.registration, props.now || Date.now(), props.tournament))
const waitlistMode = computed(() => regState.value.waitlistOpen)
const registrationClosed = computed(() => !regState.value.accepting && !regState.value.waitlistOpen)
const closedMessage = computed(() => (!regState.value.known || regState.value.reason === 'status')
  ? t('drafts.registrationClosed')
  : t(closedReasonKey(regState.value.reason)))
useUnsavedChanges(() => dirty.value, () => loading.value)
watch(dirty, value => emit('dirty', value), { flush: 'sync' })
watch(conditions, value => { if (!dirty.value) reviewedConditions.value = cloneForm(value) }, { deep: true })
async function discard() {
  if (!(await confirmDiscard(t, dirty.value, loading.value))) return
  Object.assign(form, cloneForm(initialForm))
  reviewedConditions.value = conditions()
}

// The same shapes the database accepts, so the form never sends a value the
// RPC would reject.
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phonePattern = /^\+?[\d\s\-()]{7,20}$/

const phoneValid = computed(() => phonePattern.test(form.phone.trim()))
const emailValid = computed(() => emailPattern.test(form.email.trim()))
const phoneInvalid = computed(() => phoneTouched.value && Boolean(form.phone) && !phoneValid.value)
const emailInvalid = computed(() => emailTouched.value && Boolean(form.email) && !emailValid.value)

async function submit() {
  if (loading.value || registrationClosed.value || conditionsChanged.value) return
  loading.value = true
  errorText.value = ''
  submitted.value = false
  phoneTouched.value = true
  emailTouched.value = true

  if (!phoneValid.value) {
    errorText.value = t('registrationForm.invalidPhone')
    loading.value = false
    return
  }

  if (!emailValid.value) {
    errorText.value = t('registrationForm.invalidEmail')
    loading.value = false
    return
  }

  const memberTwo = entryType.value === 'doubles' && form.memberTwo.trim()
    ? form.memberTwo
    : null

  try {
    const { data, error } = await supabase.rpc('register_entry', {
      p_slug: props.tournament.slug,
      p_entry_type: entryType.value,
      p_phone: form.phone,
      p_email: form.email,
      p_member_one: form.memberOne,
      p_member_two: memberTwo,
      p_display_name: form.displayName || null,
      p_access_token: props.accessToken || null,
    })

    if (error) {
      errorText.value = registrationError(error.message, t, 'registrationForm.error')
      return
    }

    submitted.value = true
    submittedStatus.value = data?.status === 'waitlisted' ? 'waitlisted' : 'pending'
    form.displayName = ''
    form.phone = ''
    form.email = ''
    form.memberOne = ''
    form.memberTwo = ''
    phoneTouched.value = false
    emailTouched.value = false
    emit('submitted')
  } catch (error) {
    errorText.value = registrationError(error?.message, t, 'registrationForm.error')
  } finally {
    loading.value = false
  }
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

    <p v-if="registrationClosed" class="alert alert--info" role="status">{{ closedMessage }}</p>
    <div v-else-if="conditionsChanged" class="alert alert--info" role="status">
      {{ t('drafts.registrationChanged') }}
      <button class="btn btn--ghost btn--sm" type="button" @click="reviewedConditions = conditions()">{{ t('drafts.review') }}</button>
    </div>
    <p v-else-if="waitlistMode" class="alert alert--info" role="status">{{ t('registrationRules.waitlistNote') }}</p>
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
      <label for="reg-phone">{{ t('registrationForm.phone') }}</label>
      <input
        id="reg-phone"
        v-model="form.phone"
        class="input"
        :class="{ 'input--error': phoneInvalid }"
        type="tel"
        inputmode="tel"
        autocomplete="tel"
        :disabled="loading"
        required
        @blur="phoneTouched = true"
      />
      <p v-if="phoneInvalid" class="error-text" role="alert" style="margin: 4px 0 0">{{ t('registrationForm.invalidPhone') }}</p>
    </div>

    <div class="form-field">
      <label for="reg-email">{{ t('registrationForm.email') }}</label>
      <input
        id="reg-email"
        v-model="form.email"
        class="input"
        :class="{ 'input--error': emailInvalid }"
        type="email"
        inputmode="email"
        autocomplete="email"
        :disabled="loading"
        required
        @blur="emailTouched = true"
      />
      <p v-if="emailInvalid" class="error-text" role="alert" style="margin: 4px 0 0">{{ t('registrationForm.invalidEmail') }}</p>
    </div>

    <button class="btn btn--primary" :disabled="loading || registrationClosed || conditionsChanged" type="submit">
      <span v-if="loading" class="spinner" aria-hidden="true" />
      {{ waitlistMode ? t('registrationRules.waitlistSubmit') : t('registrationForm.submit') }}
    </button>

    <button v-if="dirty" class="btn btn--ghost" type="button" :disabled="loading" @click="discard">{{ t('drafts.discardLeave') }}</button>
    <div v-if="submitted" class="alert alert--success" role="status">{{ submittedStatus === 'waitlisted' ? t('registrationRules.waitlistSuccess') : t('registrationForm.success') }}</div>
    <div v-if="errorText" class="alert alert--error" role="alert">{{ errorText }}</div>
  </form>
</template>
