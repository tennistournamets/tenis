<script setup>
// The organizer's own rating of each player of an entry (set_member_rating).
// The player's value stays as given; the organizer's one is used for seeding.
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import { errorMessage } from '../../lib/errorMessages'
import { PADEL_LEVELS, formatRatingValue, parseRatingValue, ratingTypesFor } from '../../lib/playerRatings'
import { confirmDiscard } from '../../lib/unsavedChanges'
import { supabase } from '../../lib/supabase'

const props = defineProps({
  entry: { type: Object, required: true },
  sport: { type: String, required: true },
  // { [memberOrder]: [{ type, value, player, organizer }] } of this entry.
  ratings: { type: Object, default: null },
  title: { type: String, default: '' },
})
const emit = defineEmits(['close', 'saved'])
const { t } = useI18n()

const kinds = computed(() => ratingTypesFor(props.sport))
const members = computed(() => [...(props.entry.entry_members || [])].sort((a, b) => a.member_order - b.member_order))
const stored = (member, type) => (props.ratings?.[member.member_order] || []).find(r => r.type === type) || null
const text = value => (value == null ? '' : String(value))

// Draft of organizer values: { [memberId]: { [type]: 'text' } }.
const initial = Object.fromEntries((props.entry.entry_members || []).map(member => [member.id,
  Object.fromEntries(ratingTypesFor(props.sport).map(type => [type, text(stored(member, type)?.organizer)]))]))
const draft = reactive(JSON.parse(JSON.stringify(initial)))
const saving = ref(false)
const errorText = ref('')

const changes = computed(() => members.value.flatMap(member => kinds.value
  .filter(type => draft[member.id][type].trim() !== initial[member.id][type])
  .map(type => ({ member, type, raw: draft[member.id][type].trim() }))))
const dirty = computed(() => changes.value.length > 0)
const fieldId = (member, type) => `rating-org-${member.id}-${type}`

async function close() {
  if (!(await confirmDiscard(t, dirty.value, saving.value))) return
  emit('close')
}

async function submit() {
  if (saving.value || !dirty.value) return
  const bad = changes.value.find(change => change.raw !== '' && parseRatingValue(change.type, change.raw) == null)
  if (bad) {
    errorText.value = t('playerRating.errors.invalid')
    document.getElementById(fieldId(bad.member, bad.type))?.focus()
    return
  }
  saving.value = true
  errorText.value = ''
  let savedAny = false
  try {
    for (const change of changes.value) {
      const { error } = await supabase.rpc('set_member_rating', {
        p_member_id: change.member.id,
        p_type: change.type,
        p_value: change.raw === '' ? null : parseRatingValue(change.type, change.raw),
      })
      if (error) throw error
      initial[change.member.id][change.type] = change.raw
      savedAny = true
    }
    emit('saved')
    emit('close')
  } catch (error) {
    // Rows saved before the error are kept; the next save sends only the rest.
    errorText.value = errorMessage(error, t)
    if (savedAny) emit('saved')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal :label="t('playerRating.editTitle')" @close="close">
    <form class="modal-dialog ratings-modal" novalidate @submit.prevent="submit">
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('playerRating.editTitle') }}</h2>
          <p v-if="title" class="muted ratings-modal__entry">{{ title }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="close">×</button>
      </div>
      <p class="muted ratings-modal__hint">{{ t('playerRating.editHint') }}</p>

      <fieldset v-for="member in members" :key="member.id" class="ratings-modal__member" :disabled="saving">
        <legend v-if="members.length > 1" class="ratings-modal__name">{{ member.member_name }}</legend>
        <div v-for="type in kinds" :key="type" class="ratings-modal__row">
          <label :for="fieldId(member, type)" class="ratings-modal__kind">
            {{ t(`playerRating.kinds.${type}`) }}
            <span class="ratings-modal__player">
              {{ stored(member, type)?.player != null
                ? t('playerRating.playerGave', { value: formatRatingValue(type, stored(member, type).player) })
                : t('playerRating.playerNone') }}
            </span>
          </label>
          <select v-if="type === 'padel_level'" :id="fieldId(member, type)" v-model="draft[member.id][type]" class="input">
            <option value="">{{ t('playerRating.organizerNone') }}</option>
            <option v-for="[letter, level] in PADEL_LEVELS" :key="letter" :value="String(level)">{{ letter }} · {{ level.toFixed(1) }}</option>
          </select>
          <input
            v-else
            :id="fieldId(member, type)"
            v-model="draft[member.id][type]"
            class="input"
            type="text"
            :inputmode="type === 'tnl' ? 'decimal' : 'numeric'"
            autocomplete="off"
            maxlength="7"
            :placeholder="t(`playerRating.placeholders.${type}`)"
          />
        </div>
      </fieldset>

      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>

      <footer class="ratings-modal__actions">
        <button class="btn btn--ghost" type="button" :disabled="saving" @click="close">{{ t('actions.cancel') }}</button>
        <button class="btn btn--primary" type="submit" :disabled="saving || !dirty">
          <span v-if="saving" class="spinner" aria-hidden="true" />
          {{ t('playerRating.save') }}
        </button>
      </footer>
    </form>
  </AppModal>
</template>

<style scoped>
.ratings-modal { gap: var(--space-3); }
.ratings-modal__entry { overflow-wrap: anywhere; }
.ratings-modal__hint { margin: 0; font-size: var(--font-sm); line-height: 1.45; }
.ratings-modal__member { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: var(--space-2); }
.ratings-modal__name { padding: 0; margin-bottom: 4px; font-weight: 700; }
.ratings-modal__member + .ratings-modal__member { padding-top: var(--space-3); border-top: 1px solid var(--border); }
.ratings-modal__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 150px); gap: 4px 12px; align-items: center; }
.ratings-modal__kind { display: grid; gap: 2px; margin: 0; font-size: 0.875rem; font-weight: 600; }
.ratings-modal__player { font-weight: 400; color: var(--muted); font-size: 0.8125rem; }
.ratings-modal__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
@media (max-width: 420px) {
  .ratings-modal__row { grid-template-columns: 1fr; }
}
</style>
