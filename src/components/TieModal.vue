<script setup>
// A team tie: the two teams, the tie score, every match with its players and score,
// and the lineups. Organizers set both lineups and open a match's score or live
// scoring; a captain sets their own side; everyone else reads the protocol.
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from './AppModal.vue'
import TieLineupEditor from './TieLineupEditor.vue'
import { supabase } from '../lib/supabase'
import { errorMessage } from '../lib/errorMessages'
import { entryDisplayNames } from '../lib/entryDisplay'
import { matchScoringAction } from '../lib/scoringAccess'
import { lineSideNames, lineStarted, lineType, lineupDraft, tieFromConfig } from '../lib/teamTie'

const props = defineProps({
  tournament: { type: Object, required: true },
  tie: { type: Object, required: true },
  lines: { type: Array, default: () => [] },
  entriesMap: { type: Object, default: () => ({}) },
  members: { type: Object, default: () => ({}) },      // member id -> member
  lineups: { type: Object, default: () => ({}) },      // line id -> { A, B }
  submissions: { type: Object, default: () => ({}) },  // tie id -> { A, B }
  setsByMatch: { type: Object, default: () => ({}) },
  liveScoresByMatch: { type: Object, default: () => ({}) },
  role: { type: String, default: null },               // owner | editor | counter | null
  captainSides: { type: Array, default: () => [] },    // sides the viewer captains
})
const emit = defineEmits(['close', 'score', 'view-live', 'changed'])
const { t } = useI18n()

const tieCfg = computed(() => tieFromConfig(props.tournament.format_config?.tie))
const organizer = computed(() => ['owner', 'editor', 'counter'].includes(props.role))
const teamName = id => entryDisplayNames(props.entriesMap[id]).join(' / ') || t('bracket.tbd')
const sides = computed(() => [
  { key: 'A', entry: props.tie.side_a_entry_id, name: teamName(props.tie.side_a_entry_id) },
  { key: 'B', entry: props.tie.side_b_entry_id, name: teamName(props.tie.side_b_entry_id) },
])
const submitted = computed(() => props.submissions[props.tie.id] || {})
const anyStarted = computed(() => props.lines.some(line => lineStarted(line, props.liveScoresByMatch)))
const hasScore = computed(() => props.tie.side_a_score != null)
const outcome = computed(() => {
  if (props.tie.status !== 'finished') return ''
  return props.tie.winner_entry_id ? t('team.tie.winner', { team: teamName(props.tie.winner_entry_id) }) : t('team.tie.draw')
})

const lineLabel = line => (line.line_no > tieCfg.value.lines.length ? t('team.decider') : t('team.match', { n: line.line_no }))
function setsText(line) {
  const sets = props.setsByMatch[line.id] || []
  if (!sets.length) return line.side_a_score != null ? `${line.side_a_score}:${line.side_b_score}` : ''
  return sets.map(s => (s.score_kind === 'match_tiebreak' ? `[${s.side_a_tiebreak ?? 0}:${s.side_b_tiebreak ?? 0}]` : `${s.side_a_games}:${s.side_b_games}`)).join(' ')
}
function players(line, side) {
  const names = lineSideNames(props.lineups, props.members, line.id, side)
  if (names) return names
  return organizer.value || props.captainSides.includes(side) || bothVisible.value ? t('team.tie.notSet') : t('team.tie.hidden')
}
// The public sees lineups once both are in or play has started (the server filters the rows).
const bothVisible = computed(() => Boolean(submitted.value.A && submitted.value.B) || anyStarted.value)
const lineWinner = (line, side) => line.status === 'finished' && line.winner_entry_id === props.tie[`side_${side.toLowerCase()}_entry_id`]
const scoreAction = line => (line.status === 'pending' ? null : matchScoringAction(props.tournament, props.role, line))

function sideStatus(side) {
  if (submitted.value[side]) return t('team.tie.submitted')
  const filled = props.lines.some(line => (props.lineups[line.id]?.[side] || []).length)
  return filled ? t('team.tie.draft') : t('team.tie.waiting')
}
const allStarted = computed(() => props.lines.length > 0 && props.lines.every(line => lineStarted(line, props.liveScoresByMatch)))
const canEditSide = side => (organizer.value
  ? props.tournament.status !== 'completed' && !allStarted.value
  : props.captainSides.includes(side) && !submitted.value[side] && !anyStarted.value && props.tournament.status !== 'completed')

// Lineup editing, one side at a time.
const editing = ref(null) // 'A' | 'B'
const busy = ref(false)
const errorText = ref('')
const notice = ref('')
const roster = side => {
  const entry = props.entriesMap[side === 'A' ? props.tie.side_a_entry_id : props.tie.side_b_entry_id]
  return [...(entry?.entry_members || [])].sort((a, b) => a.member_order - b.member_order)
}
const lockedLines = computed(() => Object.fromEntries(props.lines.filter(l => lineStarted(l, props.liveScoresByMatch)).map(l => [l.line_no, true])))
async function saveLineup(side, { lines, submit }) {
  busy.value = true
  errorText.value = ''
  notice.value = ''
  try {
    const { error } = await supabase.rpc('save_tie_lineup', { p_tie_id: props.tie.id, p_side: side, p_lines: lines, p_submit: submit })
    if (error) throw error
    editing.value = null
    notice.value = t('team.tie.saved')
    emit('changed')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally { busy.value = false }
}
async function reopen(side) {
  busy.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('reopen_tie_lineup', { p_tie_id: props.tie.id, p_side: side })
    if (error) throw error
    emit('changed')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally { busy.value = false }
}
</script>

<template>
  <AppModal :label="t('team.tie.title')" @close="emit('close')">
    <div class="modal-dialog tie-modal">
      <div class="modal-dialog__head">
        <h2>{{ t('team.tie.title') }}</h2>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>
      <header class="tie-modal__head">
        <div class="tie-modal__team tie-modal__team--a">{{ sides[0].name }}</div>
        <div class="tie-modal__score" :aria-label="t('team.tie.title')">
          <span>{{ hasScore ? tie.side_a_score : '–' }}</span><span class="tie-modal__colon">:</span><span>{{ hasScore ? tie.side_b_score : '–' }}</span>
        </div>
        <div class="tie-modal__team tie-modal__team--b">{{ sides[1].name }}</div>
      </header>
      <p class="tie-modal__meta muted">
        {{ t('team.tie.scoreRule', { rule: t(tieCfg.win_rule === 'games' ? 'team.tie.byGames' : 'team.tie.byRubbers') }) }}<template v-if="outcome"> · <strong>{{ outcome }}</strong></template>
      </p>

      <ol class="tie-modal__lines">
        <li v-for="line in lines" :key="line.id" class="tie-modal__line" :class="{ 'is-finished': line.status === 'finished' }">
          <div class="tie-modal__line-head">
            <strong>{{ lineLabel(line) }}</strong>
            <span class="muted">{{ t(`team.lineTypes.${lineType(tieCfg, line.line_no)}`) }}</span>
            <span v-if="liveScoresByMatch[line.id]?.status === 'active'" class="badge badge--live">LIVE</span>
          </div>
          <div class="tie-modal__line-body">
            <span class="tie-modal__players" :class="{ 'is-winner': lineWinner(line, 'A') }">{{ players(line, 'A') }}</span>
            <span class="tie-modal__sets">{{ setsText(line) || '—' }}</span>
            <span class="tie-modal__players tie-modal__players--b" :class="{ 'is-winner': lineWinner(line, 'B') }">{{ players(line, 'B') }}</span>
          </div>
          <div v-if="organizer && tournament.status === 'in_progress'" class="tie-modal__line-actions">
            <template v-if="scoreAction(line)">
              <button v-if="scoreAction(line) === 'live'" type="button" class="btn btn--outline btn--sm" @click="emit('score', line, 'live')">{{ t('team.tie.live') }}</button>
              <button v-if="role !== 'counter' || scoreAction(line) === 'result'" type="button" class="btn btn--primary btn--sm" @click="emit('score', line, 'result')">{{ t('team.tie.enterScore') }}</button>
            </template>
            <span v-else-if="line.status === 'pending'" class="muted">{{ t('team.tie.noLineup') }}</span>
          </div>
          <div v-else-if="liveScoresByMatch[line.id]?.status === 'active'" class="tie-modal__line-actions">
            <button type="button" class="btn btn--outline btn--sm" @click="emit('view-live', line)">{{ t('team.tie.live') }}</button>
          </div>
        </li>
      </ol>

      <section class="tie-modal__lineups">
        <h3 class="section-title section-title--sm">{{ t('team.tie.lineups') }}</h3>
        <div v-for="side in sides" :key="side.key" class="tie-modal__side">
          <div class="tie-modal__side-head">
            <strong>{{ side.name }}</strong>
            <span class="badge" :class="submitted[side.key] ? 'badge--success' : 'badge--neutral'">{{ sideStatus(side.key) }}</span>
            <button v-if="editing !== side.key && canEditSide(side.key) && side.entry" type="button" class="btn btn--ghost btn--sm"
              :disabled="busy" @click="editing = side.key">{{ t('team.tie.editLineup') }}</button>
            <button v-if="organizer && submitted[side.key] && !anyStarted" type="button" class="btn btn--ghost btn--sm"
              :disabled="busy" @click="reopen(side.key)">{{ t('team.tie.reopen') }}</button>
          </div>
          <p v-if="!organizer && captainSides.includes(side.key) && submitted[side.key]" class="field-hint">{{ t('team.tie.submittedNote') }}</p>
          <TieLineupEditor
            v-if="editing === side.key"
            :tie="tieCfg"
            :lines="lines"
            :roster="roster(side.key)"
            :initial="lineupDraft(tieCfg, lines, lineups, side.key)"
            :locked="lockedLines"
            :mode="organizer ? 'organizer' : 'captain'"
            :busy="busy"
            :id-prefix="`lineup-${tie.id}-${side.key}`"
            @save="saveLineup(side.key, $event)"
            @cancel="editing = null"
          />
        </div>
      </section>

      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>
      <p v-if="notice" class="muted" role="status">{{ notice }}</p>
    </div>
  </AppModal>
</template>

<style scoped>
.tie-modal { display: flex; flex-direction: column; gap: 14px; width: min(760px, 100%); max-height: min(900px, 100%); }
.tie-modal .modal-dialog__head { margin-bottom: 0; }
.tie-modal__head { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 12px; align-items: center; }
.tie-modal__team { font-family: var(--font-display); font-weight: 700; font-size: 1.15rem; line-height: 1.2; overflow-wrap: anywhere; }
.tie-modal__team--b { text-align: right; }
.tie-modal__score {
  font-family: var(--font-mono); font-weight: 700; font-size: 1.6rem; font-variant-numeric: tabular-nums;
  background: var(--lime); color: #1b2410; border-radius: var(--radius-sm); padding: 2px 12px; display: flex; gap: 4px;
}
.tie-modal__meta { margin: 0; }
.tie-modal__lines { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.tie-modal__line { border: 1px solid var(--border); border-radius: var(--radius); padding: 10px 12px; display: grid; gap: 6px; }
.tie-modal__line.is-finished { background: var(--surface-2); }
.tie-modal__line-head { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; }
.tie-modal__line-head .muted { font-size: 0.88rem; }
.tie-modal__line-body { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); gap: 10px; align-items: center; }
.tie-modal__players { overflow-wrap: anywhere; }
.tie-modal__players--b { text-align: right; }
.tie-modal__players.is-winner { font-weight: 700; }
.tie-modal__sets { font-family: var(--font-mono); font-variant-numeric: tabular-nums; white-space: nowrap; }
.tie-modal__line-actions { display: flex; justify-content: flex-end; gap: 8px; align-items: center; }
.tie-modal__lineups { border-top: 1px solid var(--border); padding-top: 12px; display: grid; gap: 12px; }
.tie-modal__lineups .section-title { margin: 0; }
.tie-modal__side { display: grid; gap: 8px; }
.tie-modal__side-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
@media (max-width: 520px) {
  .tie-modal__team { font-size: 1rem; }
  .tie-modal__score { font-size: 1.3rem; }
}
</style>
