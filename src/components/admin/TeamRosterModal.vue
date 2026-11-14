<script setup>
// A team's roster (names and gender) and captain, for the organizer; with no entry it
// adds a new team. Saves through add_team_entry / save_team_roster; the captain link
// comes from create_captain_invite (single use, 30 days).
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import { supabase } from '../../lib/supabase'
import { errorMessage } from '../../lib/errorMessages'
import { confirmDialog } from '../../lib/confirmDialog'
import { tournamentShareUrl } from '../../lib/shareLink'
import { tieFromConfig } from '../../lib/teamTie'

const props = defineProps({
  tournament: { type: Object, required: true },
  entry: { type: Object, default: null },
  canManage: { type: Boolean, default: false },
  // A team captain edits the roster: no captain section, the team cannot be renamed.
  captainMode: { type: Boolean, default: false },
})
const emit = defineEmits(['close', 'saved'])
const { t } = useI18n()

const creating = computed(() => !props.entry)
const tie = computed(() => tieFromConfig(props.tournament.format_config?.tie))
const teamName = ref(props.entry?.display_name || '')
const contact = ref('')
const players = ref(
  props.entry
    ? [...(props.entry.entry_members || [])].sort((a, b) => a.member_order - b.member_order)
      .map(m => ({ id: m.id, name: m.member_name, gender: m.gender || '' }))
    : [{ name: '', gender: '' }, { name: '', gender: '' }],
)
const saving = ref(false)
const errorText = ref('')
const savedText = ref('')
const locked = computed(() => !props.canManage || props.tournament.status === 'completed')

function addPlayer() {
  if (players.value.length < tie.value.roster_max) players.value.push({ name: '', gender: '' })
}
function removePlayer(index) {
  players.value.splice(index, 1)
}

async function save() {
  errorText.value = ''
  savedText.value = ''
  const members = players.value
    .map(p => ({ ...(p.id ? { id: p.id } : {}), name: p.name.trim(), gender: p.gender || null }))
    .filter(p => p.name || p.id)
  saving.value = true
  try {
    const { error } = creating.value
      ? await supabase.rpc('add_team_entry', {
        p_tournament_id: props.tournament.id, p_team_name: teamName.value, p_members: members,
        p_contact: contact.value.trim() || null, p_status: 'approved',
      })
      : await supabase.rpc('save_team_roster', { p_entry_id: props.entry.id, p_members: members, p_team_name: props.captainMode ? null : teamName.value })
    if (error) throw error
    emit('saved')
    if (creating.value) emit('close')
    else savedText.value = t('team.roster.saved')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally { saving.value = false }
}

// Captain: who it is (owner/editor only) and a fresh invitation link.
const captains = ref([])
const captainLink = ref('')
const copied = ref(false)
const captainBusy = ref(false)
async function loadCaptains() {
  if (creating.value) return
  const { data } = await supabase.rpc('list_team_captains', { p_tournament_id: props.tournament.id })
  captains.value = (data || []).filter(row => row.entry_id === props.entry.id)
}
onMounted(() => { if (!props.captainMode) loadCaptains() })

async function createLink() {
  errorText.value = ''
  captainBusy.value = true
  try {
    const { data, error } = await supabase.rpc('create_captain_invite', { p_entry_id: props.entry.id })
    if (error) throw error
    const base = tournamentShareUrl(props.tournament.slug)
    captainLink.value = `${base}${base.includes('?') ? '&' : '?'}captain=${data.token}`
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally { captainBusy.value = false }
}
async function copyLink(event) {
  copied.value = false
  try {
    await navigator.clipboard.writeText(captainLink.value)
    copied.value = true
  } catch {
    event?.target?.closest('.team-roster__link')?.querySelector('input')?.select()
  }
}
async function removeCaptain() {
  if (!(await confirmDialog(t('team.captain.removeConfirm', { team: props.entry.display_name })))) return
  captainBusy.value = true
  try {
    const { error } = await supabase.rpc('remove_team_captain', { p_entry_id: props.entry.id, p_user_id: null })
    if (error) throw error
    await loadCaptains()
    emit('saved')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally { captainBusy.value = false }
}
</script>

<template>
  <AppModal :label="creating ? t('team.roster.addTeamTitle') : t('team.roster.title')" @close="emit('close')">
    <form class="modal-dialog team-roster" @submit.prevent="save">
      <div class="modal-dialog__head">
        <div>
          <h2>{{ creating ? t('team.roster.addTeamTitle') : t('team.roster.title') }}</h2>
          <p v-if="!creating" class="muted team-roster__sub">{{ entry.display_name }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <fieldset class="team-roster__fields" :disabled="saving || locked">
        <div class="form-field">
          <label for="team-name">{{ t('team.roster.teamName') }}</label>
          <input id="team-name" v-model="teamName" class="input" type="text" maxlength="80" required autocomplete="off" :readonly="captainMode" />
        </div>
        <div v-if="creating" class="form-field">
          <label for="team-contact">{{ t('team.roster.contact') }}</label>
          <input id="team-contact" v-model="contact" class="input" type="text" autocomplete="off" />
        </div>

        <div class="team-roster__players">
          <div class="team-roster__players-head">
            <span class="team-roster__label">{{ t('team.roster.players') }}</span>
            <span class="muted">{{ t('team.roster.count', { n: players.length }) }}</span>
          </div>
          <p class="field-hint">{{ t('team.roster.genderHint') }}</p>
          <ol class="team-roster__list">
            <li v-for="(player, index) in players" :key="player.id || `new-${index}`" class="team-roster__row">
              <span class="team-roster__no" aria-hidden="true">{{ index + 1 }}</span>
              <input :id="`team-player-${index}`" v-model="player.name" class="input" type="text" maxlength="100"
                :aria-label="t('team.roster.player', { n: index + 1 })" :placeholder="t('team.roster.playerName')" autocomplete="off" />
              <select v-model="player.gender" class="input team-roster__gender" :aria-label="t('team.roster.gender')">
                <option value="">{{ t('team.roster.genderUnknown') }}</option>
                <option value="male">{{ t('team.roster.male') }}</option>
                <option value="female">{{ t('team.roster.female') }}</option>
              </select>
              <button type="button" class="btn btn--ghost btn--sm" :disabled="players.length < 2"
                :aria-label="t('team.roster.removePlayer', { name: player.name || index + 1 })" @click="removePlayer(index)">×</button>
            </li>
          </ol>
          <button type="button" class="btn btn--outline btn--sm" :disabled="players.length >= tie.roster_max" @click="addPlayer">
            + {{ t('team.roster.addPlayer') }}
          </button>
        </div>
      </fieldset>

      <section v-if="!creating && canManage && !captainMode" class="team-roster__captain">
        <h3 class="section-title section-title--sm">{{ t('team.captain.title') }}</h3>
        <p v-if="captains.length" class="team-roster__captain-row">
          <span v-for="c in captains" :key="c.user_id">{{ t('team.captain.set', { name: c.name || c.email }) }}<span v-if="c.name && c.email" class="muted"> · {{ c.email }}</span></span>
          <button type="button" class="btn btn--ghost btn--sm" :disabled="captainBusy" @click="removeCaptain">{{ t('team.captain.remove') }}</button>
        </p>
        <p v-else class="muted">{{ t('team.captain.none') }}</p>
        <p class="field-hint">{{ t('team.captain.linkHint') }}</p>
        <div v-if="captainLink" class="team-roster__link">
          <label class="sr-only" for="team-captain-link">{{ t('team.captain.linkTitle') }}</label>
          <input id="team-captain-link" class="input" type="text" readonly :value="captainLink" @focus="$event.target.select()" />
          <button type="button" class="btn btn--primary btn--sm" @click="copyLink">{{ t('team.captain.copyLink') }}</button>
        </div>
        <p v-if="copied" class="muted" role="status">{{ t('team.captain.copied') }}</p>
        <button v-if="!captainLink" type="button" class="btn btn--outline btn--sm" :disabled="captainBusy || tournament.status === 'completed'" @click="createLink">
          {{ t('team.captain.createLink') }}
        </button>
      </section>

      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>
      <p v-if="savedText" class="muted" role="status">{{ savedText }}</p>
      <footer v-if="!locked" class="team-roster__actions">
        <button type="button" class="btn btn--ghost" @click="emit('close')">{{ t('actions.close') }}</button>
        <button type="submit" class="btn btn--primary" :disabled="saving">{{ creating ? t('team.roster.addTeam') : t('team.roster.save') }}</button>
      </footer>
    </form>
  </AppModal>
</template>

<style scoped>
.team-roster { display: flex; flex-direction: column; gap: 16px; width: min(640px, 100%); max-height: min(860px, 100%); }
.team-roster .modal-dialog__head { margin-bottom: 0; }
.team-roster__sub { margin: 2px 0 0; }
.team-roster__fields { border: 0; margin: 0; padding: 0; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.team-roster__players-head { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
.team-roster__label { font-weight: 600; }
.team-roster__list { list-style: none; margin: 8px 0; padding: 0; display: grid; gap: 8px; }
.team-roster__row { display: grid; grid-template-columns: 1.75rem minmax(0, 1fr) minmax(7rem, 9rem) auto; gap: 8px; align-items: center; }
.team-roster__no { color: var(--text-muted); font-variant-numeric: tabular-nums; text-align: right; }
.team-roster__captain { border-top: 1px solid var(--border); padding-top: 14px; display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.team-roster__captain .section-title { margin: 0; }
.team-roster__captain-row { display: flex; flex-wrap: wrap; align-items: center; gap: 10px; margin: 0; }
.team-roster__link { display: flex; gap: 8px; width: 100%; }
.team-roster__link .input { flex: 1; min-width: 0; font-size: 0.85rem; }
.team-roster__actions { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 520px) {
  .team-roster__row { grid-template-columns: minmax(0, 1fr) minmax(6.5rem, 8rem) auto; }
  .team-roster__no { display: none; }
}
</style>
