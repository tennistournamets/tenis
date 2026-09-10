<script setup>
import { useI18n } from 'vue-i18n'

defineProps({
  rows: { type: Array, default: () => [] },
  // 'goals' (football): full football-style columns; 'sets' (tennis/padel):
  // no draws, sets won:lost instead of scored/conceded/diff.
  family: { type: String, default: 'goals' },
})
const { t } = useI18n()
</script>

<template>
  <div class="standings-wrap" tabindex="0" role="region" :aria-label="t('standings.title')">
    <table class="standings">
      <caption class="sr-only">{{ t('standings.title') }}</caption>
      <thead>
        <tr>
          <th scope="col" class="standings__rank" :aria-label="t('a11y.rank')">#</th>
          <th scope="col" class="standings__team">{{ t('standings.team') }}</th>
          <th v-for="column in (family === 'goals' ? ['played', 'won', 'drawn', 'lost', 'for', 'against', 'diff', 'points'] : ['played', 'won', 'lost', 'sets', 'points'])" :key="column" scope="col" :title="t(`a11y.stats.${column}`)" :aria-label="t(`a11y.stats.${column}`)">{{ t(`standings.${column}`) }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.entry_id">
          <td class="standings__rank">{{ r.rank }}</td>
          <th scope="row" class="standings__team">{{ r.display_name }}</th>
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
.standings tbody tr {
  transition: background 0.12s;
}
.standings tbody tr:hover {
  background: var(--surface-hover);
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
.standings td:last-child strong {
  color: var(--primary);
  font-family: var(--font-mono);
}
</style>
