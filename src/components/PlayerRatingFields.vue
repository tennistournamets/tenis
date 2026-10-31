<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from './AppIcon.vue'
import { PADEL_LEVELS, newRatingRow, ratingTypesFor } from '../lib/playerRatings'

// One player's ratings on the public form: a kind from the list, the value,
// and "+" for one more row while kinds are left. `rows` is the caller's
// reactive array of { type, value }, edited in place.
const props = defineProps({
  rows: { type: Array, required: true },
  sport: { type: String, required: true },
  label: { type: String, required: true },
  idPrefix: { type: String, required: true },
  required: Boolean,
  disabled: Boolean,
  // The second player of a pair: the hint above already explains the rows.
  hideHint: Boolean,
})

const { t } = useI18n()
const kinds = computed(() => ratingTypesFor(props.sport))
const canAdd = computed(() => props.rows.length < kinds.value.length)
// A kind already picked in another row is not offered again.
const kindsFor = index => kinds.value.filter(type => type === props.rows[index].type || !props.rows.some(row => row.type === type))

function changeKind(row, type) {
  row.type = type
  row.value = ''
}

function add() {
  if (canAdd.value) props.rows.push(newRatingRow(props.sport, props.rows.map(row => row.type)))
}

function remove(index) {
  props.rows.splice(index, 1)
  if (!props.rows.length) props.rows.push(newRatingRow(props.sport))
}
</script>

<template>
  <fieldset class="rating-fields" :disabled="disabled" :aria-describedby="hideHint ? undefined : `${idPrefix}-hint`">
    <legend class="rating-fields__legend">
      {{ label }}
      <span v-if="required" class="rating-fields__req" aria-hidden="true">*</span>
    </legend>
    <div v-for="(row, index) in rows" :key="index" class="rating-fields__row">
      <select
        :id="`${idPrefix}-type-${index}`"
        class="input"
        :value="row.type"
        :aria-label="t('playerRating.kind')"
        @change="changeKind(row, $event.target.value)"
      >
        <option v-for="type in kindsFor(index)" :key="type" :value="type">{{ t(`playerRating.kinds.${type}`) }}</option>
      </select>
      <select
        v-if="row.type === 'padel_level'"
        v-model="row.value"
        class="input"
        :aria-label="t('playerRating.value')"
      >
        <option value="">{{ t('playerRating.levelPlaceholder') }}</option>
        <option v-for="[letter, level] in PADEL_LEVELS" :key="letter" :value="String(level)">{{ letter }} · {{ level.toFixed(1) }}</option>
      </select>
      <input
        v-else
        v-model="row.value"
        class="input"
        type="text"
        :inputmode="row.type === 'tnl' ? 'decimal' : 'numeric'"
        autocomplete="off"
        maxlength="7"
        :placeholder="t(`playerRating.placeholders.${row.type}`)"
        :aria-label="t('playerRating.value')"
      />
      <button
        v-if="rows.length > 1 || row.value !== ''"
        class="btn btn--ghost btn--icon"
        type="button"
        :aria-label="t('playerRating.remove')"
        :title="t('playerRating.remove')"
        @click="remove(index)"
      >
        <AppIcon name="close" :size="18" />
      </button>
    </div>
    <button v-if="canAdd" class="btn btn--ghost btn--sm rating-fields__add" type="button" @click="add">+ {{ t('playerRating.add') }}</button>
    <p v-if="!hideHint" :id="`${idPrefix}-hint`" class="field-hint rating-fields__hint">{{ t(required ? 'playerRating.hintRequired' : 'playerRating.hint') }}</p>
  </fieldset>
</template>

<style scoped>
.rating-fields { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: 8px; }
.rating-fields__legend { padding: 0; margin-bottom: 6px; font-weight: 600; font-size: 0.875rem; }
.rating-fields__req { color: var(--danger); font-weight: 600; }
.rating-fields__row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr) var(--touch-min); gap: 8px; align-items: center; }
.rating-fields__row > * { min-width: 0; }
.rating-fields__add { justify-self: start; }
.rating-fields__hint { margin: 0; }
</style>
