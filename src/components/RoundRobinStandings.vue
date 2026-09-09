<script setup>
// Standings table for round-robin where every row expands into the player's
// schedule: opponents still to play on top, finished matches (with score) below.
import { computed, reactive, useId } from 'vue'
import { useI18n } from 'vue-i18n'

import { buildRoundRobinModel, entryLabelFor, orientScore } from '../lib/roundRobin'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  matches: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  family: { type: String, default: 'goals' },
  liveScoresByMatch: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['view-live'])

const { t } = useI18n()
const tableId = useId()

const expanded = reactive({})

const model = computed(() => buildRoundRobinModel(props.matches, props.entriesMap, props.rows))

const colCount = computed(() => (props.family === 'goals' ? 10 : 7))

function toggle(entryId) {
  expanded[entryId] = !expanded[entryId]
}

function label(entryId) {
  return entryLabelFor(props.entriesMap, entryId) || t('bracket.tbd')
}

function detailsFor(entryId) {
  const list = model.value.byEntry[entryId] || []
  const upcoming = []
  const played = []
  for (const m of list) {
    const opponentId = m.side_a_entry_id === entryId ? m.side_b_entry_id : m.side_a_entry_id
    const item = {
      match: m,
      opponentId,
      live: props.liveScoresByMatch[m.id]?.status === 'active',
      score: orientScore(m, entryId),
    }
    if (item.score.finished) {
      played.push(item)
    } else {
      upcoming.push(item)
    }
  }
  return { upcoming, played }
}

const columns = computed(() => props.family === 'goals'
  ? ['played', 'won', 'drawn', 'lost', 'for', 'against', 'diff', 'points']
  : ['played', 'won', 'lost', 'sets', 'points'])
</script>

<template>
  <div class="standings-wrap" tabindex="0" role="region" :aria-label="t('standings.title')">
    <table class="standings rr-standings">
      <caption class="sr-only">{{ t('standings.title') }}</caption>
      <thead>
        <tr>
          <th scope="col" class="standings__rank" :aria-label="t('a11y.rank')">#</th>
          <th scope="col" class="standings__team">{{ t('standings.team') }}</th>
          <th v-for="column in columns" :key="column" scope="col" :title="t(`a11y.stats.${column}`)" :aria-label="t(`a11y.stats.${column}`)">{{ t(`standings.${column}`) }}</th>
        </tr>
      </thead>
      <tbody>
        <template v-for="r in rows" :key="r.entry_id">
          <tr
            class="rr-standings__row"
            :class="{ 'rr-standings__row--open': expanded[r.entry_id] }"
          >
            <td class="standings__rank">{{ r.rank }}</td>
            <th scope="row" class="standings__team">
              <button type="button" class="rr-standings__team-cell" :aria-label="t('a11y.scheduleFor', { name: r.display_name })" :aria-expanded="Boolean(expanded[r.entry_id])" :aria-controls="expanded[r.entry_id] ? `${tableId}-${r.entry_id}` : undefined" @click="toggle(r.entry_id)">
                <svg
                  aria-hidden="true"
                  class="rr-standings__chevron"
                  :class="{ 'rr-standings__chevron--open': expanded[r.entry_id] }"
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
                {{ r.display_name }}
              </button>
            </th>
            <td>{{ r.played }}</td>
            <td>{{ r.won }}</td>
            <td v-if="family === 'goals'">{{ r.drawn }}</td>
            <td>{{ r.lost }}</td>
            <template v-if="family === 'goals'">
              <td>{{ r.score_for }}</td>
              <td>{{ r.score_against }}</td>
              <td>{{ r.diff }}</td>
            </template>
            <td v-else>{{ r.score_for }}:{{ r.score_against }}</td>
            <td><strong>{{ r.points }}</strong></td>
          </tr>

          <tr v-if="expanded[r.entry_id]" class="rr-standings__details-row">
            <td :colspan="colCount">
              <div :id="`${tableId}-${r.entry_id}`" class="rr-standings__details">
                <div v-if="detailsFor(r.entry_id).upcoming.length" class="rr-standings__group">
                  <h4 class="rr-standings__group-title">{{ t('standings.toPlay') }}</h4>
                  <ul class="rr-standings__list">
                    <li
                      v-for="item in detailsFor(r.entry_id).upcoming"
                      :key="item.match.id"
                      class="rr-standings__item"
                      :class="{ 'rr-standings__item--live': item.live }"
                    >
                      <button v-if="item.live" type="button" class="rr-standings__live-action" :aria-label="t('a11y.matchAction', { action: t('mobile.watchLive'), teamA: r.display_name, teamB: label(item.opponentId) })" @click="emit('view-live', item.match)">
                        <span class="rr-standings__opponent">{{ label(item.opponentId) }}</span>
                        <span class="rr-live-badge"><span class="live-dot"></span>{{ t('live.live') }}</span>
                      </button>
                      <span v-else class="rr-standings__opponent">{{ label(item.opponentId) }}</span>
                    </li>
                  </ul>
                </div>

                <div v-if="detailsFor(r.entry_id).played.length" class="rr-standings__group">
                  <h4 class="rr-standings__group-title">{{ t('standings.playedList') }}</h4>
                  <ul class="rr-standings__list">
                    <li
                      v-for="item in detailsFor(r.entry_id).played"
                      :key="item.match.id"
                      class="rr-standings__item"
                    >
                      <span class="rr-standings__opponent">{{ label(item.opponentId) }}</span>
                      <span class="rr-standings__score" :class="{ 'rr-standings__score--won': item.score.won }">
                        {{ item.score.a }}:{{ item.score.b }}<span
                          v-if="family === 'goals' && item.score.pa != null && item.score.pb != null"
                          class="rr-standings__pens"
                          :title="t('football.pens')"
                        >({{ item.score.pa }}:{{ item.score.pb }})</span>
                      </span>
                    </li>
                  </ul>
                </div>

                <p v-if="!detailsFor(r.entry_id).upcoming.length && !detailsFor(r.entry_id).played.length" class="muted">
                  {{ t('bracket.empty') }}
                </p>
              </div>
            </td>
          </tr>
        </template>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.standings-wrap {
  overflow-x: auto;
}
.standings {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-sm, 0.9rem);
}
.standings th,
.standings td {
  padding: 10px 10px;
  text-align: center;
  border-bottom: 1px solid var(--border);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.standings thead th {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--muted);
}
.standings__rank {
  width: 2rem;
  font-family: var(--font-mono);
  color: var(--muted);
}
.standings .standings__team {
  text-align: left;
  font-weight: 600;
  color: var(--text);
}
.standings td strong {
  color: var(--primary);
  font-family: var(--font-mono);
}

.rr-standings__row {
  transition: background 0.12s;
}
.rr-standings__row:hover,
.rr-standings__row--open {
  background: var(--surface-hover);
}
.rr-standings__team-cell {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-height: 44px;
  padding: 4px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.rr-standings__live-action { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 44px; width: 100%; padding: 6px 8px; border: 0; border-radius: 6px; background: transparent; color: inherit; font: inherit; cursor: pointer; }
.rr-standings__chevron {
  flex-shrink: 0;
  color: var(--muted);
  transition: transform 0.15s;
}
.rr-standings__chevron--open {
  transform: rotate(90deg);
}

.rr-standings__details-row td {
  padding: 0;
  background: var(--surface-row);
}
.rr-standings__details {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-width: 420px;
  padding: var(--space-3) var(--space-4) var(--space-4);
}
.rr-standings__group-title {
  margin: 0 0 6px;
  font-family: var(--font-mono);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}
.rr-standings__list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.rr-standings__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: 6px 8px;
  border-radius: var(--radius-sm, 6px);
  white-space: nowrap;
}
.rr-standings__item--live {
  cursor: pointer;
}
.rr-standings__item--live:hover {
  background: var(--surface-hover);
}
.rr-standings__opponent {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: left;
}
.rr-standings__score {
  font-family: var(--font-mono);
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.rr-standings__score--won {
  color: var(--success-text);
  font-weight: 600;
}
.rr-standings__pens {
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
