<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { FEE_CURRENCIES, FEE_UNITS, feeUnitDefault } from '../../lib/registrationRules'

// Shared by the settings form and the create wizard. `form` is the caller's
// reactive draft; its registration keys are edited in place.
const props = defineProps({
  form: { type: Object, required: true },
  tournament: { type: Object, default: null },
  disabled: Boolean,
  idPrefix: { type: String, default: 'reg' },
})

const { t } = useI18n()
const countsPlayers = computed(() => props.tournament?.category === 'doubles' && props.tournament?.doubles_pairing_mode === 'pick_random')
const unitValue = computed({
  get: () => props.form.entry_fee_unit || feeUnitDefault(props.tournament),
  set: value => { props.form.entry_fee_unit = value },
})
const unitLabel = unit => t(unit === 'pair' ? 'registrationRules.feeUnitPair' : unit === 'team' ? 'registrationRules.feeUnitTeam' : 'registrationRules.feeUnitPlayer')
</script>

<template>
  <fieldset class="reg-rules" :disabled="disabled">
    <legend>{{ t('registrationRules.settingsTitle') }}</legend>

    <div class="grid-2">
      <div class="form-field">
        <label :for="`${idPrefix}-capacity`">{{ t('registrationRules.capacity') }}</label>
        <input
          :id="`${idPrefix}-capacity`"
          v-model="form.registration_capacity"
          class="input"
          type="number"
          inputmode="numeric"
          min="1"
          step="1"
          :aria-describedby="`${idPrefix}-capacity-hint`"
        />
        <p :id="`${idPrefix}-capacity-hint`" class="muted reg-rules__hint">
          {{ t('registrationRules.capacityHint') }}
          <template v-if="countsPlayers"> {{ t('registrationRules.capacityPlayersHint') }}</template>
        </p>
      </div>

      <div class="form-field">
        <label :for="`${idPrefix}-deadline`">{{ t('registrationRules.deadlineField') }}</label>
        <input
          :id="`${idPrefix}-deadline`"
          v-model="form.registration_deadline"
          class="input"
          type="datetime-local"
          :aria-describedby="`${idPrefix}-deadline-hint`"
        />
        <p :id="`${idPrefix}-deadline-hint`" class="muted reg-rules__hint">{{ t('registrationRules.deadlineHint') }}</p>
      </div>
    </div>

    <label class="checkbox-row" :for="`${idPrefix}-capacity-public`">
      <input :id="`${idPrefix}-capacity-public`" v-model="form.capacity_public" type="checkbox" />
      {{ t('registrationRules.capacityPublic') }}
    </label>

    <div class="form-field">
      <label class="checkbox-row" :for="`${idPrefix}-waitlist`">
        <input :id="`${idPrefix}-waitlist`" v-model="form.waitlist_enabled" type="checkbox" :aria-describedby="`${idPrefix}-waitlist-hint`" />
        {{ t('registrationRules.waitlistSetting') }}
      </label>
      <p :id="`${idPrefix}-waitlist-hint`" class="muted reg-rules__hint">{{ t('registrationRules.waitlistSettingHint') }}</p>
    </div>

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
        <option v-for="unit in FEE_UNITS" :key="unit" :value="unit">{{ unitLabel(unit) }}</option>
      </select>
    </div>
  </fieldset>
</template>

<style scoped>
.reg-rules { margin: 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); display: grid; gap: 12px; }
.reg-rules legend { padding: 0 6px; font-weight: 750; }
.reg-rules__hint { margin: 4px 0 0; font-size: 0.82rem; line-height: 1.4; }
.reg-rules__amount { display: grid; grid-template-columns: minmax(0, 1fr) 96px; gap: 8px; }
.reg-rules__amount > * { min-width: 0; }
</style>
