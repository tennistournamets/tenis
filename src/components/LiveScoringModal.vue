<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { normalizeTennisState, pointLabel } from '../lib/useTennisScoring'
import { supabase } from '../lib/supabase'

import LiveRallyAnimation from './LiveRallyAnimation.vue'

const props = defineProps({
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

const currentLiveScore = ref(props.liveScore)
const loading = ref(false)
const errorText = ref('')
const pendingTaps = ref(0)

watch(
  () => props.liveScore,
  (next) => {
    if (next && next.match_id === props.match.id) {
      currentLiveScore.value = next
    }
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
  if (isFinished.value) return t('live.finished')
  if (isStopped.value) return t('live.stopped')
  return t('live.active')
})

function completedSets(side) {
  return (norm.value?.sets || [])
    .map((set) => (side === 'a' ? set.side_a_games : set.side_b_games))
    .join(' ')
}

async function ensureStarted() {
  if (currentLiveScore.value?.status === 'active' || currentLiveScore.value?.status === 'finished') {
    return
  }
  loading.value = true
  errorText.value = ''

  const { data, error } = await supabase.rpc('start_live_match', {
    p_match_id: props.match.id,
  })

  loading.value = false
  if (error) {
    errorText.value = error.message
    return
  }

  currentLiveScore.value = data
  emit('changed')
}

// Taps are serialized through a promise chain so fast consecutive taps
// queue up instead of being dropped while a request is in flight.
let tapQueue = Promise.resolve()

function record(side) {
  if (isFinished.value) return
  pendingTaps.value += 1
  tapQueue = tapQueue
    .then(() => doRecord(side))
    .catch(() => {})
    .finally(() => {
      pendingTaps.value = Math.max(0, pendingTaps.value - 1)
    })
}

async function doRecord(side) {
  if (isFinished.value) return

  await ensureStarted()
  if (!currentLiveScore.value || currentLiveScore.value.status !== 'active') {
    return
  }
  if (side === 'undo' && !(currentLiveScore.value?.history || []).length) {
    return
  }

  loading.value = true
  errorText.value = ''

  const { data, error } = await supabase.rpc('record_point', {
    p_match_id: props.match.id,
    p_side: side,
    p_expected_revision: revision.value,
  })

  loading.value = false
  if (error) {
    errorText.value = error.message
    emit('changed')
    return
  }

  currentLiveScore.value = data
  emit('changed')
}

async function stopLive() {
  if (loading.value || !currentLiveScore.value || isFinished.value) return
  loading.value = true
  errorText.value = ''

  const { data, error } = await supabase.rpc('stop_live_match', {
    p_match_id: props.match.id,
  })

  loading.value = false
  if (error) {
    errorText.value = error.message
    return
  }

  currentLiveScore.value = data
  emit('changed')
}
</script>

<template>
  <div class="modal-backdrop" @click="emit('close')">
    <div class="modal-dialog live-modal" role="dialog" aria-modal="true" @click.stop>
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('live.scoringTitle') }}</h2>
          <p class="live-modal__status">
            <span v-if="isActive" class="live-modal__badge"><span class="live-dot"></span>{{ t('live.live') }}</span>
            <span v-if="isActive && norm" class="live-modal__set">{{ t('live.setN', { n: norm.currentSet }) }}</span>
            <span v-if="!isActive" class="muted">{{ statusText }}</span>
          </p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <LiveRallyAnimation :state="state" :team-a="teamA" :team-b="teamB" />

      <div class="live-board">
        <div class="live-board__row">
          <strong class="live-board__name">{{ teamA }}</strong>
          <span class="live-board__sets">{{ completedSets('a') }} {{ norm ? norm.games.a : '' }}</span>
          <span class="live-board__points">{{ pointLabel(state, 'a') }}</span>
        </div>
        <div class="live-board__row">
          <strong class="live-board__name">{{ teamB }}</strong>
          <span class="live-board__sets">{{ completedSets('b') }} {{ norm ? norm.games.b : '' }}</span>
          <span class="live-board__points">{{ pointLabel(state, 'b') }}</span>
        </div>
      </div>

      <div v-if="state?.isTiebreak" class="alert alert--info" role="status">
        {{ t('live.tiebreak') }}
      </div>

      <template v-if="!isFinished">
        <p class="live-modal__question">{{ t('live.whoWon') }}</p>

        <div class="live-tap-zones">
          <button class="live-tap" type="button" :disabled="isFinished" @click="record('a')">
            <span class="live-tap__name">{{ teamA }}</span>
          </button>
          <button class="live-tap" type="button" :disabled="isFinished" @click="record('b')">
            <span class="live-tap__name">{{ teamB }}</span>
          </button>
        </div>
      </template>

      <div class="live-modal__footer">
        <button class="btn btn--ghost btn--sm" type="button" :disabled="!canUndo || isFinished" @click="record('undo')">
          {{ t('live.undo') }}
        </button>
        <button
          v-if="isStopped"
          class="btn btn--ghost btn--sm"
          type="button"
          :disabled="loading"
          @click="ensureStarted"
        >
          {{ t('live.start') }}
        </button>
        <button
          v-else-if="!isFinished"
          class="btn btn--ghost btn--sm"
          type="button"
          :disabled="loading"
          @click="stopLive"
        >
          {{ t('live.stop') }}
        </button>
        <span class="live-modal__rev">rev {{ revision }}<template v-if="pendingTaps"> · +{{ pendingTaps }}</template></span>
      </div>

      <p v-if="errorText" class="error-text">{{ errorText }}</p>
    </div>
  </div>
</template>

<style scoped>
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

.live-board {
  display: flex;
  flex-direction: column;
  gap: 6px;
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
  min-height: 120px;
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

.live-modal__rev {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 0.72rem;
  color: var(--muted);
}

@media (max-width: 480px) {
  .live-tap { min-height: 96px; }
}
</style>
