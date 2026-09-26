<script setup>
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { fitTransform, wheelIntent } from '../lib/canvasView'

const { t } = useI18n()

const containerRef = ref(null)
const contentRef = ref(null)

const scale = ref(1)
const translateX = ref(0)
const translateY = ref(0)
const isPanning = ref(false)
const isFullscreen = ref(false)
// Fallback when the Fullscreen API is refused (embedded browsers, iOS): fixed overlay.
const pseudoFullscreen = ref(false)
const spaceHeld = ref(false)
const autoFit = ref(true)
// 'readable' keeps cards legible on phones (pan to see the rest); 'all' shows everything.
const fitMode = ref('readable')

const MIN_SCALE = 0.1
const MAX_SCALE = 3
const ZOOM_FACTOR = 0.08

const emit = defineEmits(['transform-change'])

const transformStyle = () => {
  return `translate(${translateX.value}px, ${translateY.value}px) scale(${scale.value})`
}

/* ── Zoom ── */
// Plain wheel scrolls the page (the canvas sits inside a long page); Ctrl/⌘ + wheel
// and trackpad pinch (reported as ctrlKey) zoom. In fullscreen the wheel pans.
function onWheel(e) {
  const intent = wheelIntent(e, isFullscreen.value)
  if (intent === 'scroll') return
  e.preventDefault()
  autoFit.value = false
  if (intent === 'pan') {
    translateX.value -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX
    translateY.value -= e.shiftKey && !e.deltaX ? 0 : e.deltaY
    emitTransform()
    return
  }
  const rect = containerRef.value.getBoundingClientRect()
  const cursorX = e.clientX - rect.left
  const cursorY = e.clientY - rect.top

  const oldScale = scale.value
  const delta = e.deltaY > 0 ? -ZOOM_FACTOR : ZOOM_FACTOR
  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * (1 + delta)))

  const ratio = newScale / oldScale
  translateX.value = cursorX - (cursorX - translateX.value) * ratio
  translateY.value = cursorY - (cursorY - translateY.value) * ratio
  scale.value = newScale

  emitTransform()
}

function zoomIn() {
  zoomToCenter(1 + ZOOM_FACTOR * 3)
}

function zoomOut() {
  zoomToCenter(1 - ZOOM_FACTOR * 3)
}

function zoomToCenter(factor) {
  autoFit.value = false
  const rect = containerRef.value.getBoundingClientRect()
  const cx = rect.width / 2
  const cy = rect.height / 2

  const oldScale = scale.value
  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * factor))
  const ratio = newScale / oldScale

  translateX.value = cx - (cx - translateX.value) * ratio
  translateY.value = cy - (cy - translateY.value) * ratio
  scale.value = newScale
  emitTransform()
}

// Called by the boards after data changes (keeps the current fit mode) and by the
// toolbar's "fit" button (mode 'all').
function fitToView(mode = fitMode.value) {
  const container = containerRef.value
  const content = contentRef.value
  if (!container || !content) return

  const cRect = container.getBoundingClientRect()
  const next = fitTransform({ width: cRect.width, height: cRect.height },
    { width: content.scrollWidth, height: content.scrollHeight }, { mode: typeof mode === 'string' ? mode : fitMode.value, minScale: MIN_SCALE })
  if (!next) return
  scale.value = next.scale
  translateX.value = next.translateX
  translateY.value = next.translateY
  autoFit.value = true
  emitTransform()
}

function fitAll() {
  fitMode.value = 'all'
  fitToView('all')
}

// "Reset zoom": 100 % from the top-left corner (not the same as "fit").
function resetView() {
  scale.value = 1
  translateX.value = 0
  translateY.value = 0
  autoFit.value = false
  emitTransform()
}

/* ── Pan (mouse) ── */
let panStartX = 0
let panStartY = 0
let panStartTx = 0
let panStartTy = 0

/** Check if the click target is an interactive element that should not trigger pan. */
function isInteractiveTarget(el) {
  while (el && el !== containerRef.value) {
    if (
      el.draggable ||
      el.tagName === 'BUTTON' ||
      el.tagName === 'INPUT' ||
      el.tagName === 'SELECT' ||
      el.tagName === 'TEXTAREA' ||
      el.tagName === 'A' ||
      el.closest?.('.infinite-canvas__toolbar')
    ) {
      return true
    }
    el = el.parentElement
  }
  return false
}

function onPointerDown(e) {
  // Middle button always pans
  if (e.button === 1) {
    e.preventDefault()
    startPan(e)
    return
  }
  // Left button: pan unless clicking an interactive element
  if (e.button === 0 && !isInteractiveTarget(e.target)) {
    e.preventDefault()
    startPan(e)
  }
}

function startPan(e) {
  autoFit.value = false
  isPanning.value = true
  panStartX = e.clientX
  panStartY = e.clientY
  panStartTx = translateX.value
  panStartTy = translateY.value
  containerRef.value.setPointerCapture(e.pointerId)
}

function onPointerMove(e) {
  if (!isPanning.value) return
  translateX.value = panStartTx + (e.clientX - panStartX)
  translateY.value = panStartTy + (e.clientY - panStartY)
  emitTransform()
}

function onPointerUp(e) {
  if (isPanning.value) {
    isPanning.value = false
    containerRef.value?.releasePointerCapture(e.pointerId)
  }
}

/* ── Pan (touch) ── */
let lastTouchDist = 0
let lastTouchCenterX = 0
let lastTouchCenterY = 0
let touchPanning = false

function getTouchCenter(touches) {
  const x = (touches[0].clientX + touches[1].clientX) / 2
  const y = (touches[0].clientY + touches[1].clientY) / 2
  return { x, y }
}

function getTouchDist(touches) {
  const dx = touches[0].clientX - touches[1].clientX
  const dy = touches[0].clientY - touches[1].clientY
  return Math.sqrt(dx * dx + dy * dy)
}

function onTouchStart(e) {
  if (e.touches.length === 2) {
    e.preventDefault()
    autoFit.value = false
    touchPanning = true
    lastTouchDist = getTouchDist(e.touches)
    const center = getTouchCenter(e.touches)
    lastTouchCenterX = center.x
    lastTouchCenterY = center.y
  }
}

function onTouchMove(e) {
  if (!touchPanning || e.touches.length !== 2) return
  e.preventDefault()

  const newDist = getTouchDist(e.touches)
  const center = getTouchCenter(e.touches)
  const rect = containerRef.value.getBoundingClientRect()

  // Pinch zoom
  const zoomRatio = newDist / lastTouchDist
  const oldScale = scale.value
  const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, oldScale * zoomRatio))
  const ratio = newScale / oldScale

  const cx = center.x - rect.left
  const cy = center.y - rect.top

  translateX.value = cx - (cx - translateX.value) * ratio + (center.x - lastTouchCenterX)
  translateY.value = cy - (cy - translateY.value) * ratio + (center.y - lastTouchCenterY)
  scale.value = newScale

  lastTouchDist = newDist
  lastTouchCenterX = center.x
  lastTouchCenterY = center.y
  emitTransform()
}

function onTouchEnd(e) {
  if (e.touches.length < 2) {
    touchPanning = false
  }
}

/* ── Keyboard ── */
function onKeyDown(e) {
  if (e.key === 'Escape' && pseudoFullscreen.value) { setPseudoFullscreen(false); return }
  if (e.code === 'Space' && !e.repeat) {
    spaceHeld.value = true
  }
}

function onKeyUp(e) {
  if (e.code === 'Space') {
    spaceHeld.value = false
  }
}

/* ── Fullscreen ── */
function toggleFullscreen() {
  const el = containerRef.value
  if (!el) return

  if (pseudoFullscreen.value) { setPseudoFullscreen(false); return }
  if (document.fullscreenElement || document.webkitFullscreenElement) {
    Promise.resolve((document.exitFullscreen || document.webkitExitFullscreen)?.call(document)).catch(() => {})
    return
  }
  const request = el.requestFullscreen || el.webkitRequestFullscreen
  // The request is refused without user permission (e.g. embedded browsers); never
  // leave that as an unhandled rejection — fall back to a fixed full-window overlay.
  let pending
  try { pending = request?.call(el) } catch { pending = Promise.reject(new Error('fullscreen unavailable')) }
  if (!request) pending = Promise.reject(new Error('fullscreen unavailable'))
  Promise.resolve(pending).catch(() => setPseudoFullscreen(true))
}

function setPseudoFullscreen(on) {
  pseudoFullscreen.value = on
  isFullscreen.value = on
  document.documentElement.classList.toggle('ic-pseudo-fullscreen-open', on)
  requestAnimationFrame(() => fitToView())
}

function onFullscreenChange() {
  isFullscreen.value = pseudoFullscreen.value || !!(document.fullscreenElement || document.webkitFullscreenElement)
}

/* ── Emit ── */
function emitTransform() {
  emit('transform-change', {
    scale: scale.value,
    translateX: translateX.value,
    translateY: translateY.value,
  })
}

/* ── Lifecycle ── */
let resizeObserver = null
let resizeFrame = 0

onMounted(() => {
  window.addEventListener('keydown', onKeyDown)
  window.addEventListener('keyup', onKeyUp)
  document.addEventListener('fullscreenchange', onFullscreenChange)
  document.addEventListener('webkitfullscreenchange', onFullscreenChange)
  if ('ResizeObserver' in window) {
    resizeObserver = new ResizeObserver(() => {
      if (!autoFit.value) return
      cancelAnimationFrame(resizeFrame)
      resizeFrame = requestAnimationFrame(fitToView)
    })
    if (containerRef.value) resizeObserver.observe(containerRef.value)
    if (contentRef.value) resizeObserver.observe(contentRef.value)
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeyDown)
  window.removeEventListener('keyup', onKeyUp)
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  document.removeEventListener('webkitfullscreenchange', onFullscreenChange)
  resizeObserver?.disconnect()
  cancelAnimationFrame(resizeFrame)
  if (pseudoFullscreen.value) document.documentElement.classList.remove('ic-pseudo-fullscreen-open')
})

defineExpose({ fitToView, resetView, scale, translateX, translateY })
</script>

<template>
  <div
    ref="containerRef"
    class="infinite-canvas"
    :class="{
      'infinite-canvas--panning': isPanning || spaceHeld,
      'infinite-canvas--fullscreen': isFullscreen,
      'infinite-canvas--pseudo-fullscreen': pseudoFullscreen,
    }"
    @wheel="onWheel"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @touchstart="onTouchStart"
    @touchmove="onTouchMove"
    @touchend="onTouchEnd"
  >
    <div
      ref="contentRef"
      class="infinite-canvas__content"
      :style="{ transform: transformStyle() }"
    >
      <slot />
    </div>

    <div class="infinite-canvas__toolbar">
      <button type="button" class="ic-btn" :title="t('bracket.zoomOut')" :aria-label="t('bracket.zoomOut')" @click="zoomOut">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <span class="ic-zoom-label" aria-live="polite">{{ Math.round(scale * 100) }}%</span>
      <button type="button" class="ic-btn" :title="t('bracket.zoomIn')" :aria-label="t('bracket.zoomIn')" @click="zoomIn">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 8h10M8 3v10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
      </button>
      <button type="button" class="ic-btn" :title="t('bracket.fitView')" :aria-label="t('bracket.fitView')" @click="fitAll">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="8" r="1" fill="currentColor"/></svg>
      </button>
      <button type="button" class="ic-btn recenter" :title="t('bracket.resetView')" :aria-label="t('bracket.resetView')" @click="resetView">
        <svg style="position: relative; top: 4px;" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 8a6 6 0 1111.5-2.5M14 2v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <button type="button" class="ic-btn" :title="t('bracket.fullscreen')" :aria-label="t('bracket.fullscreen')" @click="toggleFullscreen">
        <svg v-if="!isFullscreen" width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M2 10v4h4M14 6V2h-4M2 6V2h4M14 10v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 14v-4H2M10 2v4h4M6 2v4H2M10 14v-4h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
    </div>
  </div>
</template>
