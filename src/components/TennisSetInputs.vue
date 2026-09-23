<script setup>
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ruleForSet } from '../lib/tennisRules'
const props = defineProps({
  modelValue: { type: Array, required: true }, scoringConfig: { type: Object, default: () => ({}) },
  setFormat: { type: String, default: 'best_of_3' }, teamA: String, teamB: String, disabled: Boolean,
  idPrefix: { type: String, required: true },
  // 'cards' — one fieldset per set (modal); 'board' — a scoreboard grid, players × sets.
  variant: { type: String, default: 'cards' },
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()
const rule = row => ruleForSet(props.scoringConfig, row.set_index, props.setFormat)
const matchTb = row => rule(row).kind === 'match_tiebreak'
const tbVisible = row => {
  const at = rule(row).at
  return !matchTb(row) && (row.side_a_tiebreak !== '' || row.side_b_tiebreak !== '' ||
    (at !== null && row.side_a_games !== '' && row.side_b_games !== '' &&
      Number(row.side_a_games) >= at && Number(row.side_b_games) >= at))
}
// Edits build on the last emitted rows: two inputs in one tick (auto-advance,
// paste) would otherwise both start from the same stale prop and undo each other.
let latest = props.modelValue
watch(() => props.modelValue, (rows) => { latest = rows })
function change(row, key, value) {
  latest = latest.map(r => r.set_index === row.set_index ? { ...r, [key]: value } : r)
  emit('update:modelValue', latest)
}
// Board: winner of each set by games (or match-tiebreak points), for highlighting.
const main = row => (matchTb(row) ? 'tiebreak' : 'games')
function setWinner(row) {
  const a = row[`side_a_${main(row)}`], b = row[`side_b_${main(row)}`]
  if (a === '' || b === '' || a == null || b == null || Number(a) === Number(b)) return null
  return Number(a) > Number(b) ? 'a' : 'b'
}
const setsWon = side => props.modelValue.filter(row => setWinner(row) === side).length
// A games value is one digit whenever the set has a tiebreak cap, so the cursor
// can move on by itself — set by set, the way a score sheet is read.
const root = ref(null)
function advance(event, row) {
  if (matchTb(row) || rule(row).at === null) return
  const value = event.target.value
  if (!/^\d$/.test(value)) return
  const fields = [...(root.value?.querySelectorAll('input[data-games]') || [])]
  const next = fields[fields.indexOf(event.target) + 1]
  next?.focus()
  next?.select()
}
const label = (row, side, tb = false) => `${t('live.setN', { n: row.set_index })}, ${side === 'a' ? props.teamA : props.teamB}, ${t(tb || matchTb(row) ? 'tennisRules.tiebreakPoints' : 'tennisRules.games')}`
</script>

<template>
  <div v-if="variant === 'board'" ref="root" class="set-board" :style="{ '--sets': modelValue.length }">
    <span class="set-board__corner" aria-hidden="true" />
    <span
      v-for="row in modelValue"
      :key="`h-${row.set_index}`"
      class="set-board__head"
      :style="{ gridColumn: row.set_index + 1 }"
      :title="matchTb(row) ? t('tennisRules.pointsTo', { to: rule(row).target }) : undefined"
    >{{ matchTb(row) ? t('tennisRules.matchTiebreakShort') : row.set_index }}</span>

    <span
      v-for="side in ['a', 'b']"
      :key="`n-${side}`"
      class="set-board__name"
      :class="{ 'is-leading': setsWon(side) > setsWon(side === 'a' ? 'b' : 'a') }"
      :style="{ gridRow: side === 'a' ? 2 : 3 }"
    >
      <span class="set-board__name-text">{{ side === 'a' ? teamA : teamB }}</span>
      <span v-if="setsWon('a') + setsWon('b')" class="set-board__won">{{ setsWon(side) }}</span>
    </span>

    <!-- Set-major DOM order: Tab walks A1, B1, A2, B2… -->
    <template v-for="row in modelValue" :key="`c-${row.set_index}`">
      <span
        v-for="side in ['a', 'b']"
        :key="`${row.set_index}-${side}`"
        class="set-board__cell"
        :class="{ 'is-won': setWinner(row) === side, 'is-lost': setWinner(row) && setWinner(row) !== side, 'has-tb': tbVisible(row) }"
        :style="{ gridColumn: row.set_index + 1, gridRow: side === 'a' ? 2 : 3 }"
      >
        <input
          :id="`${idPrefix}-${row.set_index}-${side}`"
          class="set-board__input"
          type="number" min="0" step="1" inputmode="numeric"
          data-games
          :max="matchTb(row) || rule(row).at === null ? undefined : rule(row).at + 1"
          :aria-label="label(row, side)" placeholder="–"
          :disabled="disabled"
          :value="row[`side_${side}_${main(row)}`]"
          @input="change(row, `side_${side}_${main(row)}`, $event.target.value); advance($event, row)"
          @focus="$event.target.select()"
        />
        <input
          v-if="tbVisible(row)"
          :id="`${idPrefix}-${row.set_index}-tb-${side}`"
          class="set-board__tb"
          type="number" min="0" step="1" inputmode="numeric"
          :max="rule(row).margin === 1 ? rule(row).target : undefined"
          :aria-label="label(row, side, true)" :title="t('tennisRules.tbOptional', { to: rule(row).target })" placeholder="tb"
          :disabled="disabled"
          :value="row[`side_${side}_tiebreak`]"
          @input="change(row, `side_${side}_tiebreak`, $event.target.value)"
          @focus="$event.target.select()"
        />
      </span>
    </template>
  </div>

  <div v-else class="tennis-set-inputs">
    <fieldset v-for="row in modelValue" :key="row.set_index" class="tennis-set" :disabled="disabled">
      <legend>{{ matchTb(row) ? t('tennisRules.matchTiebreak') : t('live.setN', { n: row.set_index }) }}</legend>
      <p class="tennis-set__hint muted">{{ matchTb(row) ? t('tennisRules.pointsTo', { to: rule(row).target }) : t('tennisRules.games') }}</p>
      <div v-for="side in ['a', 'b']" :key="side" class="tennis-set__row">
        <label :for="`${idPrefix}-${row.set_index}-${side}`">{{ side === 'a' ? teamA : teamB }}</label>
        <input :id="`${idPrefix}-${row.set_index}-${side}`" class="input" type="number" min="0" step="1" inputmode="numeric"
          :max="matchTb(row) || rule(row).at === null ? undefined : rule(row).at + 1"
          :aria-label="label(row, side)" placeholder="—"
          :value="row[`side_${side}_${matchTb(row) ? 'tiebreak' : 'games'}`]"
          @input="change(row, `side_${side}_${matchTb(row) ? 'tiebreak' : 'games'}`, $event.target.value)" />
      </div>
      <template v-if="tbVisible(row)">
        <p class="tennis-set__hint muted">{{ t('tennisRules.tbOptional', { to: rule(row).target }) }}</p>
        <div v-for="side in ['a', 'b']" :key="`tb-${side}`" class="tennis-set__row">
          <label :for="`${idPrefix}-${row.set_index}-tb-${side}`">{{ side === 'a' ? teamA : teamB }}</label>
          <input :id="`${idPrefix}-${row.set_index}-tb-${side}`" class="input" type="number" min="0" step="1" inputmode="numeric"
            :max="rule(row).margin === 1 ? rule(row).target : undefined" :aria-label="label(row, side, true)" placeholder="—"
            :value="row[`side_${side}_tiebreak`]" @input="change(row, `side_${side}_tiebreak`, $event.target.value)" />
        </div>
      </template>
    </fieldset>
  </div>
</template>

<style scoped>
/* Scoreboard: players down, sets across. */
.set-board {
  display: grid; grid-template-columns: minmax(0, 1fr) repeat(var(--sets), auto);
  grid-template-rows: auto auto auto; column-gap: 6px; row-gap: 6px; align-items: center;
}
.set-board__corner { grid-column: 1; grid-row: 1; }
.set-board__head {
  grid-row: 1; justify-self: center; min-width: 52px; text-align: center;
  font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted);
}
.set-board__name { grid-column: 1; display: flex; align-items: center; gap: 8px; min-width: 0; padding-right: 8px; }
.set-board__name-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; color: var(--text); }
.set-board__name.is-leading .set-board__name-text { color: var(--heading); }
.set-board__won {
  flex: none; display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; border-radius: 6px;
  background: var(--disabled-bg); color: var(--muted); font-family: var(--font-mono); font-size: 0.75rem; font-weight: 600;
}
.set-board__name.is-leading .set-board__won { background: var(--primary); color: var(--primary-contrast); }
.set-board__cell { position: relative; display: inline-flex; align-items: center; gap: 4px; justify-self: center; }
.set-board__input, .set-board__tb {
  box-sizing: border-box; margin: 0; border: 1px solid var(--border-strong); background: var(--input-bg); color: var(--text);
  text-align: center; font-family: var(--font-mono); font-variant-numeric: tabular-nums;
  -moz-appearance: textfield; appearance: textfield;
  transition: border-color 0.15s, background 0.15s, color 0.15s, box-shadow 0.15s;
}
.set-board__input::-webkit-outer-spin-button, .set-board__input::-webkit-inner-spin-button,
.set-board__tb::-webkit-outer-spin-button, .set-board__tb::-webkit-inner-spin-button { -webkit-appearance: none; margin: 0; }
.set-board__input { width: 52px; height: 44px; border-radius: 10px; font-size: 1.125rem; font-weight: 600; }
.set-board__tb { width: 34px; height: 28px; border-radius: 7px; font-size: 0.75rem; color: var(--muted); align-self: flex-start; }
.set-board__input::placeholder, .set-board__tb::placeholder { color: var(--disabled); font-weight: 500; }
.set-board__input:hover:not(:disabled), .set-board__tb:hover:not(:disabled) { border-color: var(--control-border); }
.set-board__input:focus, .set-board__tb:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-focus-ring); }
.set-board__cell.is-won .set-board__input { border-color: var(--primary); background: var(--primary-soft); color: var(--heading); }
.set-board__cell.is-lost .set-board__input { color: var(--muted); }
.set-board__input:disabled, .set-board__tb:disabled { cursor: not-allowed; opacity: 0.6; }
@media (max-width: 420px) {
  .set-board__input { width: 44px; height: 42px; }
  .set-board__head { min-width: 44px; }
}

.tennis-set-inputs { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 190px), 1fr)); gap: 12px; margin: 12px 0; }
.tennis-set { min-width: 0; margin: 0; padding: 12px; border: 1px solid var(--border); border-radius: 10px; }
.tennis-set legend { font-weight: 600; font-size: .85rem; padding: 0 5px; }
.tennis-set__row { display: grid; grid-template-columns: minmax(0, 1fr) 64px; align-items: center; gap: 8px; margin: 7px 0; }
.tennis-set__row label { font-size: .8rem; overflow-wrap: anywhere; }
.tennis-set__row input { width: 64px; text-align: center; padding: 8px 4px; }
.tennis-set__hint { font-size: .75rem; line-height: 1.5; margin: 4px 0; }
</style>
