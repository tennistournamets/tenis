<script setup>
import { computed, nextTick, reactive, ref, watch } from 'vue'
import { Translation, useI18n } from 'vue-i18n'

import { useUnsavedChanges, confirmDiscard } from '../lib/unsavedChanges'
import { cloneForm, sameForm } from '../lib/formDraft'
import { supabase } from '../lib/supabase'
import { isIndividualFormat, scoringFamily } from '../lib/sportConfig'
import { registrationDisplayState, registrationError, closedReasonKey, entryNamesError } from '../lib/registrationRules'
import { track } from '../lib/analytics'
import { legalPath } from '../lib/localeRoute'

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

const { t, locale } = useI18n()
const entryType = computed(() => props.tournament.category)
const isTeamSport = computed(() => scoringFamily(props.tournament.sport || 'tennis') === 'goals')
// Americano, Mexicano, King of the Court: one player per entry, the partner changes every round.
const isIndividual = computed(() => isIndividualFormat(props.tournament.format))
const memberOneLabel = computed(() => {
  if (isTeamSport.value) return t('registrationForm.teamName')
  return entryType.value === 'doubles' && !isIndividual.value ? t('registrationForm.memberOne') : t('registrationForm.member')
})
// «Тип участия» дублирует чипы в шапке для одиночного разряда — показываем
// только там, где он несёт смысл (пары и командные виды).
const showEntryType = computed(() => entryType.value === 'doubles' || isTeamSport.value)
const entryTypeLabel = computed(() =>
  isTeamSport.value ? t('tournament.team') : t(`tournament.${entryType.value}`),
)
const pairingMode = computed(() => props.tournament.doubles_pairing_mode || 'pre_agreed')
const showMemberTwo = computed(() => entryType.value === 'doubles' && pairingMode.value === 'pre_agreed')
const showMemberTwoOptional = computed(() => entryType.value === 'doubles' && pairingMode.value === 'pick_random' && !isIndividual.value)

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
const successCard = ref(null)

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
async function registerAnother() {
  submitted.value = false
  await nextTick()
  document.getElementById('reg-member-one')?.focus()
}

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

  const namesError = entryNamesError(entryType.value, form.memberOne, form.memberTwo, form.displayName)
  if (namesError) {
    errorText.value = t(namesError)
    loading.value = false
    return
  }

  const memberTwo = entryType.value === 'doubles' && !isIndividual.value && form.memberTwo.trim()
    ? form.memberTwo
    : null

  try {
    // The UI language travels as a header, so the participant's emails come in the same one.
    const { data, error } = await supabase.rpc('register_entry', {
      p_slug: props.tournament.slug,
      p_entry_type: entryType.value,
      p_phone: form.phone,
      p_email: form.email,
      p_member_one: form.memberOne,
      p_member_two: memberTwo,
      p_display_name: form.displayName || null,
      p_access_token: props.accessToken || null,
    }).setHeader('x-bracketa-locale', locale.value)

    if (error) {
      errorText.value = registrationError(error.message, t, 'registrationForm.error')
      return
    }

    submitted.value = true
    track('registration_submitted', { sport: props.tournament.sport, status: data?.status || 'pending' })
    submittedStatus.value = data?.status === 'waitlisted' ? 'waitlisted' : 'pending'
    form.displayName = ''
    form.phone = ''
    form.email = ''
    form.memberOne = ''
    form.memberTwo = ''
    phoneTouched.value = false
    emailTouched.value = false
    emit('submitted')
    // The fields give way to the confirmation; on a phone it would otherwise
    // sit below the fold under an emptied form.
    await nextTick()
    successCard.value?.scrollIntoView({ block: 'center' })
    successCard.value?.focus({ preventScroll: true })
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
      <p v-if="showEntryType" class="muted reg-form__type">{{ isTeamSport ? t('registrationForm.teamNote') : isIndividual ? t('pointsFormat.individualHint') : t(showMemberTwoOptional ? 'registrationForm.doublesRandomNote' : 'registrationForm.doublesNote') }}</p>
      <p class="muted reg-form__legend"><span class="reg-form__req" aria-hidden="true">*</span> {{ t('registrationForm.requiredLegend') }}</p>
    </div>

    <div v-if="submitted" ref="successCard" class="alert alert--success reg-form__done" role="status" tabindex="-1">
      <p class="reg-form__done-text">{{ submittedStatus === 'waitlisted' ? t('registrationRules.waitlistSuccess') : t('registrationForm.success') }}</p>
      <p class="reg-form__done-text">{{ t('registrationForm.successEmail') }}</p>
      <button class="btn btn--secondary btn--sm" type="button" @click="registerAnother">{{ t('registrationForm.anotherEntry') }}</button>
    </div>
    <template v-else>
      <p v-if="registrationClosed" class="alert alert--info" role="status">{{ closedMessage }}</p>
      <div v-else-if="conditionsChanged" class="alert alert--info" role="status">
        {{ t('drafts.registrationChanged') }}
        <button class="btn btn--ghost btn--sm" type="button" @click="reviewedConditions = conditions()">{{ t('drafts.review') }}</button>
      </div>
      <p v-else-if="waitlistMode" class="alert alert--info" role="status">{{ t('registrationRules.waitlistNote') }}</p>
      <div class="form-field">
        <label for="reg-member-one">{{ memberOneLabel }} <span class="reg-form__req" aria-hidden="true">*</span></label>
        <input
          id="reg-member-one"
          v-model="form.memberOne"
          class="input"
          type="text"
          maxlength="100"
          autocomplete="name"
          :disabled="loading"
          required
        />
      </div>

      <div v-if="showMemberTwo" class="form-field">
        <label for="reg-member-two">{{ t('registrationForm.memberTwo') }} <span class="reg-form__req" aria-hidden="true">*</span></label>
        <input
          id="reg-member-two"
          v-model="form.memberTwo"
          class="input"
          type="text"
          maxlength="100"
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
          maxlength="100"
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
          maxlength="160"
          aria-describedby="reg-display-name-hint"
          :disabled="loading"
        />
        <p id="reg-display-name-hint" class="field-hint">{{ t('registrationForm.displayNameHint') }}</p>
      </div>

      <div class="form-field">
        <label for="reg-phone">{{ t('registrationForm.phone') }} <span class="reg-form__req" aria-hidden="true">*</span></label>
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
          :aria-invalid="phoneInvalid || undefined"
          :aria-describedby="phoneInvalid ? 'reg-phone-error' : undefined"
          @blur="phoneTouched = true"
        />
        <p v-if="phoneInvalid" id="reg-phone-error" class="error-text" role="alert" style="margin: 4px 0 0">{{ t('registrationForm.invalidPhone') }}</p>
      </div>

      <div class="form-field">
        <label for="reg-email">{{ t('registrationForm.email') }} <span class="reg-form__req" aria-hidden="true">*</span></label>
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
          :aria-invalid="emailInvalid || undefined"
          :aria-describedby="emailInvalid ? 'reg-email-error reg-email-hint' : 'reg-email-hint'"
          @blur="emailTouched = true"
        />
        <p v-if="emailInvalid" id="reg-email-error" class="error-text" role="alert" style="margin: 4px 0 0">{{ t('registrationForm.invalidEmail') }}</p>
        <p id="reg-email-hint" class="field-hint">{{ t('registrationForm.contactsPrivate') }}</p>
      </div>

      <Translation keypath="registrationForm.legalNote" tag="p" class="field-hint reg-form__legal" scope="global">
        <template #terms><a :href="legalPath(locale, 'terms')" target="_blank" rel="noopener">{{ t('registrationForm.legalTerms') }}</a></template>
        <template #privacy><a :href="legalPath(locale, 'privacy')" target="_blank" rel="noopener">{{ t('registrationForm.legalPrivacy') }}</a></template>
      </Translation>

      <button class="btn btn--primary" :disabled="loading || registrationClosed || conditionsChanged" type="submit">
        <span v-if="loading" class="spinner" aria-hidden="true" />
        {{ waitlistMode ? t('registrationRules.waitlistSubmit') : t('registrationForm.submit') }}
      </button>

      <button v-if="dirty" class="btn btn--ghost" type="button" :disabled="loading" @click="discard">{{ t('drafts.discardLeave') }}</button>
    </template>
    <div v-if="errorText" class="alert alert--error" role="alert">{{ errorText }}</div>
  </form>
</template>

<style scoped>
.reg-form__type { margin: 4px 0 0; }
.reg-form__legend { margin: 4px 0 0; font-size: 0.8125rem; }
.reg-form__req { color: var(--danger); font-weight: 600; }
.reg-form__legal { margin: 0; }
.reg-form__legal a { color: inherit; text-decoration: underline; text-underline-offset: 2px; }
.reg-form__legal a:hover { color: var(--text); }
.reg-form__done { display: grid; gap: 8px; justify-items: start; }
.reg-form__done:focus { outline: none; }
.reg-form__done-text { margin: 0; }
</style>
