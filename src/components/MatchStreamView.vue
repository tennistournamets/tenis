<script setup>
// Phone stream view: the match score on top (about a quarter of the screen,
// no court animation) and the YouTube player below. Opened from MatchStreamLink
// on narrow screens (?watch=<match id>); wide screens open YouTube in a new tab.
// The score follows the tournament snapshot, so points change as they are played.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from './AppModal.vue'
import { completedSetCount } from '../lib/bracketDisplay'
import { matchStreamUrl, youtubeEmbedUrl } from '../lib/matchStream'
import { normalizeTennisState, pointLabel } from '../lib/useTennisScoring'

const props = defineProps({
  match: { type: Object, required: true },
  teamA: { type: String, required: true },
  teamB: { type: String, required: true },
  sets: { type: Array, default: () => [] },
  liveScore: { type: Object, default: null },
  // sets | goals | points
  family: { type: String, default: 'sets' },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const url = computed(() => matchStreamUrl(props.match))
const embedUrl = computed(() => youtubeEmbedUrl(url.value))
const isLive = computed(() => props.liveScore?.status === 'active')
const liveState = computed(() => props.liveScore?.state || null)
const isPoints = computed(() => props.family === 'points' || liveState.value?.family === 'points')
const isGoals = computed(() => !isPoints.value && props.family === 'goals')
const other = side => (side === 'a' ? 'b' : 'a')
const winnerSide = computed(() => {
  const m = props.match
  if (m.winner_entry_id && m.winner_entry_id === m.side_a_entry_id) return 'a'
  if (m.winner_entry_id && m.winner_entry_id === m.side_b_entry_id) return 'b'
  return null
})
const statusText = computed(() => {
  if (isLive.value) return t('live.live')
  if (props.match.status === 'finished') return t('live.finished')
  return t('tournament.notPlayed')
})

// One side's cells: games per set (the current set marked), or the single
// total of a points / football match. The rally in progress is shown apart.
function cells(side) {
  if (isPoints.value || isGoals.value) {
    const value = isLive.value && isPoints.value ? liveState.value?.points?.[side] ?? 0 : props.match[`side_${side}_score`]
    return [{ key: 'total', value: value ?? '–', won: winnerSide.value === side }]
  }
  if (isLive.value) {
    const live = normalizeTennisState(liveState.value)
    return [
      ...live.sets.map((s, i) => ({ key: `l${i}`, value: s[`side_${side}_games`], won: Number(s[`side_${side}_games`]) > Number(s[`side_${other(side)}_games`]) })),
      ...(live.winner ? [] : [{ key: 'current', value: live.isMatchTiebreak ? live.tiebreakPoints[side] : live.games[side], current: true }]),
    ]
  }
  const sorted = [...props.sets].sort((a, b) => a.set_index - b.set_index)
  const completed = completedSetCount(props.match)
  return sorted.map((s, i) => {
    const key = s.score_kind === 'match_tiebreak' ? 'tiebreak' : 'games'
    return {
      key: s.set_index,
      value: s[`side_${side}_${key}`],
      current: i >= completed,
      won: i < completed && Number(s[`side_${side}_${key}`]) > Number(s[`side_${other(side)}_${key}`]),
    }
  })
}
const showPoint = computed(() => isLive.value && !isPoints.value && !normalizeTennisState(liveState.value).winner)
const point = side => pointLabel(liveState.value, side)
const pens = computed(() => (isGoals.value && props.match.side_a_pens != null && props.match.side_b_pens != null
  ? `${props.match.side_a_pens}:${props.match.side_b_pens}` : ''))
</script>

<template>
  <AppModal :label="t('stream.title')" fullscreen @close="emit('close')">
    <div class="stream-view">
      <section class="stream-view__score" :aria-label="t('standings.matchScore')" aria-live="polite">
        <div class="stream-view__bar">
          <span class="stream-view__status" :class="{ 'stream-view__status--live': isLive }">
            <span v-if="isLive" class="live-dot" aria-hidden="true"></span>{{ statusText }}
          </span>
          <a class="stream-view__youtube" :href="url" target="_blank" rel="noopener noreferrer">YouTube <span aria-hidden="true">↗</span></a>
          <button class="stream-view__close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
        </div>
        <div class="stream-view__rows">
        <div v-for="side in ['a', 'b']" :key="side" class="stream-view__row" :class="{ 'stream-view__row--won': winnerSide === side }">
          <span class="stream-view__name">{{ side === 'a' ? teamA : teamB }}</span>
          <span class="stream-view__cells">
            <span
              v-for="cell in cells(side)"
              :key="cell.key"
              class="stream-view__cell"
              :class="{ 'is-won': cell.won, 'is-current': cell.current }"
            >{{ cell.value }}</span>
            <span v-if="showPoint" class="stream-view__cell stream-view__cell--point">{{ point(side) }}</span>
          </span>
        </div>
        <p v-if="pens" class="stream-view__pens">{{ t('football.pens') }} {{ pens }}</p>
        </div>
      </section>

      <div class="stream-view__player">
        <iframe
          v-if="embedUrl"
          :src="embedUrl"
          :title="t('stream.watchAria', { teamA, teamB })"
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowfullscreen
          referrerpolicy="strict-origin-when-cross-origin"
        ></iframe>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.stream-view {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  background: #000;
}
.stream-view__score {
  flex: 0 0 25%;
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-height: 0;
  overflow: hidden;
  padding: calc(6px + var(--safe-area-top)) calc(14px + var(--safe-area-right)) 10px calc(14px + var(--safe-area-left));
  background: var(--surface);
  color: var(--text);
  border-bottom: 1px solid var(--border);
}
.stream-view__bar { display: flex; align-items: center; gap: 12px; }
/* The bar keeps to the top edge; the score takes the rest, centered. */
.stream-view__rows { flex: 1; display: flex; flex-direction: column; justify-content: center; gap: 6px; min-height: 0; }
.stream-view__status { display: inline-flex; align-items: center; gap: 6px; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); }
.stream-view__status--live { color: var(--accent-text); }
.stream-view__youtube { margin-left: auto; font-size: 0.8125rem; font-weight: 600; }
.stream-view__close {
  display: inline-flex; align-items: center; justify-content: center;
  width: 36px; height: 36px; border: 1px solid var(--border); border-radius: 50%;
  background: transparent; color: var(--text); font-size: 1.35rem; line-height: 1; cursor: pointer;
}
.stream-view__row { display: flex; align-items: center; gap: 10px; min-width: 0; }
.stream-view__name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; font-size: 0.95rem; }
.stream-view__row--won .stream-view__name { color: var(--primary); }
.stream-view__cells { display: inline-flex; gap: 4px; flex-shrink: 0; font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
.stream-view__cell { min-width: 1.6em; padding: 2px 4px; text-align: center; border-radius: 6px; color: var(--muted); font-size: 1rem; }
.stream-view__cell.is-won { color: var(--text); font-weight: 700; }
.stream-view__cell.is-current { color: var(--text); background: var(--surface-row); }
.stream-view__cell--point { min-width: 2.2em; color: var(--primary-contrast); background: var(--primary); font-weight: 700; }
.stream-view__pens { margin: 0; font-size: 0.8rem; color: var(--muted); text-align: right; }
.stream-view__player {
  flex: 1 1 75%;
  min-height: 0;
  padding-bottom: var(--safe-area-bottom);
  background: #000;
}
.stream-view__player iframe { display: block; width: 100%; height: 100%; border: 0; }
</style>
