<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { feeUnitKey, formatDeadline, formatFee } from '../lib/registrationRules'

const props = defineProps({
  registration: { type: Object, default: null },
  tournament: { type: Object, default: null },
})

const { t, locale } = useI18n()

const showCapacity = computed(() => Boolean(
  props.registration?.capacity && props.registration.capacity_public !== false && props.registration.occupied != null,
))
const deadlineText = computed(() => formatDeadline(props.registration?.deadline_at, locale.value))
const fee = computed(() => props.registration?.fee || null)
const feeText = computed(() => {
  if (!fee.value) return ''
  if (fee.value.mode === 'free') return t('registrationRules.feeFree')
  if (fee.value.mode !== 'paid') return ''
  return t('registrationRules.fee', { amount: formatFee(fee.value, locale.value), unit: t(feeUnitKey(fee.value.unit)) })
})
const showWaitlist = computed(() => Boolean(props.registration?.waitlist_enabled && props.registration?.capacity))
const hasContent = computed(() => showCapacity.value || showWaitlist.value || Boolean(deadlineText.value) || Boolean(feeText.value))
</script>

<template>
  <section v-if="hasContent" class="card reg-conditions stack stack--sm" :aria-label="t('registrationRules.title')">
    <h3 class="section-title">{{ t('registrationRules.title') }}</h3>
    <ul class="reg-conditions__list">
      <li v-if="showCapacity" class="reg-conditions__item">
        <strong>{{ t('registrationRules.occupied', { occupied: registration.occupied, capacity: registration.capacity }) }}</strong>
        <span v-if="registration.free != null" class="muted"> · {{ t('registrationRules.free', { free: registration.free }) }}</span>
        <p v-if="registration.capacity_unit === 'players'" class="muted reg-conditions__hint">{{ t('registrationRules.unitPlayersHint') }}</p>
        <p class="muted reg-conditions__hint">{{ t('registrationRules.approvedRule') }}</p>
      </li>
      <li v-if="showWaitlist" class="reg-conditions__item">
        <span>{{ t('registrationRules.waitlistPublic') }}</span>
        <span v-if="registration.waitlist_count" class="muted"> · {{ t('registrationRules.waitlistPublicCount', { count: registration.waitlist_count }) }}</span>
      </li>
      <li v-if="deadlineText" class="reg-conditions__item">
        <span>{{ t('registrationRules.deadline', { date: deadlineText }) }}</span>
      </li>
      <li v-if="feeText" class="reg-conditions__item">
        <strong>{{ feeText }}</strong>
        <p v-if="fee.mode === 'paid'" class="muted reg-conditions__hint">{{ t('registrationRules.feePaidTo') }}</p>
      </li>
    </ul>
  </section>
</template>

<style scoped>
.reg-conditions__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 10px; }
.reg-conditions__item { line-height: 1.45; overflow-wrap: anywhere; }
.reg-conditions__hint { margin: 4px 0 0; font-size: 0.84rem; }
</style>
