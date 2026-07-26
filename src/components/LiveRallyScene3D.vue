<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { normalizeTennisState } from '../lib/useTennisScoring'
import { RallyDirector, updateCamera } from '../lib/rally3d/director'
import { createWorld } from '../lib/rally3d/scene'

const props = defineProps({
  state: {
    type: Object,
    default: null,
  },
  teamA: {
    type: String,
    required: true,
  },
  teamB: {
    type: String,
    required: true,
  },
  swapped: {
    type: Boolean,
    default: false,
  },
})

// 'fallback' asks the parent to render the 2D scene instead.
const emit = defineEmits(['fallback'])

const container = ref(null)
const norm = computed(() => normalizeTennisState(props.state))

let world = null
let director = null
let rafId = 0
let clockPrev = 0
let resizeObserver = null

// Same win detection as the 2D scene: sets > games > points.
function detectPointWin(prev, next) {
  const levels = [
    ['setsWon', 'set'],
    ['games', 'game'],
    ['tiebreakPoints', 'point'],
    ['points', 'point'],
  ]
  for (const [key, level] of levels) {
    for (const side of ['a', 'b']) {
      if (next[key][side] > prev[key][side]) return { side, level }
    }
  }
  return null
}

watch(norm, (next, prev) => {
  if (!director || !prev) return
  if (next.winner) {
    director.setWinner(next.winner)
    return
  }
  const win = detectPointWin(prev, next)
  if (win) director.celebrate(win.side, win.level)
})

watch(
  () => props.swapped,
  (next) => {
    if (director) director.setSwapped(next, true)
  },
)

function frame(now) {
  rafId = requestAnimationFrame(frame)
  const dt = Math.min(0.05, (now - clockPrev) / 1000 || 0)
  clockPrev = now
  director.update(dt)
  updateCamera(world.camera, director.time)
  world.renderer.render(world.scene, world.camera)
}

function start() {
  if (rafId) return
  clockPrev = performance.now()
  rafId = requestAnimationFrame(frame)
}

function stop() {
  if (rafId) {
    cancelAnimationFrame(rafId)
    rafId = 0
  }
}

function onVisibility() {
  if (document.hidden) {
    stop()
  } else if (world) {
    start()
  }
}

onMounted(() => {
  try {
    world = createWorld(container.value)
    director = new RallyDirector(world.scene, { swapped: props.swapped })
    if (norm.value.winner) director.setWinner(norm.value.winner)
  } catch (error) {
    console.warn('rally3d init failed, falling back to 2D:', error)
    emit('fallback')
    return
  }

  resizeObserver = new ResizeObserver(() => world.resize())
  resizeObserver.observe(container.value)
  document.addEventListener('visibilitychange', onVisibility)
  start()
})

onBeforeUnmount(() => {
  stop()
  document.removeEventListener('visibilitychange', onVisibility)
  if (resizeObserver) resizeObserver.disconnect()
  if (world) world.dispose()
  world = null
  director = null
})
</script>

<template>
  <div class="rally3d">
    <div ref="container" class="rally3d__canvas"></div>
    <div class="rally3d__names">
      <span
        v-for="side in (swapped ? ['b', 'a'] : ['a', 'b'])"
        :key="side"
        class="rally3d__name"
      >{{ side === 'a' ? teamA : teamB }}</span>
    </div>
  </div>
</template>

<style scoped>
.rally3d {
  padding: var(--space-2) 0 0;
}

.rally3d__canvas {
  width: 100%;
  height: 230px;
  border-radius: var(--radius-sm);
  overflow: hidden;
}

.rally3d__canvas :deep(canvas) {
  display: block;
  width: 100%;
  height: 100%;
}

.rally3d__names {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
  margin-top: 2px;
}

.rally3d__name {
  min-width: 0;
  text-align: center;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

@media (max-width: 480px) {
  .rally3d__canvas {
    height: 180px;
  }
}
</style>
