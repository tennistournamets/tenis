<script setup>
import { computed, defineAsyncComponent, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { pointLabel, scoreLine } from '../lib/useTennisScoring'
import { displaySides, useDeferredChangeover } from '../lib/liveSides'
import { GLB_TIMEOUT_MS, maxNetworkTier, withTimeout } from '../lib/rally3d/networkTier'

import LiveRallyAnimation from './LiveRallyAnimation.vue'

// 3D court is a lazy chunk (three.js); the 2D SVG scene renders instantly and
// stays as the floor for reduced-motion, missing WebGL, slow networks, or a
// failed load/init.
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

// Quality cascade: '2d' -> 'primitives' -> 'characters'. Starts at 2D (zero
// extra payload); upgrades ONCE when the needed resources are ready, so slow
// networks never leave the viewer staring at an empty box.
const tier = ref('2d')

onMounted(async () => {
  if (reducedMotion || !webglAvailable()) return

  const allowed = maxNetworkTier()
  if (allowed === '2d') return

  try {
    if (allowed === 'characters') {
      // pre-warm the scene chunk and the GLB in parallel; timeout demotes
      const [, skinned] = await Promise.all([
        import('./LiveRallyScene3D.vue'),
        import('../lib/rally3d/actors/skinnedActor'),
      ])
      try {
        await withTimeout(skinned.loadRigSource(), GLB_TIMEOUT_MS, 'characters model')
        tier.value = 'characters'
      } catch {
        tier.value = 'primitives'
      }
    } else {
      await import('./LiveRallyScene3D.vue')
      tier.value = 'primitives'
    }
  } catch {
    // chunk itself failed to load — stay on 2D
  }
})

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
        v-if="tier !== '2d'"
        :key="tier"
        :state="state"
        :team-a="teamA"
        :team-b="teamB"
        :swapped="swapped"
        :tier="tier"
        @fallback="tier = '2d'"
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
