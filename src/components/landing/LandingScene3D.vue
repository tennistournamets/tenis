<script setup>
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { readPalette } from '../../lib/landing3d/palette'
import { createLandingWorld } from '../../lib/landing3d/world'
import { theme } from '../../lib/theme'

// Fixed transparent WebGL layer behind the landing. Props are anchored to
// [data-stage] / [data-step-block] elements found under `root`.
const props = defineProps({
  paused: { type: Boolean, default: false },
  root: {
    type: Object,
    default: null,
  },
})

const emit = defineEmits(['ready', 'unavailable'])

const host = ref(null)
let world = null
let rafId = 0
let staticRaf = 0
let resizeObserver = null
let reducedMotion = false
let motionQuery = null
const cleanups = []

function collectAnchors() {
  const root = props.root || document
  const map = {}
  root.querySelectorAll('[data-stage]').forEach((el) => {
    map[el.dataset.stage] = el
  })
  root.querySelectorAll('[data-step-block]').forEach((el) => {
    map[`block-${el.dataset.stepBlock}`] = el
  })
  return map
}

function loop(now) {
  rafId = requestAnimationFrame(loop)
  world.frame(now)
}

function start() {
  if (rafId || reducedMotion || document.hidden || !world) return
  rafId = requestAnimationFrame(loop)
}

function stop() {
  if (rafId) cancelAnimationFrame(rafId)
  rafId = 0
}

function queueStatic() {
  if (!world || staticRaf) return
  staticRaf = requestAnimationFrame(() => {
    staticRaf = 0
    world?.renderStatic()
  })
}

function refresh() {
  if (!world) return
  world.setAnchors(collectAnchors())
  if (reducedMotion) queueStatic()
}

function listen(target, type, handler, opts) {
  target.addEventListener(type, handler, opts)
  cleanups.push(() => target.removeEventListener(type, handler, opts))
}

onMounted(async () => {
  await nextTick()
  if (!host.value) {
    emit('unavailable')
    return
  }
  motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
  reducedMotion = motionQuery.matches || props.paused
  listen(motionQuery, 'change', syncMotion)
  const finePointer = window.matchMedia('(pointer: fine)').matches
  const small = window.matchMedia('(max-width: 640px)').matches
  const lowEnd =
    (navigator.deviceMemory && navigator.deviceMemory < 4) ||
    (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4)

  try {
    world = createLandingWorld(host.value, {
      palette: readPalette(),
      reducedMotion,
      dprCap: small || lowEnd ? 1.25 : 1.5,
      onContextLost() {
        console.warn('landing3d: WebGL context lost, falling back')
        stop()
        emit('unavailable')
      },
    })
  } catch (error) {
    console.warn('landing3d init failed:', error)
    emit('unavailable')
    return
  }

  if (!host.value) {
    // unmounted while initialising
    world.dispose()
    world = null
    return
  }
  refresh()
  emit('ready')

  const root = props.root || document.body
  resizeObserver = new ResizeObserver(() => refresh())
  resizeObserver.observe(root)
  // iOS toolbars fire resize storms with height-only changes; debounce.
  let resizeTimer = 0
  const onResize = () => {
    clearTimeout(resizeTimer)
    resizeTimer = setTimeout(() => {
      if (!world) return
      world.resize()
      refresh()
    }, 120)
  }
  listen(window, 'resize', onResize)
  listen(window, 'orientationchange', onResize)
  cleanups.push(() => clearTimeout(resizeTimer))
  listen(window, 'scroll', () => world && world.noteInput(performance.now()), { passive: true })
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refresh).catch(() => {})

  if (finePointer) {
    listen(
      window,
      'pointermove',
      (e) => !reducedMotion && world?.setPointer((e.clientX / window.innerWidth) * 2 - 1, (e.clientY / window.innerHeight) * 2 - 1),
      { passive: true },
    )
  }

  root.querySelectorAll('[data-stage^="format-"]').forEach((stage) => {
    const tile = stage.closest('.sport-tile') || stage
    const key = stage.dataset.stage
    listen(tile, 'pointerenter', () => world.setHover(key, true))
    listen(tile, 'pointerleave', () => world.setHover(key, false))
  })

  listen(
    document,
    'visibilitychange',
    () => {
      if (document.hidden) stop()
      else if (reducedMotion) queueStatic()
      else start()
    },
  )

  listen(window, 'scroll', () => { if (reducedMotion) queueStatic() }, { passive: true })
  if (reducedMotion) {
    queueStatic()
  } else {
    start()
  }
})

function syncMotion() {
  reducedMotion = Boolean(motionQuery?.matches || props.paused)
  if (!world) return
  world.setReducedMotion(reducedMotion)
  if (reducedMotion) { stop(); queueStatic() }
  else start()
}
watch(() => props.paused, syncMotion)

watch(theme, () => {
  if (!world) return
  requestAnimationFrame(() => {
    if (!world) return
    world.setPalette(readPalette())
    if (reducedMotion) queueStatic()
  })
})

onBeforeUnmount(() => {
  stop()
  if (staticRaf) cancelAnimationFrame(staticRaf)
  for (const fn of cleanups) fn()
  cleanups.length = 0
  if (resizeObserver) resizeObserver.disconnect()
  if (world) world.dispose()
  world = null
})
</script>

<template>
  <div ref="host" class="landing3d" aria-hidden="true"></div>
</template>
