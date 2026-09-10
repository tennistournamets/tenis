<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import BracketMatchCard from './BracketMatchCard.vue'
import InfiniteCanvas from './InfiniteCanvas.vue'

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
  editableSlots: {
    type: Boolean,
    default: false,
  },
  liveScoresByMatch: {
    type: Object,
    default: () => ({}),
  },
  canLiveScore: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['swap-slots', 'view-live'])

const { t } = useI18n()

const innerRef = ref(null)
const canvasRef = ref(null)
const connectorPaths = ref([])
const svgW = ref(0)
const svgH = ref(0)
const selectedSlot = ref(null)

function selectSlot(slot) {
  if (!props.editableSlots) return
  if (!selectedSlot.value) {
    selectedSlot.value = slot
    return
  }
  if (selectedSlot.value.matchId === slot.matchId && selectedSlot.value.side === slot.side) {
    selectedSlot.value = null
    return
  }
  emit('swap-slots', {
    fromMatchId: selectedSlot.value.matchId,
    fromSide: selectedSlot.value.side,
    toMatchId: slot.matchId,
    toSide: slot.side,
  })
  selectedSlot.value = null
}

watch(() => props.editableSlots, (editable) => {
  if (!editable) selectedSlot.value = null
})

const rounds = computed(() => {
  const bucket = new Map()
  for (const match of props.matches) {
    const round = match.round_number
    if (!bucket.has(round)) {
      bucket.set(round, [])
    }
    bucket.get(round).push(match)
  }
  return [...bucket.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([roundNumber, roundMatches]) => ({
      roundNumber,
      matches: roundMatches.sort((a, b) => a.match_number - b.match_number),
    }))
})

const totalRounds = computed(() => rounds.value.length)

/** Championship match (no next_match_id). */
const finalMatch = computed(() => {
  const list = props.matches
  if (!list.length) {
    return null
  }
  const roots = list.filter((m) => !m.next_match_id)
  if (roots.length) {
    return roots.reduce((a, b) => (a.round_number >= b.round_number ? a : b))
  }
  return null
})

/**
 * left / right from bracket tree: feeder to slot A → left half, slot B → right half.
 * Matches user intent: even split; structure from DB preserves pairing.
 */
const branchByMatchId = computed(() => {
  const map = new Map()
  const root = finalMatch.value
  if (!root || !props.matches.length) {
    return map
  }
  map.set(root.id, 'center')

  function walk(matchId, branch) {
    const children = props.matches
      .filter((m) => m.next_match_id === matchId)
      .sort((a, b) => {
        const sa = a.next_slot === 'B' ? 1 : 0
        const sb = b.next_slot === 'B' ? 1 : 0
        return sa - sb
      })
    for (const c of children) {
      let b = branch
      if (branch === 'center') {
        b = c.next_slot === 'B' ? 'right' : 'left'
      }
      map.set(c.id, b)
      walk(c.id, b)
    }
  }

  walk(root.id, 'center')
  return map
})

/** Split layout: left rounds (1..R-1) → final → right rounds (R-1..1). */
const splitLayout = computed(() => {
  const root = finalMatch.value
  const branches = branchByMatchId.value
  if (!root || branches.size === 0) {
    return null
  }
  if (props.matches.some((m) => !branches.has(m.id))) {
    return null
  }
  const rMax = Math.max(...props.matches.map((m) => m.round_number), 1)
  const leftSections = []
  for (let r = 1; r < rMax; r++) {
    const ms = props.matches
      .filter((m) => m.round_number === r && branches.get(m.id) === 'left')
      .sort((a, b) => a.match_number - b.match_number)
    if (ms.length) {
      leftSections.push({ roundNumber: r, matches: ms, key: `L-${r}` })
    }
  }
  const centerSection = {
    roundNumber: rMax,
    matches: [root],
    key: 'C',
  }
  const rightSections = []
  for (let r = 1; r < rMax; r++) {
    const ms = props.matches
      .filter((m) => m.round_number === r && branches.get(m.id) === 'right')
      .sort((a, b) => a.match_number - b.match_number)
    if (ms.length) {
      rightSections.push({ roundNumber: r, matches: ms, key: `R-${r}` })
    }
  }
  rightSections.sort((a, b) => b.roundNumber - a.roundNumber)
  return { leftSections, centerSection, rightSections }
})

/** Flat column order for template: left → final → right */
const splitSectionsFlat = computed(() => {
  const s = splitLayout.value
  if (!s) {
    return []
  }
  return [
    ...s.leftSections.map((sec) => ({ ...sec, columnKind: 'wing' })),
    { ...s.centerSection, columnKind: 'final' },
    ...s.rightSections.map((sec) => ({ ...sec, columnKind: 'wing' })),
  ]
})

function roundLabel(roundNumber) {
  const n = totalRounds.value
  if (n === 0) {
    return ''
  }
  if (roundNumber === n) {
    return t('bracket.final')
  }
  if (roundNumber === n - 1) {
    return t('bracket.semifinals')
  }
  if (roundNumber === n - 2) {
    return t('bracket.quarterfinals')
  }
  return t('bracket.roundN', { n: roundNumber })
}

function getBox(el, container) {
  const er = el.getBoundingClientRect()
  const cr = container.getBoundingClientRect()
  const s = canvasRef.value?.scale ?? 1
  return {
    left: (er.left - cr.left) / s,
    top: (er.top - cr.top) / s,
    right: (er.right - cr.left) / s,
    bottom: (er.bottom - cr.top) / s,
    width: er.width / s,
    height: er.height / s,
  }
}

function updateConnectors() {
  const inner = innerRef.value
  if (!inner || !props.matches.length) {
    connectorPaths.value = []
    svgW.value = 0
    svgH.value = 0
    return
  }

  svgW.value = inner.scrollWidth
  svgH.value = inner.scrollHeight

  const paths = []
  for (const m of props.matches) {
    if (!m.next_match_id) {
      continue
    }
    const elFrom = inner.querySelector(`[data-match-id="${m.id}"]`)
    const elTo = inner.querySelector(`[data-match-id="${m.next_match_id}"]`)
    if (!elFrom || !elTo) {
      continue
    }
    const b1 = getBox(elFrom, inner)
    const b2 = getBox(elTo, inner)
    const y1 = b1.top + b1.height / 2
    const y2 = b2.top + b2.height / 2
    const c1 = b1.left + b1.width / 2
    const c2 = b2.left + b2.width / 2
    let x1
    let x2
    if (c2 >= c1) {
      x1 = b1.right
      x2 = b2.left
    } else {
      x1 = b1.left
      x2 = b2.right
    }
    const mid = (x1 + x2) / 2
    paths.push(`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`)
  }
  connectorPaths.value = paths
}

let ro = null
let debounceTimer = null

function scheduleUpdate() {
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    nextTick(() => updateConnectors())
  }, 50)
}

onMounted(() => {
  nextTick(() => {
    updateConnectors()
    const inner = innerRef.value
    if (inner && typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(scheduleUpdate)
      ro.observe(inner)
    }
    // Center the bracket on initial load
    nextTick(() => {
      canvasRef.value?.fitToView()
    })
  })
  window.addEventListener('resize', scheduleUpdate)
})

onBeforeUnmount(() => {
  clearTimeout(debounceTimer)
  window.removeEventListener('resize', scheduleUpdate)
  if (ro) {
    ro.disconnect()
    ro = null
  }
})

watch(
  () => [props.matches, props.setsByMatch, props.entriesMap, props.liveScoresByMatch],
  () => scheduleUpdate(),
  { deep: true },
)

watch(rounds, (newVal, oldVal) => {
  scheduleUpdate()
  // Auto-center when bracket first appears or round count changes
  if (newVal.length && (!oldVal || !oldVal.length || newVal.length !== oldVal.length)) {
    nextTick(() => {
      setTimeout(() => canvasRef.value?.fitToView(), 100)
    })
  }
}, { deep: true })

watch(splitSectionsFlat, () => scheduleUpdate(), { deep: true })
</script>

<template>
  <InfiniteCanvas v-if="rounds.length" ref="canvasRef" @transform-change="scheduleUpdate">
    <div ref="innerRef" class="bracket-inner">
      <svg
        class="bracket-svg"
        :width="svgW || 1"
        :height="svgH || 1"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden="true"
      >
        <path v-for="(d, i) in connectorPaths" :key="i" :d="d" />
      </svg>
      <div v-if="splitLayout" class="bracket-columns bracket-columns--split">
        <section
          v-for="sec in splitSectionsFlat"
          :key="sec.key"
          class="bracket-round"
          :class="{ 'bracket-round--final': sec.columnKind === 'final' }"
        >
          <h4 class="bracket-round__title">{{ roundLabel(sec.roundNumber) }}</h4>
          <BracketMatchCard
            v-for="match in sec.matches"
            :key="match.id"
            :match="match"
            :sets-by-match="setsByMatch"
            :entries-map="entriesMap"
            :editable-slots="editableSlots"
            :selected-slot-key="selectedSlot ? `${selectedSlot.matchId}-${selectedSlot.side}` : ''"
            :live-score="liveScoresByMatch[match.id]"
            :can-live-score="canLiveScore"
            @swap-slots="emit('swap-slots', $event)"
            @select-slot="selectSlot"
            @view-live="emit('view-live', $event)"
          />
        </section>
      </div>

      <div v-else class="bracket-columns">
        <section v-for="round in rounds" :key="round.roundNumber" class="bracket-round">
          <h4 class="bracket-round__title">{{ roundLabel(round.roundNumber) }}</h4>
          <BracketMatchCard
            v-for="match in round.matches"
            :key="match.id"
            :match="match"
            :sets-by-match="setsByMatch"
            :entries-map="entriesMap"
            :editable-slots="editableSlots"
            :selected-slot-key="selectedSlot ? `${selectedSlot.matchId}-${selectedSlot.side}` : ''"
            :live-score="liveScoresByMatch[match.id]"
            :can-live-score="canLiveScore"
            @swap-slots="emit('swap-slots', $event)"
            @select-slot="selectSlot"
            @view-live="emit('view-live', $event)"
          />
        </section>
      </div>
    </div>
  </InfiniteCanvas>
  <p v-else class="muted">{{ t('bracket.empty') }}</p>
</template>
