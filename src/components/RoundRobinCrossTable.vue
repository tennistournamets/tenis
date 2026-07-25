<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { buildRoundRobinModel, clickTarget, entryLabelFor, orientScore, pairMatches } from '../lib/roundRobin'

const props = defineProps({
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  standings: { type: Array, default: () => [] },
  family: { type: String, default: 'goals' },
  clickable: { type: Boolean, default: false },
  liveScoresByMatch: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['select-match', 'view-live'])

const { t } = useI18n()

const model = computed(() => buildRoundRobinModel(props.matches, props.entriesMap, props.standings))

function label(entryId) {
  return entryLabelFor(props.entriesMap, entryId) || t('bracket.tbd')
}

// Column header: surname(s) only — "Алексей Смирнов" → "Смирнов", pairs → "Смирнов/Иванов".
function shortLabel(entryId) {
  const full = label(entryId)
  return full
    .split(' / ')
    .map((part) => part.trim().split(/\s+/).pop())
    .join('/')
}

function cell(rowId, colId) {
  const list = pairMatches(model.value, rowId, colId)
  const results = list
    .filter((m) => m.status === 'finished')
    .map((m) => orientScore(m, rowId))
  const target = clickTarget(list)
  const live = list.find((m) => props.liveScoresByMatch[m.id]?.status === 'active') || null
  return {
    results,
    target,
    live,
    won: results.length > 0 && results.every((r) => r.won),
  }
}

function onCell(rowId, colId) {
  const { live, target } = cell(rowId, colId)
  if (live) {
    emit('view-live', live)
    return
  }
  if (!props.clickable) return
  if (target) emit('select-match', target)
}
</script>

<template>
  <div class="rr-cross-wrap">
    <table class="rr-cross">
      <thead>
        <tr>
          <th class="rr-cross__name-col">{{ t('standings.team') }}</th>
          <th
            v-for="colId in model.participants"
            :key="colId"
            class="rr-cross__num"
          >
            <span class="tooltip-wrapper rr-cross__head-tip" :data-tooltip="label(colId)" tabindex="0">
              <span class="rr-cross__head-name">{{ shortLabel(colId) }}</span>
            </span>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="(rowId, ri) in model.participants" :key="rowId">
          <td class="rr-cross__name-col">
            <span class="rr-cross__rank">{{ ri + 1 }}.</span> {{ label(rowId) }}
          </td>
          <td
            v-for="colId in model.participants"
            :key="colId"
            class="rr-cross__cell"
            :class="{ 'rr-cross__cell--self': colId === rowId }"
          >
            <template v-if="colId === rowId">
              <span class="rr-cross__self">×</span>
            </template>
            <template v-else>
              <component
                :is="cell(rowId, colId).live || (clickable && cell(rowId, colId).target) ? 'button' : 'span'"
                :type="cell(rowId, colId).live || (clickable && cell(rowId, colId).target) ? 'button' : undefined"
                class="rr-cross__result"
                :class="{
                  'rr-cross__result--btn': cell(rowId, colId).live || (clickable && cell(rowId, colId).target),
                  'rr-cross__result--won': cell(rowId, colId).won,
                }"
                @click="onCell(rowId, colId)"
              >
                <span v-if="cell(rowId, colId).live" class="rr-live-badge">
                  <span class="live-dot"></span>{{ t('live.live') }}
                </span>
                <template v-else-if="cell(rowId, colId).results.length">
                  <span v-for="(r, idx) in cell(rowId, colId).results" :key="idx" class="rr-cross__score">
                    {{ r.a }}:{{ r.b }}<span
                      v-if="family === 'goals' && r.pa != null && r.pb != null"
                      class="rr-cross__pens"
                      :title="t('football.pens')"
                    >({{ r.pa }}:{{ r.pb }})</span>
                  </span>
                </template>
                <template v-else>—</template>
              </component>
            </template>
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.rr-cross-wrap {
  overflow-x: auto;
}
.rr-cross {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-sm, 0.9rem);
}
.rr-cross th,
.rr-cross td {
  padding: 8px 10px;
  text-align: center;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.rr-cross th {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
/* Hover: only the hovered cell lights up (via the full-size button) plus the row's name.
   :not(:hover) keeps the name cell itself inert — hovering it is not an action.
   Same color as the cell hover so the pair reads as one highlight. */
.rr-cross tbody tr:hover .rr-cross__name-col:not(:hover) {
  background: var(--primary-muted, var(--surface-hover));
}
/* width: 1% + nowrap = shrink-to-fit: column hugs the longest name (capped at 260px) */
.rr-cross .rr-cross__name-col {
  text-align: left;
  font-weight: 600;
  color: var(--text);
  width: 1%;
  max-width: 260px;
  padding: 8px 24px 8px 10px;
  overflow: hidden;
  text-overflow: ellipsis;
}
.rr-cross__rank {
  font-family: var(--font-mono);
  font-weight: 400;
  color: var(--muted);
}
.rr-cross th.rr-cross__num {
  min-width: 3em;
  padding-left: 2px;
  padding-right: 2px;
}
.rr-cross__head-tip {
  display: inline-block;
  max-width: 100%;
  cursor: default;
  outline: none;
}
.rr-cross__head-name {
  display: inline-block;
  max-width: 14ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
.rr-cross__cell {
  padding: 0;
  /* definite height so the inner button can stretch to 100% of the cell */
  height: 1px;
}
.rr-cross__cell--self {
  background: var(--surface-row);
}
.rr-cross__self {
  display: block;
  padding: 10px 6px;
  color: var(--muted);
}
/* The result element fills the whole cell so the entire cell is the click target */
.rr-cross__result {
  display: flex;
  flex-direction: column;
  gap: 2px;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font: inherit;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  background: none;
  border: 0;
  padding: 10px 4px;
  border-radius: 0;
}
.rr-cross__result--won {
  color: var(--success-text);
  font-weight: 600;
}
.rr-cross__result--btn {
  cursor: pointer;
  transition: color 0.12s;
}
/* Highlight the WHOLE cell (not just the button) when it is actionable */
.rr-cross__cell:has(.rr-cross__result--btn):hover {
  background: var(--primary-muted, var(--surface-hover));
}
.rr-cross__cell:has(.rr-cross__result--btn):hover .rr-cross__result {
  color: var(--text);
}
.rr-cross__pens {
  margin-left: 3px;
  font-size: 0.75em;
  color: var(--muted);
}
.rr-live-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 0.68rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  color: var(--success-text);
}
</style>
