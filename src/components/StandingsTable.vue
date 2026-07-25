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
  <div class="standings-wrap">
    <table class="standings">
      <thead>
        <tr>
          <th class="standings__rank">#</th>
          <th class="standings__team">{{ t('standings.team') }}</th>
          <th :title="t('standings.played')">{{ t('standings.played') }}</th>
          <th :title="t('standings.won')">{{ t('standings.won') }}</th>
          <th v-if="family === 'goals'" :title="t('standings.drawn')">{{ t('standings.drawn') }}</th>
          <th :title="t('standings.lost')">{{ t('standings.lost') }}</th>
          <template v-if="family === 'goals'">
            <th :title="t('standings.for')">{{ t('standings.for') }}</th>
            <th :title="t('standings.against')">{{ t('standings.against') }}</th>
            <th :title="t('standings.diff')">{{ t('standings.diff') }}</th>
          </template>
          <th v-else :title="t('standings.sets')">{{ t('standings.sets') }}</th>
          <th :title="t('standings.points')">{{ t('standings.points') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.entry_id">
          <td class="standings__rank">{{ r.rank }}</td>
          <td class="standings__team">{{ r.display_name }}</td>
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
.standings th {
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
