<script setup>
// Points table of the padel points formats (get_points_standings): the sum of
// the points each player (or pair, in Team Americano) scored, plus half a
// match for every round of rest. Ties go to wins, draws, then the difference;
// King of the Court ranks by the last court first.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { isIndividualFormat } from '../lib/sportConfig'
import { restPoints } from '../lib/pointsFormat'

const props = defineProps({
  rows: { type: Array, default: () => [] },
  format: { type: String, default: 'americano' },
  // Points per match: a round of rest earns half of it.
  target: { type: Number, default: 24 },
})
const { t } = useI18n()

const kotc = computed(() => props.format === 'king_of_court')
const title = computed(() => t(isIndividualFormat(props.format) ? 'pointsFormat.playersTable' : 'pointsFormat.pairsTable'))
// The rest column appears once somebody has rested.
const hasRests = computed(() => props.rows.some(r => Number(r.rests) > 0))
const hasDraws = computed(() => props.rows.some(r => Number(r.drawn) > 0))
const compensationHint = computed(() => t('pointsFormat.compensationHint', { n: restPoints(props.target) }))
</script>

<template>
  <div class="standings-wrap" tabindex="0" role="region" :aria-label="title">
    <table class="standings points-standings">
      <caption class="sr-only">{{ title }}</caption>
      <thead>
        <tr>
          <th scope="col" class="standings__rank" :aria-label="t('a11y.rank')">#</th>
          <th scope="col" class="standings__team">{{ t(isIndividualFormat(format) ? 'pointsFormat.player' : 'pointsFormat.pair') }}</th>
          <th v-if="kotc" scope="col">{{ t('pointsFormat.courtColumn') }}</th>
          <th scope="col" :title="t('pointsFormat.playedFull')">{{ t('pointsFormat.played') }}</th>
          <th scope="col">{{ t('pointsFormat.won') }}</th>
          <th v-if="hasDraws" scope="col">{{ t('pointsFormat.drawn') }}</th>
          <th scope="col">{{ t('pointsFormat.lost') }}</th>
          <th scope="col">{{ t('pointsFormat.diff') }}</th>
          <th scope="col">{{ t('pointsFormat.pointsFor') }}</th>
          <th v-if="hasRests" scope="col" :title="compensationHint">{{ t('pointsFormat.compensation') }}</th>
          <th scope="col">{{ t('pointsFormat.total') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.entry_id" :class="{ 'points-standings__leader': r.rank === 1 && r.played > 0 }">
          <td class="standings__rank">{{ r.rank }}</td>
          <th scope="row" class="standings__team">{{ r.display_name }}</th>
          <td v-if="kotc">{{ r.court ?? '—' }}</td>
          <td>{{ r.played }}</td>
          <td>{{ r.won }}</td>
          <td v-if="hasDraws">{{ r.drawn }}</td>
          <td>{{ r.lost }}</td>
          <td>{{ r.diff > 0 ? `+${r.diff}` : r.diff }}</td>
          <td>{{ r.points_for }}</td>
          <td v-if="hasRests" class="muted">{{ r.compensation ? `+${r.compensation}` : '—' }}</td>
          <td><strong>{{ r.total }}</strong></td>
        </tr>
      </tbody>
    </table>
    <p class="points-standings__hint muted">{{ t(kotc ? 'pointsFormat.kotcHint' : 'pointsFormat.tiebreakHint') }}</p>
    <p v-if="hasRests" class="points-standings__hint muted">{{ compensationHint }}</p>
  </div>
</template>

<style scoped>
.standings-wrap { overflow-x: auto; }
.standings { width: 100%; border-collapse: collapse; font-size: var(--font-sm, 0.9rem); }
.standings th,
.standings td {
  padding: 10px 10px;
  text-align: center;
  border-bottom: 1px solid var(--border, #e5e7eb);
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
.standings tbody tr { transition: background 0.12s; }
.standings tbody tr:hover { background: var(--surface-hover); }
.standings__rank { width: 2rem; font-family: var(--font-mono); color: var(--muted); }
.standings .standings__team {
  text-align: left;
  font-weight: 600;
  color: var(--text);
  white-space: normal;
  overflow-wrap: anywhere;
  min-width: 9rem;
  line-height: 1.35;
}
.standings td:last-child strong { color: var(--primary); font-family: var(--font-mono); }
.points-standings__leader .standings__rank { color: var(--primary); font-weight: 700; }
.points-standings__hint { margin: var(--space-2) 0 0; font-size: 0.8rem; line-height: 1.45; }
</style>
