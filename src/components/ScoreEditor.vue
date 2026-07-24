<script setup>
import { computed, reactive, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { entryMemberNames } from '../lib/entryDisplay'
import { supabase } from '../lib/supabase'

const props = defineProps({
  matches: {
    type: Array,
    default: () => [],
  },
  setsByMatch: {
    type: Object,
    default: () => ({}),
  },
  entriesMap: {
    type: Object,
    default: () => ({}),
  },
  setFormat: {
    type: String,
    default: 'best_of_3',
  },
  category: {
    type: String,
    default: 'singles',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  canLiveScore: {
    type: Boolean,
    default: false,
  },
  liveScoresByMatch: {
    type: Object,
    default: () => ({}),
  },
})

const emit = defineEmits(['saved', 'start-live'])

const { t } = useI18n()
const setForms = reactive({})
const savedFlash = reactive({})

const totalSetRows = () => (props.setFormat === 'best_of_5' ? 5 : 3)

function initializeRows(matchId) {
  const existing = [...(props.setsByMatch[matchId] || [])].sort((a, b) => a.set_index - b.set_index)
  const rows = []

  for (let i = 1; i <= totalSetRows(); i += 1) {
    const saved = existing.find((item) => item.set_index === i)
    rows.push({
      set_index: i,
      side_a_games: saved ? saved.side_a_games : '',
      side_b_games: saved ? saved.side_b_games : '',
      saving: false,
      error: '',
    })
  }

  setForms[matchId] = rows
}

watch(
  () => [props.matches, props.setsByMatch, props.setFormat],
  () => {
    props.matches.forEach((match) => {
      initializeRows(match.id)
    })
  },
  { immediate: true, deep: true },
)

const matchesByRound = computed(() => {
  const map = new Map()
  for (const m of props.matches) {
    if (!map.has(m.round_number)) {
      map.set(m.round_number, [])
    }
    map.get(m.round_number).push(m)
  }
  return [...map.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([roundNumber, list]) => ({
      roundNumber,
      matches: list.sort((a, b) => a.match_number - b.match_number),
    }))
})

const totalRounds = computed(() => {
  if (!matchesByRound.value.length) return 0
  return Math.max(...matchesByRound.value.map((g) => g.roundNumber))
})

function roundLabel(roundNumber) {
  const n = totalRounds.value
  if (n === 0) return ''
  if (roundNumber === n) return t('bracket.final')
  if (roundNumber === n - 1) return t('bracket.semifinals')
  if (roundNumber === n - 2) return t('bracket.quarterfinals')
  return t('bracket.roundN', { n: roundNumber })
}

const isDoubles = computed(() => props.category === 'doubles')

function teamLabel(entryId) {
  if (!entryId) {
    return t('bracket.tbd')
  }
  const names = entryMemberNames(props.entriesMap[entryId])
  return names.length ? names.join(' / ') : t('bracket.tbd')
}

function canScore(match) {
  return Boolean(match.side_a_entry_id && match.side_b_entry_id)
}

function liveStatus(matchId) {
  return props.liveScoresByMatch[matchId]?.status || null
}

async function save(match) {
  const rows = setForms[match.id] || []
  rows.forEach((row) => {
    row.error = ''
  })

  if (props.disabled) {
    if (rows[0]) {
      rows[0].error = t('admin.scoresLockedError')
    }
    return
  }

  if (!canScore(match)) {
    return
  }

  const payload = rows
    .filter((row) => row.side_a_games !== '' && row.side_b_games !== '' && row.side_a_games != null && row.side_b_games != null)
    .map((row) => ({
      set_index: row.set_index,
      side_a_games: Number(row.side_a_games),
      side_b_games: Number(row.side_b_games),
    }))

  rows.forEach((row) => {
    row.saving = true
  })

  const { error } = await supabase.rpc('update_match_sets', {
    p_match_id: match.id,
    p_sets: payload,
  })

  rows.forEach((row) => {
    row.saving = false
  })

  if (error) {
    if (rows[0]) {
      rows[0].error = error.message
    }
    return
  }

  savedFlash[match.id] = true
  setTimeout(() => {
    savedFlash[match.id] = false
  }, 2000)

  emit('saved')
}
</script>

<template>
  <section class="card score-editor">
    <h2 class="section-title">{{ t('admin.saveScore') }}</h2>
    <p class="muted">{{ t('admin.setsHint') }}</p>
    <p v-if="disabled" class="alert alert--info" role="status">{{ t('admin.scoresLockedError') }}</p>

    <template v-for="group in matchesByRound" :key="group.roundNumber">
      <h3 class="section-title" style="font-size: 1rem; margin-top: var(--space-3)">
        {{ roundLabel(group.roundNumber) }}
      </h3>

      <article
        v-for="match in group.matches"
        :key="match.id"
        class="score-match"
        :class="{ 'score-match--saved': savedFlash[match.id], 'score-match--pending': !canScore(match) }"
      >
        <div class="score-match__head" :class="{ 'score-match__head--doubles': isDoubles }">
          <div class="score-match__teams">
            <div class="score-match__team">
              <span class="score-match__player">{{ teamLabel(match.side_a_entry_id) }}</span>
            </div>
            <span class="score-match__vs muted">vs</span>
            <div class="score-match__team">
              <span class="score-match__player">{{ teamLabel(match.side_b_entry_id) }}</span>
            </div>
          </div>
        </div>

        <div class="score-grid">
          <div class="score-grid__header">
            <div class="score-grid__player-col"></div>
            <div
              v-for="row in setForms[match.id] || []"
              :key="`h-${match.id}-${row.set_index}`"
              class="score-grid__set-col"
            >
              {{ row.set_index }}
            </div>
          </div>

          <div class="score-grid__row">
            <div class="score-grid__player-col score-grid__player-name">
              {{ teamLabel(match.side_a_entry_id) }}
            </div>
            <div
              v-for="row in setForms[match.id] || []"
              :key="`a-${match.id}-${row.set_index}`"
              class="score-grid__set-col"
            >
              <input
                v-model="row.side_a_games"
                type="number"
                min="0"
                max="7"
                class="score-grid__input"
                :disabled="disabled || !canScore(match) || row.saving"
                :placeholder="'—'"
              />
            </div>
          </div>

          <div class="score-grid__row">
            <div class="score-grid__player-col score-grid__player-name">
              {{ teamLabel(match.side_b_entry_id) }}
            </div>
            <div
              v-for="row in setForms[match.id] || []"
              :key="`b-${match.id}-${row.set_index}`"
              class="score-grid__set-col"
            >
              <input
                v-model="row.side_b_games"
                type="number"
                min="0"
                max="7"
                class="score-grid__input"
                :disabled="disabled || !canScore(match) || row.saving"
                :placeholder="'—'"
              />
            </div>
          </div>
        </div>

        <button class="btn btn--primary btn--sm" type="button" :disabled="disabled || !canScore(match)" @click="save(match)">
          {{ t('admin.saveScore') }}
        </button>
        <Transition name="saved-pop">
          <span v-if="savedFlash[match.id]" class="score-saved-badge">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg>
            {{ t('actions.saved') }}
          </span>
        </Transition>
        <button
          v-if="canLiveScore"
          class="btn btn--ghost btn--sm"
          type="button"
          :disabled="!canScore(match)"
          @click="emit('start-live', match)"
        >
          {{ liveStatus(match.id) === 'active' ? t('live.openLive') : t('live.start') }}
        </button>
        <span v-if="liveStatus(match.id) === 'active'" class="badge badge--warn">
          <span class="live-dot"></span>
          {{ t('live.live') }}
        </span>

        <p v-if="(setForms[match.id] || [])[0]?.error" class="error-text" style="margin-top: var(--space-2)">
          {{ (setForms[match.id] || [])[0]?.error }}
        </p>
      </article>
    </template>

    <p v-if="!matches.length" class="muted">{{ t('bracket.empty') }}</p>
  </section>
</template>

<style scoped>
.score-saved-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: var(--space-2);
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
