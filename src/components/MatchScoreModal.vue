<script setup>
// Single-match final score entry, opened from the round-robin crosstable/accordion.
// Form logic and RPC payloads mirror ScoreEditor.vue (sets) and
// FootballScoreEditor.vue (goals) — keep the three in sync on scoring changes.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { entryMemberNames } from '../lib/entryDisplay'
import { supabase } from '../lib/supabase'

const props = defineProps({
  match: { type: Object, required: true },
  entriesMap: { type: Object, default: () => ({}) },
  family: { type: String, default: 'sets' },
  setFormat: { type: String, default: 'best_of_3' },
  sets: { type: Array, default: () => [] },
  canEditFinal: { type: Boolean, default: false },
  canLiveScore: { type: Boolean, default: false },
  liveStatus: { type: String, default: null },
})

const emit = defineEmits(['close', 'saved', 'start-live'])

const { t } = useI18n()

const saving = ref(false)
const savedFlash = ref(false)
const errorText = ref('')

function teamLabel(entryId) {
  if (!entryId) return t('bracket.tbd')
  const names = entryMemberNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}

// --- sets form ---
const totalSetRows = props.setFormat === 'best_of_5' ? 5 : 3
const setRows = ref(
  Array.from({ length: totalSetRows }, (_, i) => {
    const saved = props.sets.find((s) => s.set_index === i + 1)
    return {
      set_index: i + 1,
      side_a_games: saved ? saved.side_a_games : '',
      side_b_games: saved ? saved.side_b_games : '',
    }
  }),
)

// --- goals form ---
const goals = ref({
  a: props.match.side_a_score ?? '',
  b: props.match.side_b_score ?? '',
  pa: props.match.side_a_pens ?? '',
  pb: props.match.side_b_pens ?? '',
})

const isSets = computed(() => props.family === 'sets')

async function save() {
  if (!props.canEditFinal || saving.value) return
  errorText.value = ''
  let rpc

  if (isSets.value) {
    const payload = setRows.value
      .filter((r) => r.side_a_games !== '' && r.side_b_games !== '' && r.side_a_games != null && r.side_b_games != null)
      .map((r) => ({
        set_index: r.set_index,
        side_a_games: Number(r.side_a_games),
        side_b_games: Number(r.side_b_games),
      }))
    rpc = supabase.rpc('update_match_sets', { p_match_id: props.match.id, p_sets: payload })
  } else {
    const a = Number(goals.value.a)
    const b = Number(goals.value.b)
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 0 || b < 0) {
      errorText.value = t('football.goals')
      return
    }
    rpc = supabase.rpc('update_football_result', {
      p_match_id: props.match.id,
      p_a_goals: a,
      p_b_goals: b,
      p_a_pens: goals.value.pa === '' || goals.value.pa == null ? null : Number(goals.value.pa),
      p_b_pens: goals.value.pb === '' || goals.value.pb == null ? null : Number(goals.value.pb),
    })
  }

  saving.value = true
  const { error } = await rpc
  saving.value = false

  if (error) {
    errorText.value = error.message
    return
  }

  savedFlash.value = true
  emit('saved')
  setTimeout(() => emit('close'), 600)
}
</script>

<template>
  <div class="modal-backdrop" @click="emit('close')">
    <div class="modal-dialog" role="dialog" aria-modal="true" @click.stop>
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('standings.matchScore') }}</h2>
          <p class="muted">{{ teamLabel(match.side_a_entry_id) }} vs {{ teamLabel(match.side_b_entry_id) }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <p v-if="!canEditFinal" class="alert alert--info" role="status">{{ t('admin.scoresLockedError') }}</p>

      <!-- sets sports -->
      <div v-if="isSets" class="msm-grid">
        <div class="msm-grid__row msm-grid__row--head">
          <span></span>
          <span v-for="r in setRows" :key="`h-${r.set_index}`" class="msm-grid__set">{{ r.set_index }}</span>
        </div>
        <div class="msm-grid__row">
          <span class="msm-grid__name">{{ teamLabel(match.side_a_entry_id) }}</span>
          <input
            v-for="r in setRows"
            :key="`a-${r.set_index}`"
            v-model="r.side_a_games"
            class="input msm-grid__input"
            type="number"
            min="0"
            max="7"
            placeholder="—"
            :disabled="!canEditFinal || saving"
          />
        </div>
        <div class="msm-grid__row">
          <span class="msm-grid__name">{{ teamLabel(match.side_b_entry_id) }}</span>
          <input
            v-for="r in setRows"
            :key="`b-${r.set_index}`"
            v-model="r.side_b_games"
            class="input msm-grid__input"
            type="number"
            min="0"
            max="7"
            placeholder="—"
            :disabled="!canEditFinal || saving"
          />
        </div>
      </div>

      <!-- goals sports -->
      <div v-else class="stack stack--sm">
        <div class="msm-goals">
          <span class="msm-grid__name">{{ teamLabel(match.side_a_entry_id) }}</span>
          <input v-model="goals.a" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || saving" :aria-label="t('football.goals')" />
          <span class="muted">:</span>
          <input v-model="goals.b" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || saving" :aria-label="t('football.goals')" />
          <span class="msm-grid__name msm-goals__right">{{ teamLabel(match.side_b_entry_id) }}</span>
        </div>
        <div class="msm-goals">
          <span class="msm-goals__pens-label muted">{{ t('football.pens') }}</span>
          <input v-model="goals.pa" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || saving" :aria-label="t('football.pens')" />
          <span class="muted">:</span>
          <input v-model="goals.pb" class="input msm-grid__input" type="number" min="0" :disabled="!canEditFinal || saving" :aria-label="t('football.pens')" />
          <span class="msm-goals__right"></span>
        </div>
        <p class="muted" style="font-size: var(--font-sm)">{{ t('football.penHint') }}</p>
      </div>

      <div class="msm-actions">
        <button class="btn btn--primary btn--sm" type="button" :disabled="!canEditFinal || saving" @click="save">
          {{ t('admin.saveScore') }}
        </button>
        <button
          v-if="canLiveScore"
          class="btn btn--ghost btn--sm"
          type="button"
          @click="emit('start-live', match)"
        >
          {{ liveStatus === 'active' ? t('live.openLive') : t('live.start') }}
        </button>
        <span v-if="liveStatus === 'active'" class="badge badge--warn">
          <span class="live-dot"></span>
          {{ t('live.live') }}
        </span>
        <Transition name="saved-pop">
          <span v-if="savedFlash" class="score-saved-badge">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            {{ t('actions.saved') }}
          </span>
        </Transition>
      </div>

      <p v-if="errorText" class="error-text">{{ errorText }}</p>
    </div>
  </div>
</template>

<style scoped>
.msm-grid {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.msm-grid__row {
  display: grid;
  grid-template-columns: 1fr repeat(v-bind(totalSetRows), 52px);
  gap: 8px;
  align-items: center;
}
.msm-grid__row--head {
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--muted);
  text-align: center;
}
.msm-grid__set {
  text-align: center;
}
.msm-grid__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.msm-grid__input {
  width: 52px;
  text-align: center;
}
.msm-goals {
  display: flex;
  align-items: center;
  gap: 8px;
}
.msm-goals__right {
  flex: 1;
  text-align: right;
}
.msm-goals__pens-label {
  font-size: var(--font-sm);
  min-width: 0;
}
.msm-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-top: var(--space-2);
}
.score-saved-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 11px;
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--success-text);
  background: var(--success-bg);
  border-radius: 999px;
}
.saved-pop-enter-active,
.saved-pop-leave-active {
  transition: opacity 0.2s, transform 0.2s;
}
.saved-pop-enter-from,
.saved-pop-leave-to {
  opacity: 0;
  transform: scale(0.9);
}
</style>
