<script setup>
import { computed, defineAsyncComponent, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { pointLabel, scoreLine } from '../lib/useTennisScoring'
import { displaySides, useDeferredChangeover } from '../lib/liveSides'

import LiveRallyAnimation from './LiveRallyAnimation.vue'

// 3D court is a lazy chunk (three.js); the 2D SVG scene stays as fallback
// for reduced-motion, missing WebGL, or a failed init.
const LiveRallyScene3D = defineAsyncComponent(() => import('./LiveRallyScene3D.vue'))

function webglAvailable() {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') || canvas.getContext('webgl'))
  } catch {
    return false
  }
}

const reducedMotion =
  typeof window !== 'undefined' && window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
    : false

const use3D = ref(!reducedMotion && webglAvailable())

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

// Court sides follow the scorer's orientation (stored on the live row).
// Changeover flips wait for the game-win celebration to finish.
const autoChangeover = useDeferredChangeover(state)
const sides = computed(() => displaySides(props.liveScore, state.value, autoChangeover.value))
const swapped = computed(() => sides.value[0] === 'b')

function teamName(side) {
  return side === 'a' ? props.teamA : props.teamB
}
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

      <LiveRallyScene3D
        v-if="use3D"
        :state="state"
        :team-a="teamA"
        :team-b="teamB"
        :swapped="swapped"
        @fallback="use3D = false"
      />
      <LiveRallyAnimation v-else :state="state" :team-a="teamA" :team-b="teamB" :swapped="swapped" />

      <!-- Score rows keep a fixed A/B order — only the court figures swap ends. -->
      <div class="live-scoreboard">
        <div
          v-for="side in ['a', 'b']"
          :key="side"
          class="live-scoreboard__row"
          :class="{ 'live-scoreboard__row--winner': state?.winner === side }"
        >
          <strong>{{ teamName(side) }}</strong>
          <span class="live-scoreboard__point">{{ pointLabel(state, side) }}</span>
        </div>
      </div>

      <p class="live-scoreboard__sets">{{ scoreLine(state) }}</p>
      <div v-if="state?.isTiebreak" class="alert alert--info" role="status">
        {{ t('live.tiebreak') }}
      </div>
    </div>
  </div>
</template>
