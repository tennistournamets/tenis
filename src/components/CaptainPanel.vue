<script setup>
// "My team" on the public tournament page: claiming a captain link, the captain's
// roster (until the start) and their ties with the state of their own lineup.
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import TeamRosterModal from './admin/TeamRosterModal.vue'
import { supabase } from '../lib/supabase'
import { errorMessage } from '../lib/errorMessages'
import { entryDisplayNames } from '../lib/entryDisplay'
import { claimCaptain, savePendingClaim } from '../lib/captainClaim'
import { useAuthStore } from '../stores/auth'

const props = defineProps({
  tournament: { type: Object, required: true },
  entriesMap: { type: Object, default: () => ({}) },
  ties: { type: Array, default: () => [] },
  submissions: { type: Object, default: () => ({}) },
  myEntries: { type: Array, default: () => [] },
  claimToken: { type: String, default: '' },
  justClaimed: { type: Boolean, default: false },
  claimedTeam: { type: String, default: '' }, // kept by the page across the URL clean-up
})
const emit = defineEmits(['changed', 'open-tie', 'claimed'])
const { t } = useI18n()
const auth = useAuthStore()

const status = ref(props.justClaimed ? 'done' : '')
const claimedName = computed(() => props.claimedTeam)
const errorText = ref('')
const rosterEntry = ref(null)

const teamName = id => entryDisplayNames(props.entriesMap[id]).join(' / ') || t('bracket.tbd')
const myTeams = computed(() => props.myEntries.map(id => props.entriesMap[id]).filter(Boolean))
const rosterEditable = computed(() => !['in_progress', 'completed'].includes(props.tournament.status))
const myTies = computed(() => props.ties
  .filter(m => props.myEntries.includes(m.side_a_entry_id) || props.myEntries.includes(m.side_b_entry_id))
  .filter(m => m.side_a_entry_id && m.side_b_entry_id)
  .sort((a, b) => (a.status === 'finished') - (b.status === 'finished') || a.round_number - b.round_number || a.match_number - b.match_number))
const mySide = tie => (props.myEntries.includes(tie.side_a_entry_id) ? 'A' : 'B')
const opponent = tie => teamName(mySide(tie) === 'A' ? tie.side_b_entry_id : tie.side_a_entry_id)
const lineupState = tie => (props.submissions[tie.id]?.[mySide(tie)] ? t('team.tie.submitted') : t('team.tie.waiting'))

async function claim() {
  if (!props.claimToken || status.value === 'claiming') return
  status.value = 'claiming'
  errorText.value = ''
  try {
    const data = await claimCaptain(supabase, props.claimToken)
    status.value = 'done'
    emit('claimed', data?.team_name || '')
    emit('changed')
  } catch (error) {
    status.value = 'error'
    errorText.value = errorMessage(error, t)
  }
}
async function signIn() {
  savePendingClaim(props.tournament.slug, props.claimToken)
  try { await auth.signInWithGoogle() } catch (error) { errorText.value = errorMessage(error, t) }
}
onMounted(() => { if (props.claimToken && auth.user) void claim() })
watch(() => auth.user?.id, id => { if (id && props.claimToken && !status.value) void claim() })

async function stepDown(entryId) {
  try {
    const { error } = await supabase.rpc('remove_team_captain', { p_entry_id: entryId, p_user_id: auth.user?.id })
    if (error) throw error
    emit('changed')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  }
}
</script>

<template>
  <section class="card captain-panel" aria-labelledby="captain-panel-title">
    <h2 id="captain-panel-title" class="section-title">{{ myTeams.length ? t('team.captain.myTeam') : t('team.captain.claimTitle') }}</h2>

    <template v-if="claimToken && !myTeams.length">
      <p v-if="status === 'claiming'" class="muted" role="status">{{ t('team.captain.claiming') }}</p>
      <template v-else-if="!auth.user">
        <p class="muted">{{ t('team.captain.claimHint') }}</p>
        <button type="button" class="btn btn--primary" @click="signIn">{{ t('team.captain.claimSignIn') }}</button>
      </template>
    </template>
    <p v-if="claimedName" class="alert alert--success" role="status">{{ t('team.captain.claimed', { team: claimedName }) }}</p>

    <div v-for="team in myTeams" :key="team.id" class="captain-panel__team">
      <div class="captain-panel__team-head">
        <strong class="captain-panel__name">{{ team.display_name }}</strong>
        <span class="muted">{{ t('team.roster.count', { n: (team.entry_members || []).length }) }}</span>
        <button type="button" class="btn btn--outline btn--sm" @click="rosterEntry = team">{{ t('team.roster.edit') }}</button>
      </div>
      <p v-if="!rosterEditable" class="field-hint">{{ t('team.roster.locked') }}</p>
    </div>

    <div v-if="myTeams.length" class="captain-panel__ties">
      <h3 class="section-title section-title--sm">{{ t('team.captain.myTies') }}</h3>
      <ul v-if="myTies.length" class="captain-panel__list">
        <li v-for="tie in myTies" :key="tie.id" class="captain-panel__tie">
          <span class="captain-panel__vs">— {{ opponent(tie) }}</span>
          <span v-if="tie.side_a_score != null" class="captain-panel__score">{{ tie.side_a_score }}:{{ tie.side_b_score }}</span>
          <span class="badge" :class="submissions[tie.id]?.[mySide(tie)] ? 'badge--success' : 'badge--neutral'">{{ lineupState(tie) }}</span>
          <button type="button" class="btn btn--primary btn--sm" @click="emit('open-tie', tie)">{{ t('team.tie.openTie') }}</button>
        </li>
      </ul>
      <p v-else class="muted">{{ t('team.captain.noTies') }}</p>
    </div>

    <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>
    <div v-if="myTeams.length" class="captain-panel__foot">
      <button v-for="team in myTeams" :key="team.id" type="button" class="btn btn--ghost btn--sm" @click="stepDown(team.id)">
        {{ t('team.captain.stepDown') }}<template v-if="myTeams.length > 1"> · {{ team.display_name }}</template>
      </button>
    </div>

    <TeamRosterModal
      v-if="rosterEntry"
      :tournament="tournament"
      :entry="rosterEntry"
      :can-manage="rosterEditable"
      captain-mode
      @saved="emit('changed')"
      @close="rosterEntry = null"
    />
  </section>
</template>

<style scoped>
.captain-panel { display: flex; flex-direction: column; gap: 12px; }
.captain-panel .section-title { margin: 0; }
.captain-panel__team-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.captain-panel__name { font-family: var(--font-display); font-size: 1.1rem; }
.captain-panel__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.captain-panel__tie { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; border: 1px solid var(--border); border-radius: var(--radius); padding: 8px 12px; }
.captain-panel__vs { flex: 1 1 12rem; min-width: 0; overflow-wrap: anywhere; }
.captain-panel__score { font-family: var(--font-mono); font-weight: 700; font-variant-numeric: tabular-nums; }
.captain-panel__foot { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
