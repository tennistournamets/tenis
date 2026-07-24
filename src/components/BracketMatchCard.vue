<script setup>
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'

import { entryMemberNames } from '../lib/entryDisplay'
import { pointLabel, scoreLine } from '../lib/useTennisScoring'

const props = defineProps({
  match: {
    type: Object,
    required: true,
  },
  setsByMatch: {
    type: Object,
    default: () => ({}),
  },
  entriesMap: {
    type: Object,
    default: () => ({}),
  },
  editableSlots: {
    type: Boolean,
    default: false,
  },
  liveScore: {
    type: Object,
    default: null,
  },
  canLiveScore: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['swap-slots', 'view-live'])

const { t } = useI18n()

const dragOverKey = ref(null)

function memberLines(entryId) {
  if (!entryId) {
    return [t('bracket.tbd')]
  }
  const names = entryMemberNames(props.entriesMap[entryId])
  return names.length ? names : [t('bracket.tbd')]
}

function isStacked(entryId) {
  return memberLines(entryId).length >= 2
}

function setSummary(matchId) {
  const sets = [...(props.setsByMatch[matchId] || [])].sort((a, b) => a.set_index - b.set_index)
  if (!sets.length) {
    return '—'
  }
  return sets.map((set) => `${set.side_a_games}:${set.side_b_games}`).join(' · ')
}

const matchFinished = () => props.match.status === 'finished'
const hasLiveScore = () => props.liveScore?.status === 'active'
const canScoreMatch = () =>
  props.canLiveScore
  && !matchFinished()
  && Boolean(props.match.side_a_entry_id)
  && Boolean(props.match.side_b_entry_id)

function rowKey(side) {
  return `${props.match.id}-${side}`
}

function onDragStart(event, side, entryId) {
  if (!props.editableSlots || matchFinished() || !entryId) {
    event.preventDefault()
    return
  }
  event.dataTransfer.setData(
    'application/json',
    JSON.stringify({ matchId: props.match.id, side }),
  )
  event.dataTransfer.effectAllowed = 'move'
  try {
    event.dataTransfer.setDragImage(event.currentTarget, event.currentTarget.offsetWidth / 2, 16)
  } catch {
    /* ignore */
  }
}

function onDragEnd() {
  dragOverKey.value = null
}

function onDragOver(event, side) {
  if (!props.editableSlots || matchFinished()) {
    return
  }
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
  dragOverKey.value = rowKey(side)
}

function onDragLeave(event, side) {
  if (event.currentTarget.contains(event.relatedTarget)) {
    return
  }
  if (dragOverKey.value === rowKey(side)) {
    dragOverKey.value = null
  }
}

function onDrop(event, toSide) {
  dragOverKey.value = null
  if (!props.editableSlots || matchFinished()) {
    return
  }
  event.preventDefault()
  let payload
  try {
    payload = JSON.parse(event.dataTransfer.getData('application/json') || '{}')
  } catch {
    return
  }
  if (!payload.matchId || !payload.side) {
    return
  }
  const fromSide = payload.side
  const fromMatchId = payload.matchId
  if (fromMatchId === props.match.id && fromSide === toSide) {
    return
  }
  emit('swap-slots', {
    fromMatchId,
    fromSide,
    toMatchId: props.match.id,
    toSide,
  })
}

function rowClass(side, entryId, winner) {
  const k = rowKey(side)
  return {
    'match-card__row--winner': Boolean(entryId) && winner,
    'match-card__row--slot-editable': props.editableSlots && !matchFinished(),
    'match-card__row--drag-over': dragOverKey.value === k && props.editableSlots && !matchFinished(),
    'match-card__row--draggable': props.editableSlots && !matchFinished() && Boolean(entryId),
    'match-card__row--stacked': isStacked(entryId),
  }
}
</script>

<template>
  <article class="match-card" :class="{ 'match-card--live': hasLiveScore() }" :data-match-id="match.id">
    <div v-if="canScoreMatch()" class="match-card__meta match-card__meta--top">
      <button
        class="match-card__score-btn"
        type="button"
        :aria-label="t('live.start')"
        @click="emit('view-live', match)"
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <rect x="2" y="3" width="12" height="10" rx="1.5" />
          <line x1="8" y1="3" x2="8" y2="13" />
          <line x1="4.5" y1="6.5" x2="6" y2="6.5" />
          <line x1="4.5" y1="9.5" x2="6" y2="9.5" />
          <line x1="10" y1="6.5" x2="11.5" y2="6.5" />
          <line x1="10" y1="9.5" x2="11.5" y2="9.5" />
        </svg>
      </button>
    </div>
    <div
      class="match-card__row"
      :class="rowClass('a', match.side_a_entry_id, match.winner_entry_id === match.side_a_entry_id)"
      :draggable="editableSlots && !matchFinished() && Boolean(match.side_a_entry_id)"
      @dragstart="onDragStart($event, 'a', match.side_a_entry_id)"
      @dragend="onDragEnd"
      @dragover="onDragOver($event, 'a')"
      @dragleave="onDragLeave($event, 'a')"
      @drop="onDrop($event, 'a')"
    >
      <div v-if="isStacked(match.side_a_entry_id)" class="match-card__members">
        <span v-for="(n, i) in memberLines(match.side_a_entry_id)" :key="`a-${i}`" class="match-card__member">{{ n }}</span>
      </div>
      <span v-else class="match-card__name">{{ memberLines(match.side_a_entry_id)[0] }}</span>
    </div>
    <div
      class="match-card__row"
      :class="rowClass('b', match.side_b_entry_id, match.winner_entry_id === match.side_b_entry_id)"
      :draggable="editableSlots && !matchFinished() && Boolean(match.side_b_entry_id)"
      @dragstart="onDragStart($event, 'b', match.side_b_entry_id)"
      @dragend="onDragEnd"
      @dragover="onDragOver($event, 'b')"
      @dragleave="onDragLeave($event, 'b')"
      @drop="onDrop($event, 'b')"
    >
      <div v-if="isStacked(match.side_b_entry_id)" class="match-card__members">
        <span v-for="(n, i) in memberLines(match.side_b_entry_id)" :key="`b-${i}`" class="match-card__member">{{ n }}</span>
      </div>
      <span v-else class="match-card__name">{{ memberLines(match.side_b_entry_id)[0] }}</span>
    </div>
    <div class="match-card__meta">
      <template v-if="(setsByMatch[match.id] || []).length">
        {{ t('tournament.sets') }}: <span class="match-card__score">{{ setSummary(match.id) }}</span>
      </template>
      <template v-else-if="match.side_a_score != null && match.side_b_score != null">
        <span class="match-card__score">
          {{ match.side_a_score }} : {{ match.side_b_score }}
          <template v-if="match.side_a_pens != null && match.side_b_pens != null">
            ({{ match.side_a_pens }}:{{ match.side_b_pens }} {{ t('football.pens') }})
          </template>
        </span>
      </template>
      <template v-else>
        <span class="match-card__score">—</span>
      </template>
      <button
        v-if="hasLiveScore()"
        class="match-card__live"
        type="button"
        @click="emit('view-live', match)"
      >
        <span class="live-dot"></span>
        {{ t('live.live') }}
        <span class="match-card__score">{{ scoreLine(liveScore.state) }}</span>
        <span class="match-card__score">{{ pointLabel(liveScore.state, 'a') }}:{{ pointLabel(liveScore.state, 'b') }}</span>
      </button>
    </div>
  </article>
</template>
