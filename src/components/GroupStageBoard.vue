<script setup>
import { useI18n } from 'vue-i18n'
import StandingsTable from './StandingsTable.vue'

defineProps({
  groups: { type: Array, default: () => [] }, // [{ id, name, standings, rounds }]
  entriesMap: { type: Object, default: () => ({}) },
  family: { type: String, default: 'goals' },
})
const { t } = useI18n()

function name(map, id) {
  return map[id]?.display_name || '—'
}
</script>

<template>
  <div class="group-board">
    <section v-for="g in groups" :key="g.id" class="card stack stack--sm group-board__group">
      <h3 class="section-title">{{ t('admin.group') }} {{ g.name }}</h3>

      <StandingsTable :rows="g.standings" :family="family" />

      <div v-if="g.rounds.length" class="group-board__fixtures">
        <div v-for="grp in g.rounds" :key="grp.round" class="rr-round">
          <h4 class="muted" style="margin: 10px 0 4px">{{ t('tournament.round') }} {{ grp.round }}</h4>
          <ul class="rr-fixtures">
            <li v-for="m in grp.list" :key="m.id" class="rr-fixture">
              <span class="rr-fixture__side">{{ name(entriesMap, m.side_a_entry_id) }}</span>
              <span class="rr-fixture__score">
                <template v-if="m.status === 'finished'">{{ m.side_a_score }} : {{ m.side_b_score }}</template>
                <template v-else>vs</template>
              </span>
              <span class="rr-fixture__side rr-fixture__side--right">{{ name(entriesMap, m.side_b_entry_id) }}</span>
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
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: var(--space-4, 16px);
}
</style>
