<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from './AppIcon.vue'
import { entryMemberNames } from '../lib/entryDisplay'
import { tournamentChampion } from '../lib/tournamentChampion'

// The tournament's outcome, shared by the admin page and the public page: the
// champion once the deciding match is played (or the all-play-all is over),
// and, for organizers, the offer to finish the tournament.
const props = defineProps({
  format: { type: String, default: '' },
  status: { type: String, default: '' },
  matches: { type: Array, default: () => [] },
  standings: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  canFinish: Boolean,
  busy: Boolean,
})
const emit = defineEmits(['finish'])
const { t } = useI18n()

const champion = computed(() => tournamentChampion({
  format: props.format, status: props.status, matches: props.matches, standings: props.standings,
}))
const championName = computed(() => {
  const entry = props.entriesMap[champion.value?.entryId]
  const names = entryMemberNames(entry)
  return names.length ? names.join(' / ') : entry?.display_name || t('bracket.tbd')
})
const completed = computed(() => props.status === 'completed')
const visible = computed(() => completed.value || (props.status === 'in_progress' && Boolean(champion.value)))
const offerFinish = computed(() => props.canFinish && props.status === 'in_progress' && Boolean(champion.value))
const eyebrow = computed(() => {
  if (completed.value) return t('lifecycle.completedTitle')
  return champion.value?.source === 'standings' ? t('lifecycle.allPlayed') : t('lifecycle.finalPlayed')
})
</script>

<template>
  <section v-if="visible" class="card champion-banner" :class="{ 'champion-banner--decided': champion }" role="status">
    <span class="champion-banner__icon" aria-hidden="true"><AppIcon name="trophy" :size="26" /></span>
    <div class="champion-banner__body">
      <p class="champion-banner__eyebrow">{{ eyebrow }}</p>
      <p v-if="champion" class="champion-banner__name">
        <span class="champion-banner__label">{{ t('lifecycle.champion') }}:</span>
        <strong>{{ championName }}</strong>
      </p>
      <p v-else class="champion-banner__hint">{{ t('lifecycle.noChampion') }}</p>
      <p v-if="offerFinish" class="champion-banner__hint">{{ t('lifecycle.finishHint') }}</p>
    </div>
    <button v-if="offerFinish" class="btn btn--primary btn--sm champion-banner__action" type="button" :disabled="busy" @click="emit('finish')">
      {{ t('admin.finishTournament') }}
    </button>
  </section>
</template>

<style scoped>
.champion-banner {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 12px 16px;
  padding: 16px 18px;
}
.champion-banner--decided { border-color: var(--success-border); background: var(--success-bg); }
.champion-banner__icon {
  display: inline-flex; align-items: center; justify-content: center;
  width: 44px; height: 44px; border-radius: 50%;
  background: var(--surface); color: var(--success);
}
.champion-banner__body { display: grid; gap: 2px; min-width: 0; }
.champion-banner__eyebrow { margin: 0; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.champion-banner__name { margin: 0; font-size: 1.125rem; color: var(--heading); overflow-wrap: anywhere; }
.champion-banner__label { margin-right: 6px; font-weight: 500; color: var(--text); }
.champion-banner__hint { margin: 0; font-size: 0.875rem; line-height: 1.4; color: var(--muted); }
@media (max-width: 560px) {
  .champion-banner { grid-template-columns: auto minmax(0, 1fr); }
  .champion-banner__action { grid-column: 1 / -1; justify-self: start; }
}
</style>
