<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FEE_CURRENCIES, feeUnitDefault, feeUnitsFor } from '../../lib/registrationRules'
import DateTimeField from '../DateTimeField.vue'
import InfoTip from '../InfoTip.vue'

// Shared by the settings form and the create wizard. `form` is the caller's
// reactive draft; its registration keys are edited in place.
const props = defineProps({
  form: { type: Object, required: true },
  tournament: { type: Object, default: null },
  disabled: Boolean,
  idPrefix: { type: String, default: 'reg' },
  teleportToDialog: Boolean,
  // 'card' — два fieldset с рамкой и legend (мастер); 'plain' — без рамок, с eyebrow-заголовками (настройки)
  variant: { type: String, default: 'card' },
  // The wizard step already has this title as its heading.
  hideMainLegend: Boolean,
})

const { t } = useI18n()
const countsPlayers = computed(() => props.tournament?.category === 'doubles' && props.tournament?.doubles_pairing_mode === 'pick_random')
const capacityHint = computed(() => [t('registrationRules.capacityHint'), countsPlayers.value ? t('registrationRules.capacityPlayersHint') : '']
  .filter(Boolean).join(' '))
// Only units that exist in this tournament: no "per pair" in singles.
const feeUnits = computed(() => feeUnitsFor(props.tournament))
const unitValue = computed({
  get: () => (feeUnits.value.includes(props.form.entry_fee_unit) ? props.form.entry_fee_unit : feeUnitDefault(props.tournament)),
  set: value => { props.form.entry_fee_unit = value },
})
// Double elimination (v1) needs a power-of-two field, so its seat limit is a
// choice of valid sizes rather than a free number. A pick-random doubles field
// counts players, two per future pair.
const isDoubleElim = computed(() => props.tournament?.format === 'double_elimination')
const capacityOptions = computed(() => {
  const sizes = [4, 8, 16, 32].map(n => (countsPlayers.value ? n * 2 : n))
  const current = Number(props.form.registration_capacity)
  return current && !sizes.includes(current) ? [...sizes, current].sort((a, b) => a - b) : sizes
})
const capacityModel = computed({
  get: () => (props.form.registration_capacity === '' || props.form.registration_capacity == null ? '' : Number(props.form.registration_capacity)),
  // The draft keeps the capacity as text, like the number input does.
  set: value => { props.form.registration_capacity = value === '' ? '' : String(value) },
})
const unitLabel = unit => t(unit === 'pair' ? 'registrationRules.feeUnitPair' : unit === 'team' ? 'registrationRules.feeUnitTeam' : 'registrationRules.feeUnitPlayer')
</script>

<template>
  <div class="reg-rules-group" :class="{ 'reg-rules-group--plain': variant === 'plain' }">
  <fieldset class="reg-rules" :disabled="disabled">
    <legend :class="{ 'sr-only': variant === 'plain' || hideMainLegend }">{{ t('registrationRules.settingsTitle') }}</legend>

    <div class="grid-2">
      <div class="form-field">
        <span class="reg-rules__label">
          <label :for="`${idPrefix}-capacity`">{{ t('registrationRules.capacity') }}</label>
          <InfoTip :id="`${idPrefix}-capacity-hint`" :text="capacityHint" />
        </span>
        <select
          v-if="isDoubleElim"
          :id="`${idPrefix}-capacity`"
          v-model="capacityModel"
          class="input"
          :aria-describedby="`${idPrefix}-capacity-hint ${idPrefix}-capacity-de`"
        >
          <option value="">{{ t('registrationRules.capacityNone') }}</option>
          <option v-for="n in capacityOptions" :key="n" :value="n">{{ n }}</option>
        </select>
        <input
          v-else
          :id="`${idPrefix}-capacity`"
          v-model="form.registration_capacity"
          class="input"
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          :aria-describedby="`${idPrefix}-capacity-hint`"
        />
        <p v-if="isDoubleElim" :id="`${idPrefix}-capacity-de`" class="field-hint" :class="{ 'reg-rules__warn': capacityModel === '' }">
          {{ t(capacityModel === '' ? 'registrationRules.doubleElimNoCapacity' : 'registrationRules.doubleElimCapacity') }}
        </p>
      </div>

      <div class="form-field">
        <span class="reg-rules__label">
          <label :for="`${idPrefix}-deadline`">{{ t('registrationRules.deadlineField') }}</label>
          <InfoTip :id="`${idPrefix}-deadline-hint`" :text="t('registrationRules.deadlineHint')" />
        </span>
        <DateTimeField
          :id="`${idPrefix}-deadline`"
          v-model="form.registration_deadline"
          :aria-describedby="`${idPrefix}-deadline-hint`"
          :disabled="disabled"
          :teleport-to-dialog="teleportToDialog"
        />
      </div>
    </div>

    <label class="checkbox-row" :for="`${idPrefix}-capacity-public`">
      <input :id="`${idPrefix}-capacity-public`" v-model="form.capacity_public" type="checkbox" />
      {{ t('registrationRules.capacityPublic') }}
    </label>

    <div class="reg-rules__label">
      <label class="checkbox-row" :for="`${idPrefix}-waitlist`">
        <input :id="`${idPrefix}-waitlist`" v-model="form.waitlist_enabled" type="checkbox" :aria-describedby="`${idPrefix}-waitlist-hint`" />
        {{ t('registrationRules.waitlistSetting') }}
      </label>
      <InfoTip :id="`${idPrefix}-waitlist-hint`" :text="t('registrationRules.waitlistSettingHint')" />
    </div>

  </fieldset>

  <fieldset class="reg-rules" :disabled="disabled">
    <legend :class="{ eyebrow: variant === 'plain' }">{{ t('registrationRules.feeSection') }}</legend>
    <div class="grid-2">
      <div class="form-field">
        <label :for="`${idPrefix}-fee-mode`">{{ t('registrationRules.feeMode') }}</label>
        <select :id="`${idPrefix}-fee-mode`" v-model="form.entry_fee_mode" class="input">
          <option value="">{{ t('registrationRules.feeUnspecified') }}</option>
          <option value="free">{{ t('registrationRules.feeModeFree') }}</option>
          <option value="paid">{{ t('registrationRules.feeModePaid') }}</option>
        </select>
      </div>

      <div v-if="form.entry_fee_mode === 'paid'" class="form-field">
        <label :for="`${idPrefix}-fee-amount`">{{ t('registrationRules.feeAmount') }}</label>
        <div class="reg-rules__amount">
          <input
            :id="`${idPrefix}-fee-amount`"
            v-model="form.entry_fee_amount"
            class="input"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            placeholder="20"
            required
          />
          <select v-model="form.entry_fee_currency" class="input" :aria-label="t('registrationRules.feeCurrency')">
            <option v-for="currency in FEE_CURRENCIES" :key="currency" :value="currency">{{ currency }}</option>
          </select>
        </div>
      </div>
    </div>

    <div v-if="form.entry_fee_mode === 'paid'" class="form-field">
      <label :for="`${idPrefix}-fee-unit`">{{ t('registrationRules.feeUnit') }}</label>
      <select :id="`${idPrefix}-fee-unit`" v-model="unitValue" class="input">
        <option v-for="unit in feeUnits" :key="unit" :value="unit">{{ unitLabel(unit) }}</option>
      </select>
    </div>
  </fieldset>
  </div>
</template>

<style scoped>
.reg-rules__warn { color: var(--warning-text); }
.reg-rules-group { display: grid; gap: 16px; }
.reg-rules { margin: 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); display: grid; gap: 12px; }
.reg-rules legend { padding: 0 6px; font-weight: 750; }
.reg-rules-group--plain { gap: var(--space-5); }
.reg-rules-group--plain .reg-rules { padding: 0; border: 0; border-radius: 0; gap: var(--space-4); }
.reg-rules-group--plain .reg-rules legend { padding: 0; margin-bottom: var(--space-2); }
.reg-rules__label { display: flex; align-items: center; gap: 6px; }
.reg-rules__label > label { margin: 0; }
.reg-rules__amount { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 8px; }
.reg-rules__amount > * { min-width: 0; }
</style>
