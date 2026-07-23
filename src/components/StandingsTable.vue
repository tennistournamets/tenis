<script setup>
import { useI18n } from 'vue-i18n'

defineProps({
  rows: { type: Array, default: () => [] },
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
          <th :title="t('standings.drawn')">{{ t('standings.drawn') }}</th>
          <th :title="t('standings.lost')">{{ t('standings.lost') }}</th>
          <th :title="t('standings.for')">{{ t('standings.for') }}</th>
          <th :title="t('standings.against')">{{ t('standings.against') }}</th>
          <th :title="t('standings.diff')">{{ t('standings.diff') }}</th>
          <th :title="t('standings.points')">{{ t('standings.points') }}</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="r.entry_id">
          <td class="standings__rank">{{ r.rank }}</td>
          <td class="standings__team">{{ r.display_name }}</td>
          <td>{{ r.played }}</td>
          <td>{{ r.won }}</td>
          <td>{{ r.drawn }}</td>
          <td>{{ r.lost }}</td>
          <td>{{ r.score_for }}</td>
          <td>{{ r.score_against }}</td>
          <td>{{ r.diff }}</td>
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
  padding: 8px 10px;
  text-align: center;
  border-bottom: 1px solid var(--border, #e5e7eb);
  white-space: nowrap;
}
.standings th {
  font-weight: 600;
  color: var(--text-muted, #6b7280);
}
.standings__rank {
  width: 2rem;
}
.standings__team {
  text-align: left;
  font-weight: 600;
}
</style>
