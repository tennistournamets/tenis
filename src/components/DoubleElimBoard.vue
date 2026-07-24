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
  <div class="de-board">
    <section class="de-panel">
      <header class="de-panel__head">
        <h3 class="de-panel__title">{{ t('admin.winnersBracket') }}</h3>
      </header>
      <div class="de-panel__canvas">
        <BracketBoard
          :matches="winners"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          :can-live-score="canLiveScore"
          @view-live="emit('view-live', $event)"
        />
      </div>
    </section>

    <section v-if="losers.length" class="de-panel">
      <header class="de-panel__head">
        <h3 class="de-panel__title">{{ t('admin.losersBracket') }}</h3>
      </header>
      <div class="de-panel__canvas">
        <BracketBoard
          :matches="losers"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          :can-live-score="canLiveScore"
          @view-live="emit('view-live', $event)"
        />
      </div>
    </section>

    <section v-if="grandFinal.length" class="de-panel de-panel--gf">
      <header class="de-panel__head">
        <h3 class="de-panel__title">{{ t('admin.grandFinal') }}</h3>
      </header>
      <div class="de-panel__canvas">
        <BracketBoard
          :matches="grandFinal"
          :sets-by-match="setsByMatch"
          :entries-map="entriesMap"
          :live-scores-by-match="liveScoresByMatch"
          :can-live-score="canLiveScore"
          @view-live="emit('view-live', $event)"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.de-board {
  display: flex;
  flex-direction: column;
  gap: var(--space-4, 16px);
}

.de-panel {
  border: 1px solid var(--border);
  border-radius: var(--radius, 16px);
  background: var(--surface);
  overflow: hidden;
}

.de-panel__head {
  display: flex;
  align-items: center;
  padding: var(--space-3, 12px) var(--space-4, 16px);
  border-bottom: 1px solid var(--border);
  background: var(--surface);
}

.de-panel__title {
  margin: 0;
  font-size: 1rem;
}

.de-panel__canvas :deep(.infinite-canvas) {
  border-radius: 0;
  min-height: 380px;
  background-color: var(--surface-row);
}

.de-panel--gf .de-panel__canvas :deep(.infinite-canvas) {
  min-height: 240px;
}
</style>
