<script setup>
import { inject } from 'vue'
import { useI18n } from 'vue-i18n'
import StandingsTable from './StandingsTable.vue'
import { entryDisplayNames } from '../lib/entryDisplay'
import { formatSetScore } from '../lib/tennisRules'
import { normalizeTennisState, pointLabel, scoreLine } from '../lib/useTennisScoring'
import { scheduleSummary } from '../lib/schedule'
import { roundInGroup } from '../lib/groupsFlow'
import { completedSetCount } from '../lib/bracketDisplay'

const props = defineProps({
  groups: { type: Array, default: () => [] }, // [{ id, name, standings, rounds }]
  entriesMap: { type: Object, default: () => ({}) },
  family: { type: String, default: 'goals' },
  setsByMatch: { type: Object, default: () => ({}) },
  liveScoresByMatch: { type: Object, default: () => ({}) },
})
const emit = defineEmits(['view-live'])
const { t, locale } = useI18n()

// Provided by the tournament views: published rows for spectators, the draft
// for organizers — the same court and time the bracket cards show.
const scheduleView = inject('matchScheduleView', null)
function scheduleLine(m) {
  const view = scheduleView?.value
  const row = view?.byMatch?.[m.id]
  return row ? scheduleSummary(row, { courtsById: view.courtsById, t, locale: locale.value, timeZone: view.timeZone }) : ''
}
const scheduleIsDraft = m => Boolean(scheduleView?.value?.draftIds?.has(m.id))

function name(id) {
  const names = entryDisplayNames(props.entriesMap[id])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}
const sets = m => [...(props.setsByMatch[m.id] || [])].sort((a, b) => a.set_index - b.set_index)
const isLive = m => props.liveScoresByMatch[m.id]?.status === 'active'
const liveState = m => props.liveScoresByMatch[m.id]?.state
const winnerSide = m => (m.winner_entry_id && m.winner_entry_id === m.side_a_entry_id ? 'a'
  : m.winner_entry_id && m.winner_entry_id === m.side_b_entry_id ? 'b' : null)
// Per-set games for one side, the way a score sheet reads; a won set is marked.
// A live match reads from the live state: finished sets, then the current set's games.
function sideGames(m, side) {
  if (isLive(m)) {
    const live = normalizeTennisState(liveState(m))
    const other = side === 'a' ? 'b' : 'a'
    return [
      ...live.sets.map((s, i) => ({ key: `l${i}`, value: s[`side_${side}_games`], won: Number(s[`side_${side}_games`]) > Number(s[`side_${other}_games`]) })),
      { key: 'current', value: live.isMatchTiebreak ? live.tiebreakPoints?.[side] ?? 0 : live.games[side], current: true },
    ]
  }
  const completed = completedSetCount(m)
  return sets(m).map((s, i) => ({
    key: s.set_index,
    value: s.score_kind === 'match_tiebreak' ? s[`side_${side}_tiebreak`] : s[`side_${side}_games`],
    // A set left open by a stopped live match is the current one, not a won set.
    current: i >= completed,
    won: i < completed && (s.score_kind === 'match_tiebreak'
      ? Number(s[`side_${side}_tiebreak`]) > Number(s[`side_${side === 'a' ? 'b' : 'a'}_tiebreak`])
      : Number(s[`side_${side}_games`]) > Number(s[`side_${side === 'a' ? 'b' : 'a'}_games`])),
  }))
}
const hasDetails = m => props.family !== 'goals' && (sets(m).length > 0 || isLive(m))
const liveCount = g => g.rounds.reduce((n, r) => n + r.list.filter(isLive).length, 0)
</script>

<template>
  <div class="group-board">
    <section v-for="g in groups" :key="g.id" class="card stack stack--sm group-board__group">
      <h3 class="section-title group-board__title">
        {{ t('admin.group') }} {{ g.name }}
        <span v-if="liveCount(g)" class="gs-live-badge"><span class="live-dot" aria-hidden="true" />{{ t('live.live') }} · {{ liveCount(g) }}</span>
      </h3>

      <StandingsTable :rows="g.standings" :family="family" />

      <div v-if="g.rounds.length" class="group-board__fixtures">
        <div v-for="grp in g.rounds" :key="grp.round" class="gs-round">
          <h4 class="gs-round__title">{{ t('bracket.tourN', { n: roundInGroup(grp.round) }) }}</h4>
          <ul class="gs-list">
            <li
              v-for="m in grp.list"
              :key="m.id"
              class="gs-match"
              :class="{ 'gs-match--live': isLive(m), 'gs-match--done': m.status === 'finished' }"
            >
              <component
                :is="isLive(m) ? 'button' : 'div'"
                :type="isLive(m) ? 'button' : undefined"
                class="gs-match__body"
                :tabindex="!isLive(m) && hasDetails(m) ? 0 : undefined"
                :aria-label="isLive(m) ? t('a11y.matchAction', { action: t('mobile.watchLive'), teamA: name(m.side_a_entry_id), teamB: name(m.side_b_entry_id) }) : undefined"
                @click="isLive(m) && emit('view-live', m)"
              >
                <span v-for="side in ['a', 'b']" :key="side" class="gs-side" :class="{ 'gs-side--won': winnerSide(m) === side }">
                  <span class="gs-side__name">{{ name(m[`side_${side}_entry_id`]) }}</span>
                  <span v-if="family !== 'goals'" class="gs-side__sets">
                    <span v-for="s in sideGames(m, side)" :key="s.key" class="gs-set" :class="{ 'gs-set--won': s.won, 'gs-set--current': s.current }">{{ s.value }}</span>
                    <span v-if="isLive(m)" class="gs-set gs-set--point">{{ pointLabel(liveState(m), side) }}</span>
                  </span>
                  <span v-else-if="m.status === 'finished'" class="gs-side__sets"><span class="gs-set gs-set--won">{{ m[`side_${side}_score`] }}</span></span>
                </span>
                <span v-if="isLive(m) || m.status !== 'finished'" class="gs-match__status">
                  <span v-if="isLive(m)" class="gs-live-badge"><span class="live-dot" aria-hidden="true" />{{ t('live.live') }}</span>
                  <span v-else class="gs-match__pending">{{ t('tournament.notPlayed') }}</span>
                </span>
              </component>
              <p v-if="scheduleLine(m)" class="gs-match__schedule">
                <span aria-hidden="true">🕒</span>
                <span>{{ scheduleLine(m) }}</span>
                <span v-if="scheduleIsDraft(m)" class="badge badge--warn">{{ t('schedule.draft') }}</span>
              </p>

              <!-- Hover / focus card with the full score, tie-breaks included -->
              <div v-if="hasDetails(m)" class="gs-tip" role="tooltip">
                <p class="gs-tip__teams">{{ name(m.side_a_entry_id) }} — {{ name(m.side_b_entry_id) }}</p>
                <ul class="gs-tip__sets">
                  <li v-for="s in sets(m)" :key="s.set_index">
                    <span class="gs-tip__label">{{ t('bracket.setOne', { n: s.set_index }) }}</span>
                    <span class="gs-tip__value">{{ formatSetScore(s) }}</span>
                  </li>
                  <li v-if="isLive(m)">
                    <span class="gs-tip__label">{{ t('live.live') }}</span>
                    <span class="gs-tip__value">{{ scoreLine(liveState(m)) }} · {{ pointLabel(liveState(m), 'a') }}:{{ pointLabel(liveState(m), 'b') }}</span>
                  </li>
                </ul>
              </div>
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.group-board {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr));
  gap: var(--space-4, 16px);
}
.group-board__group { min-width: 0; gap: var(--space-4, 16px); }
.group-board__title { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.group-board__fixtures { display: grid; gap: var(--space-4, 16px); }

.gs-round { display: grid; gap: 8px; }
.gs-round__title {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.gs-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }

.gs-match { position: relative; }
.gs-match__body {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  grid-template-rows: auto auto;
  column-gap: 14px;
  row-gap: 6px;
  align-items: center;
  width: 100%;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 10px);
  background: var(--surface-row);
  color: inherit;
  font: inherit;
  text-align: left;
}
button.gs-match__body { cursor: pointer; }
.gs-match__body:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.gs-match--live .gs-match__body { border-color: var(--primary); box-shadow: var(--live-glow); }

.gs-side {
  grid-column: 1;
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  color: var(--muted);
}
.gs-match--done .gs-side--won, .gs-match--live .gs-side { color: var(--text); }
.gs-match:not(.gs-match--done) .gs-side { color: var(--text); }
.gs-side--won .gs-side__name { font-weight: 600; }
.gs-side__name { min-width: 0; overflow-wrap: anywhere; line-height: 1.35; }
.gs-side__sets { display: inline-flex; gap: 6px; flex-shrink: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.gs-set { min-width: 1.1em; text-align: center; color: var(--muted); }
.gs-set--won { color: var(--text); font-weight: 700; }
.gs-set--current { color: var(--text); }
.gs-set--point { color: var(--primary); font-weight: 700; }

.gs-match__schedule {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 6px 2px 0;
  font-size: 0.8rem;
  color: var(--muted);
  overflow-wrap: anywhere;
}
.gs-match__status { grid-column: 2; grid-row: 1 / span 2; justify-self: end; }
.gs-match__pending { font-size: 0.8125rem; color: var(--muted); }

.gs-live-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  border-radius: 999px;
  background: var(--success-bg);
  color: var(--success-text);
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.gs-tip {
  position: absolute;
  z-index: 5;
  left: 14px;
  right: 14px;
  top: calc(100% + 6px);
  display: grid;
  gap: 8px;
  padding: 12px 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm, 10px);
  background: var(--surface-raised);
  box-shadow: var(--shadow-lg);
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition: opacity 0.15s, transform 0.15s, visibility 0.15s;
  pointer-events: none;
}
.gs-match:hover .gs-tip,
.gs-match:focus-within .gs-tip { opacity: 1; visibility: visible; transform: none; }
.gs-tip__teams { margin: 0; font-size: 0.8125rem; font-weight: 600; color: var(--text); }
.gs-tip__sets { display: grid; gap: 4px; margin: 0; padding: 0; list-style: none; font-size: 0.8125rem; }
.gs-tip__sets li { display: flex; justify-content: space-between; gap: 12px; }
.gs-tip__label { color: var(--muted); }
.gs-tip__value { font-family: var(--font-mono); color: var(--text); font-variant-numeric: tabular-nums; }
@media (hover: none) { .gs-tip { display: none; } }
@media (prefers-reduced-motion: reduce) { .gs-tip { transition: none; } }
</style>
