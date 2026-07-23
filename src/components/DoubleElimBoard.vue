<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import BracketBoard from './BracketBoard.vue'

const props = defineProps({
  matches: { type: Array, default: () => [] },
  setsByMatch: { type: Object, default: () => ({}) },
  entriesMap: { type: Object, default: () => ({}) },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  canLiveScore: { type: Boolean, default: false },
})
const emit = defineEmits(['view-live'])
const { t } = useI18n()

const winners = computed(() => props.matches.filter((m) => m.stage === 'winners'))
const losers = computed(() => props.matches.filter((m) => m.stage === 'losers'))
const grandFinal = computed(() => props.matches.filter((m) => m.stage === 'grand_final'))
</script>

<template>
  <div class="de-board stack stack--lg">
    <div class="de-board__section">
      <h3 class="section-title">{{ t('admin.winnersBracket') }}</h3>
      <BracketBoard
        :matches="winners"
        :sets-by-match="setsByMatch"
        :entries-map="entriesMap"
        :live-scores-by-match="liveScoresByMatch"
        :can-live-score="canLiveScore"
        @view-live="emit('view-live', $event)"
      />
    </div>

    <div v-if="losers.length" class="de-board__section">
      <h3 class="section-title">{{ t('admin.losersBracket') }}</h3>
      <BracketBoard
        :matches="losers"
        :sets-by-match="setsByMatch"
        :entries-map="entriesMap"
        :live-scores-by-match="liveScoresByMatch"
        :can-live-score="canLiveScore"
        @view-live="emit('view-live', $event)"
      />
    </div>

    <div v-if="grandFinal.length" class="de-board__section">
      <h3 class="section-title">{{ t('admin.grandFinal') }}</h3>
      <BracketBoard
        :matches="grandFinal"
        :sets-by-match="setsByMatch"
        :entries-map="entriesMap"
        :live-scores-by-match="liveScoresByMatch"
        :can-live-score="canLiveScore"
        @view-live="emit('view-live', $event)"
      />
    </div>
  </div>
</template>

<style scoped>
.de-board__section + .de-board__section {
  margin-top: var(--space-4, 16px);
}
</style>
