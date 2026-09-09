<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDialog } from '../lib/confirmDialog'
import AppModal from './AppModal.vue'

import { normalizeTennisState, pointLabel } from '../lib/useTennisScoring'
import { useDeferredChangeover } from '../lib/liveSides'
import { supabase } from '../lib/supabase'
import { liveRuleHint, tennisRulesSummary, scoringError } from '../lib/tennisRules'
import { useOnlineStatus } from '../lib/useOnlineStatus'
import { useAuthStore } from '../stores/auth'

const props = defineProps({
  canStopLive: { type: Boolean, default: false },
  scoringConfig: { type: Object, default: () => ({}) },
  match: {
    type: Object,
    required: true,
  },
  liveScore: {
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
})

const emit = defineEmits(['close', 'changed'])

const { t } = useI18n()
const auth = useAuthStore()
const sessionOwnerId = auth.user?.id || ''
const isSessionCurrent = () => Boolean(sessionOwnerId) && auth.user?.id === sessionOwnerId

const currentLiveScore = ref(props.liveScore)
const loading = ref(false)
const errorText = ref('')
const pendingTaps = ref(0)
const cancelledTaps = ref(0)
const isOnline = useOnlineStatus()

watch(
  () => props.liveScore,
  (next) => {
    if (!next || next.match_id !== props.match.id) return
    // Ignore stale realtime echoes: an event older than what we already
    // hold (e.g. arriving after our own RPC response) must not roll back.
    const current = currentLiveScore.value
    if (current && (next.revision ?? 0) < (current.revision ?? 0)) return
    currentLiveScore.value = next
  },
  { deep: true },
)

const state = computed(() => currentLiveScore.value?.state || null)
const norm = computed(() => (state.value ? normalizeTennisState(state.value) : null))
const revision = computed(() => currentLiveScore.value?.revision ?? 0)
const canUndo = computed(() => (currentLiveScore.value?.history || []).length > 0)
const isFinished = computed(() => currentLiveScore.value?.status === 'finished' || Boolean(state.value?.winner))
const isStopped = computed(() => currentLiveScore.value?.status === 'stopped')
const isActive = computed(() => currentLiveScore.value?.status === 'active' && !isFinished.value)
const statusText = computed(() => {
  if (!currentLiveScore.value) return loading.value ? t('live.starting') : t('live.notStarted')
  if (isFinished.value) return t('live.finished')
  if (isStopped.value) return t('live.stopped')
  return t('live.active')
})

function completedSets(side) {
  return (norm.value?.sets || [])
    .map((set) => {
      if (set.score_kind === 'match_tiebreak') return `[${set[`side_${side}_tiebreak`]}]`
      const tb = set[`side_${side}_tiebreak`]
      return `${set[`side_${side}_games`]}${tb == null ? '' : `(${tb})`}`
    })
    .join(' ')
}

// Court sides. While the live row does not exist yet the counter can already
// arrange the players; the pending values are flushed right after start.
const pendingSwapped = ref(false)
const pendingAuto = ref(true)
const hasPendingSides = ref(false)
const savingSides = ref(false)

const baseSwapped = computed(() =>
  currentLiveScore.value ? Boolean(currentLiveScore.value.sides_swapped) : pendingSwapped.value,
)
const autoSides = computed(() =>
  currentLiveScore.value ? currentLiveScore.value.sides_auto !== false : pendingAuto.value,
)
// Deferred: after a completed game the flip waits for the celebration.
const autoChangeover = useDeferredChangeover(state)
const displaySwapped = computed(
  () => baseSwapped.value !== (autoSides.value ? autoChangeover.value : false),
)
const sides = computed(() => (displaySwapped.value ? ['b', 'a'] : ['a', 'b']))

function teamName(side) {
  return side === 'a' ? props.teamA : props.teamB
}

async function setSides({ swapped = null, auto = null }) {
  if (savingSides.value || !isSessionCurrent()) return
  pendingSwapped.value = swapped === null ? baseSwapped.value : swapped
  pendingAuto.value = auto === null ? autoSides.value : auto

  if (!currentLiveScore.value) { hasPendingSides.value = true; return }
  if (!isOnline.value) return

  savingSides.value = true
  errorText.value = ''
  try {
    const { data, error } = await supabase.rpc('set_live_sides', {
      p_match_id: props.match.id,
      p_swapped: swapped,
      p_auto: auto,
    })
    if (!isSessionCurrent()) return
    if (error) throw error
    if (!currentLiveScore.value || data.revision >= currentLiveScore.value.revision) currentLiveScore.value = data
    hasPendingSides.value = false
  } catch (error) {
    errorText.value = scoringError(error?.message, t)
  } finally {
    savingSides.value = false
    emit('changed')
  }
}

function toggleSwapSides() {
  setSides({ swapped: !baseSwapped.value })
}

async function toggleAutoSides(event) {
  await setSides({ auto: event.target.checked })
  event.target.checked = autoSides.value
}

async function flushPendingSides() {
  const live = currentLiveScore.value
  if (!live || !hasPendingSides.value) return
  const sameSwapped = Boolean(live.sides_swapped) === pendingSwapped.value
  const sameAuto = (live.sides_auto !== false) === pendingAuto.value
  if (sameSwapped && sameAuto) { hasPendingSides.value = false; return }
  await setSides({ swapped: pendingSwapped.value, auto: pendingAuto.value })
}

let starting = null
let startRequested = false
let retryStartAfterOffline = false
let disposed = false
function ensureStarted() {
  if (!isSessionCurrent()) return Promise.resolve()
  startRequested = true
  if (!starting) {
    starting = startSession().finally(() => {
      starting = null
      if (!disposed && startRequested && isOnline.value) void ensureStarted()
    })
  }
  return starting
}

onMounted(() => { if (!props.liveScore) ensureStarted() })
onBeforeUnmount(() => {
  disposed = true
  startRequested = false
  retryStartAfterOffline = false
})

watch(isOnline, (online) => {
  if (!online) {
    if (startRequested) retryStartAfterOffline = true
    invalidateTapQueue()
    return
  }
  if (startRequested) void ensureStarted()
})

watch(() => auth.user?.id, (userId) => {
  if (userId === sessionOwnerId) return
  startRequested = false
  retryStartAfterOffline = false
  invalidateTapQueue({ includeInFlight: true })
  emit('close')
})

async function startSession() {
  if (!isSessionCurrent()) return
  if (currentLiveScore.value?.status === 'active' || currentLiveScore.value?.status === 'finished') {
    startRequested = false
    retryStartAfterOffline = false
    return
  }
  if (!isOnline.value) {
    retryStartAfterOffline = true
    return
  }
  retryStartAfterOffline = false
  loading.value = true
  errorText.value = ''

  try {
    const { data, error } = await supabase.rpc('start_live_match', {
      p_match_id: props.match.id,
      p_expected_revision: props.match.score_revision,
    })
    if (!isSessionCurrent()) return

    if (error) {
      if (!isOnline.value) retryStartAfterOffline = true
      if (!retryStartAfterOffline) startRequested = false
      errorText.value = isOnline.value ? scoringError(error.message, t) : ''
      emit('changed')
      return
    }

    startRequested = false
    retryStartAfterOffline = false
    if (!currentLiveScore.value || data.revision >= currentLiveScore.value.revision) currentLiveScore.value = data
    await flushPendingSides()
    emit('changed')
  } catch (error) {
    if (!isOnline.value) retryStartAfterOffline = true
    if (!retryStartAfterOffline) startRequested = false
    errorText.value = isOnline.value ? scoringError(error?.message, t) : ''
    emit('changed')
  } finally {
    loading.value = false
  }
}

// Keep the revision produced by our own queue. Realtime updates must never
// silently rebase taps that were queued against a different score.
let tapQueue = Promise.resolve()
let queueEpoch = 0
let queueRevision = null
const pendingTapItems = new Set()
function invalidateTapQueue({ includeInFlight = false } = {}) {
  queueEpoch += 1
  let cancelled = 0
  pendingTapItems.forEach(item => {
    if (item.cancelled || (!includeInFlight && item.inFlight)) return
    item.cancelled = true
    cancelled += 1
  })
  cancelledTaps.value += cancelled
}
function record(side) {
  if (!isSessionCurrent() || !isActive.value || savingSides.value || !isOnline.value) return
  if (pendingTaps.value === 0) queueRevision = revision.value
  const item = { epoch: queueEpoch, inFlight: false, cancelled: false }
  pendingTapItems.add(item)
  pendingTaps.value += 1
  tapQueue = tapQueue.then(() => doRecord(side, item)).catch(() => {
    invalidateTapQueue({ includeInFlight: true })
    errorText.value = t('scoringFlow.unavailable')
    emit('changed')
  }).finally(() => {
    pendingTapItems.delete(item)
    pendingTaps.value = Math.max(0, pendingTaps.value - 1)
  })
}
async function doRecord(side, item) {
  if (!isSessionCurrent() || item.cancelled || item.epoch !== queueEpoch || !isActive.value || !isOnline.value) return
  item.inFlight = true
  loading.value = true
  errorText.value = ''
  try {
    const { data, error } = await supabase.rpc('record_point', {
      p_match_id: props.match.id, p_side: side, p_expected_revision: queueRevision,
    })
    if (!isSessionCurrent()) return
    if (error) {
      invalidateTapQueue({ includeInFlight: true })
      errorText.value = scoringError(error.message, t)
      emit('changed')
      return
    }
    queueRevision = data.revision
    if (!currentLiveScore.value || data.revision >= currentLiveScore.value.revision) currentLiveScore.value = data
    emit('changed')
  } catch (error) {
    invalidateTapQueue({ includeInFlight: true })
    errorText.value = scoringError(error?.message, t)
    emit('changed')
  } finally {
    item.inFlight = false
    loading.value = false
  }
}

async function stopLive() {
  if (!isSessionCurrent() || !props.canStopLive || loading.value || pendingTaps.value || !isActive.value || !isOnline.value) return
  const expected = revision.value
  if (!(await confirmDialog(t('scoringFlow.stopConfirm'), { danger: true }))) return
  if (!isSessionCurrent() || !isOnline.value) return
  queueEpoch += 1
  loading.value = true
  errorText.value = ''

  try {
    const { data, error } = await supabase.rpc('stop_live_match', {
      p_match_id: props.match.id,
      p_expected_revision: expected,
    })
    if (!isSessionCurrent()) return

    if (error) {
      errorText.value = isOnline.value ? scoringError(error.message, t) : ''
      emit('changed')
      return
    }

    if (!currentLiveScore.value || data.revision >= currentLiveScore.value.revision) currentLiveScore.value = data
    emit('changed')
  } catch (error) {
    errorText.value = isOnline.value ? scoringError(error?.message, t) : ''
    emit('changed')
  } finally {
    loading.value = false
  }
}
</script>

<template>
  <AppModal :label="t('live.scoringTitle')" @close="emit('close')">
    <div class="modal-dialog live-modal">
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('live.scoringTitle') }}</h2>
          <p class="live-modal__status">
            <span v-if="isActive" class="live-modal__badge"><span class="live-dot"></span>{{ t('live.live') }}</span>
            <span v-if="isActive && norm" class="live-modal__set">{{ norm.isMatchTiebreak ? t('tennisRules.matchTiebreak') : t('live.setN', { n: norm.currentSet }) }}</span>
            <span v-if="!isActive" class="muted">{{ statusText }}</span>
          </p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <div class="live-sides">
        <label class="switch">
          <input type="checkbox" :checked="autoSides" :disabled="!isSessionCurrent() || !isOnline || savingSides || (currentLiveScore && loading) || pendingTaps > 0" @change="toggleAutoSides" />
          <span class="switch__track"><span class="switch__thumb"></span></span>
          <span class="switch__label">{{ t('live.autoSwap') }}</span>
        </label>
        <button
          class="live-sides__swap"
          type="button"
          :aria-label="t('live.swapSides')"
          :title="t('live.swapSides')"
          :disabled="!isSessionCurrent() || !isOnline || savingSides || (currentLiveScore && loading) || pendingTaps > 0"
          @click="toggleSwapSides"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="17 4 21 8 17 12" />
            <line x1="21" y1="8" x2="4" y2="8" />
            <polyline points="7 12 3 16 7 20" />
            <line x1="3" y1="16" x2="20" y2="16" />
          </svg>
        </button>
      </div>

      <!-- Score rows keep a fixed A/B order — only the tap zones follow court ends. -->
      <div class="live-board">
        <div v-for="side in ['a', 'b']" :key="side" class="live-board__row">
          <strong class="live-board__name">{{ teamName(side) }}</strong>
          <span class="live-board__sets">{{ completedSets(side) }} {{ norm && !norm.winner && !norm.isMatchTiebreak ? norm.games[side] : '' }}</span>
          <span class="live-board__points">{{ pointLabel(state, side) }}</span>
        </div>
      </div>

      <p v-if="!state" class="muted">{{ tennisRulesSummary(scoringConfig, t) }}</p>
      <div v-if="liveRuleHint(state, t)" class="alert alert--info" role="status">{{ liveRuleHint(state, t) }}</div>
      <p v-if="state?.isTiebreak" class="muted live-rule-hint">{{ t(state.isMatchTiebreak ? 'tennisRules.matchServingHint' : state.tiebreakMargin === 1 ? 'tennisRules.shortServingHint' : 'tennisRules.servingHint') }}</p>

      <template v-if="!isFinished">
        <p class="live-modal__question">{{ t('live.whoWon') }}</p>

        <TransitionGroup name="side-swap" tag="div" class="live-tap-zones">
          <button
            v-for="side in sides"
            :key="side"
            class="live-tap"
            type="button"
            :disabled="!isSessionCurrent() || !isOnline || !isActive || savingSides"
            @click="record(side)"
          >
            <span class="live-tap__name">{{ teamName(side) }}</span>
          </button>
        </TransitionGroup>
      </template>

      <div class="live-modal__footer">
        <button class="btn btn--ghost btn--sm" type="button" :disabled="!isSessionCurrent() || !isOnline || !canUndo || !isActive" @click="record('undo')">
          {{ t('live.undo') }}
        </button>
        <button
          v-if="isStopped || !currentLiveScore"
          class="btn btn--ghost btn--sm"
          type="button"
          :disabled="!isSessionCurrent() || loading"
          @click="ensureStarted"
        >
          {{ t('scoringFlow.resume') }}
        </button>
        <button
          v-else-if="isActive && canStopLive"
          class="btn btn--ghost btn--sm"
          type="button"
          :disabled="!isSessionCurrent() || !isOnline || loading || pendingTaps > 0"
          @click="stopLive"
        >
          {{ t('scoringFlow.stop') }}
        </button>
        <span v-if="pendingTaps" class="live-modal__pending" role="status" aria-live="polite">
          {{ t('live.pendingPoints', { count: pendingTaps }) }}
        </span>
      </div>

      <p v-if="isStopped" class="alert alert--info" role="status">{{ t('scoringFlow.resumeRequired') }}</p>
      <p v-if="isActive && !canStopLive" class="muted">{{ t('scoringFlow.counterStop') }}</p>
      <p v-if="!isOnline" class="error-text" role="alert">{{ t('sync.offline') }}</p>
      <p v-if="cancelledTaps" class="error-text live-modal__cancelled" role="alert">{{ t('live.cancelledPoints', { count: cancelledTaps }) }}</p>
      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>
    </div>
  </AppModal>
</template>

<style scoped>
.live-rule-hint { font-size: .8rem; line-height: 1.5; }
.live-modal__status {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 4px 0 0;
  font-size: 0.8rem;
}

.live-modal__badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 9px;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--success-text);
  background: var(--success-bg);
  border-radius: 999px;
}

.live-modal__set {
  font-family: var(--font-mono);
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--muted);
}

.live-sides {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 2px 0;
}

.live-sides__swap {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  flex: none;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--surface);
  color: var(--muted);
  cursor: pointer;
  transition: color 0.15s, border-color 0.15s;
}

.live-sides__swap:hover {
  color: var(--text);
  border-color: var(--border-strong);
}

.live-board {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

/* FLIP glide when court ends flip after a game */
.side-swap-move {
  transition: transform 0.9s cubic-bezier(0.45, 0, 0.25, 1);
}

@media (prefers-reduced-motion: reduce) {
  .side-swap-move {
    transition: none;
  }
}

.live-board__row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  border-radius: var(--radius-sm);
  background: var(--surface-row);
  border: 1px solid var(--border);
}

.live-board__name {
  flex: 1;
  min-width: 0;
  font-size: 1rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.live-board__sets {
  font-family: var(--font-mono);
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--muted);
  letter-spacing: 0.1em;
}

.live-board__points {
  min-width: 2.4em;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--primary);
}

.live-modal__question {
  margin: var(--space-2) 0 0;
  text-align: center;
  font-size: 0.9rem;
  color: var(--muted);
}

.live-tap-zones {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-3);
}

.live-tap {
  min-height: 84px;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: var(--space-3);
  border: 1.5px solid var(--success-border);
  border-radius: var(--radius);
  background: var(--primary-muted);
  cursor: pointer;
  transition: border-color 0.12s, background 0.12s, transform 0.08s;
  -webkit-tap-highlight-color: transparent;
  user-select: none;
}

.live-tap:hover {
  border-color: var(--primary);
}

.live-tap:active {
  transform: scale(0.98);
  background: var(--success-bg);
}

.live-tap:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.live-tap__name {
  font-family: var(--font-display);
  font-size: 1.25rem;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text);
  text-align: center;
  word-break: break-word;
}

.live-modal__footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.live-modal__pending {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--muted);
}

@media (max-width: 480px) {
  .live-tap { min-height: 68px; }
}
</style>
