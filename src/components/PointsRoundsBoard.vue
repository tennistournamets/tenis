<script setup>
// Rounds of the padel points formats, shared by the admin and public pages:
// each round lists its courts (two players against two, or pair against pair
// in Team Americano), the score or the live count, and who rests. The round in
// play and the next one are open; the others fold away.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { entryDisplayNames, matchSideLabel, matchSidesReady } from '../lib/entryDisplay'
import { currentRound } from '../lib/pointsFormat'

const props = defineProps({
  rounds: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  format: { type: String, default: 'americano' },
  // King of the Court: the rounds planned before the start, shown as "round 3 of 6".
  plannedRounds: { type: Number, default: null },
  canEditFinal: { type: Boolean, default: false },
  canLiveScore: { type: Boolean, default: false },
})
const emit = defineEmits(['edit-result', 'view-live'])
const { t } = useI18n()

const current = computed(() => currentRound(props.rounds))
const openRounds = computed(() => {
  const index = props.rounds.indexOf(current.value)
  return new Set(props.rounds.slice(Math.max(0, index), index + 2).map(r => r.round))
})
const roundState = round => (round.finished ? 'played' : round === current.value ? 'current' : 'upcoming')
const roundStateLabel = round => t(`pointsFormat.round${{ played: 'Played', current: 'Current', upcoming: 'Upcoming' }[roundState(round)]}`)

const sidePlayers = (match, side) => [match[`side_${side}_entry_id`], match[`side_${side}2_entry_id`]]
  .filter(Boolean)
  .map(id => entryDisplayNames(props.entriesMap[id]).join(' / ') || t('bracket.tbd'))
const sideLabel = (match, side) => matchSideLabel(match, side, props.entriesMap, t('bracket.tbd'))
const restingNames = round => round.resting.map(id => entryDisplayNames(props.entriesMap[id]).join(' / ')).filter(Boolean).join(', ')

const live = match => props.liveScoresByMatch[match.id]
const isLive = match => live(match)?.status === 'active'
const liveScore = (match, side) => live(match)?.state?.points?.[side] ?? 0
const winnerSide = match => (match.status !== 'finished' || !match.winner_entry_id ? null
  : match.winner_entry_id === match.side_a_entry_id ? 'a' : 'b')
const courtLabel = match => t('pointsFormat.court', { n: match.match_number })

function matchAria(match) {
  return t('a11y.matchAction', {
    action: isLive(match) ? t('mobile.watchLive') : t('standings.matchScore'),
    teamA: sideLabel(match, 'a'),
    teamB: sideLabel(match, 'b'),
  })
}
</script>

<template>
  <div class="points-rounds">
    <p v-if="!rounds.length" class="muted">{{ t('pointsFormat.noRounds') }}</p>
    <details
      v-for="round in rounds"
      :key="round.round"
      class="points-round"
      :class="`points-round--${roundState(round)}`"
      :open="openRounds.has(round.round)"
    >
      <summary class="points-round__head">
        <svg class="points-round__chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>
        <h3 class="points-round__title">{{ plannedRounds ? t('pointsFormat.roundOf', { n: round.round, total: plannedRounds }) : t('bracket.roundN', { n: round.round }) }}</h3>
        <span class="points-round__state">{{ roundStateLabel(round) }}</span>
      </summary>

      <div class="points-round__courts">
        <article
          v-for="match in round.matches"
          :key="match.id"
          class="points-court"
          :class="{ 'points-court--live': isLive(match), 'points-court--done': match.status === 'finished', 'points-court--king': format === 'king_of_court' && match.match_number === 1 }"
          :data-match-id="match.id"
        >
          <header class="points-court__head">
            <span>{{ courtLabel(match) }}</span>
            <span v-if="isLive(match)" class="points-court__live"><span class="live-dot"></span>{{ t('live.live') }}</span>
          </header>
          <div class="points-court__body">
            <div class="points-court__side" :class="{ 'points-court__side--won': winnerSide(match) === 'a' }">
              <span v-for="(name, i) in sidePlayers(match, 'a')" :key="i">{{ name }}</span>
            </div>
            <div class="points-court__score" :aria-label="t('standings.matchScore')">
              <template v-if="isLive(match)">{{ liveScore(match, 'a') }} : {{ liveScore(match, 'b') }}</template>
              <template v-else-if="match.status === 'finished'">{{ match.side_a_score }} : {{ match.side_b_score }}</template>
              <template v-else>—</template>
            </div>
            <div class="points-court__side points-court__side--b" :class="{ 'points-court__side--won': winnerSide(match) === 'b' }">
              <span v-for="(name, i) in sidePlayers(match, 'b')" :key="i">{{ name }}</span>
            </div>
          </div>
          <footer v-if="matchSidesReady(match) && (isLive(match) || canEditFinal || canLiveScore)" class="points-court__actions">
            <button v-if="isLive(match)" type="button" class="btn btn--primary btn--sm" :aria-label="matchAria(match)" @click="emit('view-live', match)">
              {{ canLiveScore ? t('mobile.continueLive') : t('mobile.watchLive') }}
            </button>
            <button v-if="canEditFinal && !isLive(match)" type="button" class="btn btn--secondary btn--sm" @click="emit('edit-result', match)">
              {{ match.status === 'finished' ? t('mobile.correctResult') : t('mobile.enterResult') }}
            </button>
            <button v-if="canLiveScore && !isLive(match) && match.status !== 'finished'" type="button" class="btn btn--ghost btn--sm" @click="emit('view-live', match)">
              {{ t('live.start') }}
            </button>
          </footer>
        </article>
      </div>

      <p v-if="round.resting.length" class="points-round__rest">
        <strong>{{ t('pointsFormat.resting') }}:</strong> {{ restingNames(round) }}
      </p>
    </details>
  </div>
</template>

<style scoped>
.points-rounds { display: grid; gap: var(--space-3); }
.points-round { border: 1px solid var(--border); border-radius: var(--radius); background: var(--surface); }
.points-round--current { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-muted); }
.points-round__head { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-3); cursor: pointer; list-style: none; }
.points-round__head::-webkit-details-marker { display: none; }
.points-round__chevron { flex: none; color: var(--muted); transition: transform 0.15s; }
.points-round[open] .points-round__chevron { transform: rotate(90deg); }
.points-round__title { margin: 0; font-size: 1rem; }
.points-round__state { margin-left: auto; font-family: var(--font-mono); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.points-round--current .points-round__state { color: var(--primary); }
.points-round__courts { display: grid; gap: var(--space-2); padding: 0 var(--space-3) var(--space-3); }
.points-court { display: grid; gap: 8px; padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-row); container-type: inline-size; }
.points-court--live { border-color: #ef4444; }
.points-court--king .points-court__head span:first-child::before { content: '♛ '; color: var(--primary); }
.points-court__head { display: flex; align-items: center; justify-content: space-between; gap: 8px; font-family: var(--font-mono); font-size: 0.7rem; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.points-court__live { display: inline-flex; align-items: center; gap: 6px; color: #dc2626; }
.points-court__body { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: center; gap: var(--space-2); }
.points-court__side { display: grid; gap: 2px; min-width: 0; font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.points-court__side--b { text-align: right; }
.points-court__side--won { color: var(--primary); }
.points-court__score { min-width: 4.5rem; text-align: center; font-family: var(--font-mono); font-size: 1.15rem; font-weight: 700; font-variant-numeric: tabular-nums; }
.points-court--live .points-court__score { color: #b91c1c; }
/* Phone-width card: two names per side do not fit beside the score
   (Lithuanian surnames broke mid-word), so the sides stack around it. */
@container (max-width: 320px) {
  .points-court__body { grid-template-columns: minmax(0, 1fr); justify-items: center; gap: 4px; text-align: center; }
  .points-court__side, .points-court__side--b { text-align: center; }
  .points-court__score { min-width: 0; }
}
.points-court__actions { display: flex; flex-wrap: wrap; gap: 8px; }
.points-court__actions .btn { flex: 1 1 120px; }
.points-round__rest { margin: 0; padding: 0 var(--space-3) var(--space-3); font-size: 0.85rem; color: var(--muted); }
.points-round__rest strong { color: var(--text); font-weight: 600; }
@media (min-width: 721px) {
  .points-round__courts { grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); }
}
</style>
