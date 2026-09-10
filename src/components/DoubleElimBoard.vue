<script setup>
import { computed, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import BracketBoard from './BracketBoard.vue'
import { useNarrowLayout } from '../lib/useNarrowLayout'
import { onTabKeydown } from '../lib/tabNavigation'

const props = defineProps({
  matches: { type: Array, default: () => [] },
  setsByMatch: { type: Object, default: () => ({}) },
  entriesMap: { type: Object, default: () => ({}) },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  canLiveScore: { type: Boolean, default: false },
})
const emit = defineEmits(['view-live'])
const { t } = useI18n()
const isNarrowLayout = useNarrowLayout()
const activeStage = ref('winners')
const boardId = useId()

const winners = computed(() => props.matches.filter((m) => m.stage === 'winners'))
const losers = computed(() => props.matches.filter((m) => m.stage === 'losers'))
const grandFinal = computed(() => props.matches.filter((m) => m.stage === 'grand_final'))
const panels = computed(() => [
  { key: 'winners', label: t('admin.winnersBracket'), count: winners.value.length },
  { key: 'losers', label: t('admin.losersBracket'), count: losers.value.length },
  { key: 'grand_final', label: t('admin.grandFinal'), count: grandFinal.value.length },
].filter((panel) => panel.count))

watch(panels, (next) => {
  if (!next.some((panel) => panel.key === activeStage.value)) activeStage.value = next[0]?.key || 'winners'
}, { immediate: true })
</script>

<template>
  <div class="de-board">
    <div v-if="isNarrowLayout" class="de-tabs" role="tablist" aria-orientation="vertical" :aria-label="t('mobile.stageFilter')" @keydown="onTabKeydown">
      <button
        v-for="panel in panels"
        :id="`${boardId}-tab-${panel.key}`"
        :key="panel.key"
        type="button"
        role="tab"
        :aria-selected="activeStage === panel.key"
        :aria-controls="`${boardId}-panel-${panel.key}`"
        :tabindex="activeStage === panel.key ? 0 : -1"
        :class="{ active: activeStage === panel.key }"
        @click="activeStage = panel.key"
      >
        <span>{{ panel.label }}</span><b>{{ panel.count }}</b>
      </button>
    </div>

    <section v-show="!isNarrowLayout || activeStage === 'winners'" :id="`${boardId}-panel-winners`" class="de-panel" :role="isNarrowLayout ? 'tabpanel' : undefined" :aria-labelledby="`${boardId}-${isNarrowLayout ? 'tab' : 'heading'}-winners`">
      <header class="de-panel__head">
        <h3 :id="`${boardId}-heading-winners`" class="de-panel__title">{{ t('admin.winnersBracket') }}</h3>
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

    <section v-if="losers.length" v-show="!isNarrowLayout || activeStage === 'losers'" :id="`${boardId}-panel-losers`" class="de-panel" :role="isNarrowLayout ? 'tabpanel' : undefined" :aria-labelledby="`${boardId}-${isNarrowLayout ? 'tab' : 'heading'}-losers`">
      <header class="de-panel__head">
        <h3 :id="`${boardId}-heading-losers`" class="de-panel__title">{{ t('admin.losersBracket') }}</h3>
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

    <section v-if="grandFinal.length" v-show="!isNarrowLayout || activeStage === 'grand_final'" :id="`${boardId}-panel-grand_final`" class="de-panel de-panel--gf" :role="isNarrowLayout ? 'tabpanel' : undefined" :aria-labelledby="`${boardId}-${isNarrowLayout ? 'tab' : 'heading'}-grand_final`">
      <header class="de-panel__head">
        <h3 :id="`${boardId}-heading-grand_final`" class="de-panel__title">{{ t('admin.grandFinal') }}</h3>
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
  position: relative;
  border: 1px solid var(--border);
  border-radius: var(--radius, 16px);
  background: var(--surface);
  overflow: hidden;
}

.de-tabs { display: grid; gap: 6px; padding: 5px; border: 1px solid var(--border); border-radius: 16px; background: var(--surface-row); }
.de-tabs button { min-height: 44px; display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 8px 12px; border: 0; border-radius: 11px; color: var(--text-muted); background: transparent; font: inherit; font-size: .84rem; font-weight: 700; text-align: left; }
.de-tabs button.active { color: var(--text); background: var(--surface); box-shadow: 0 3px 12px rgb(15 23 42 / 8%); }
.de-tabs b { min-width: 25px; height: 25px; display: grid; place-items: center; border-radius: 8px; color: var(--primary); background: var(--primary-muted); font-size: .75rem; }

@media (max-width: 720px) {
  .de-panel__head { display: none; }
  .de-panel__canvas :deep(.infinite-canvas) { min-height: min(62vh, 520px); }
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
