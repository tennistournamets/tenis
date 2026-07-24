<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'

import { pointLabel, scoreLine } from '../lib/useTennisScoring'

import LiveRallyAnimation from './LiveRallyAnimation.vue'

const props = defineProps({
  liveScore: {
    type: Object,
    required: true,
  },
  teamA: {
    type: String,
    required: true,
  },
  teamB: {
    type: String,
    required: true,
  },
})

const emit = defineEmits(['close'])

const { t } = useI18n()

const state = computed(() => props.liveScore?.state || null)
const statusText = computed(() => {
  if (props.liveScore?.status === 'finished' || state.value?.winner) return t('live.finished')
  if (props.liveScore?.status === 'stopped') return t('live.stopped')
  return t('live.active')
})
</script>

<template>
  <div class="modal-backdrop" @click="emit('close')">
    <div class="modal-dialog live-modal" role="dialog" aria-modal="true" @click.stop>
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('live.viewerTitle') }}</h2>
          <p class="muted">{{ statusText }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <LiveRallyAnimation :state="state" :team-a="teamA" :team-b="teamB" />

      <div class="live-scoreboard">
        <div class="live-scoreboard__row" :class="{ 'live-scoreboard__row--winner': state?.winner === 'a' }">
          <strong>{{ teamA }}</strong>
          <span class="live-scoreboard__point">{{ pointLabel(state, 'a') }}</span>
        </div>
        <div class="live-scoreboard__row" :class="{ 'live-scoreboard__row--winner': state?.winner === 'b' }">
          <strong>{{ teamB }}</strong>
          <span class="live-scoreboard__point">{{ pointLabel(state, 'b') }}</span>
        </div>
      </div>

      <p class="live-scoreboard__sets">{{ scoreLine(state) }}</p>
      <div v-if="state?.isTiebreak" class="alert alert--info" role="status">
        {{ t('live.tiebreak') }}
      </div>
    </div>
  </div>
</template>
