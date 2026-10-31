<script setup>
// Correct an entry (update_entry): player names, a replaced player, the
// bracket name and the contact. Matches and results stay with the entry.
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import { customDisplayName } from '../../lib/entryDisplay'
import { errorMessage } from '../../lib/errorMessages'
import { entryNamesError } from '../../lib/registrationRules'
import { isIndividualFormat, scoringFamily } from '../../lib/sportConfig'
import { confirmDiscard } from '../../lib/unsavedChanges'
import { supabase } from '../../lib/supabase'

const props = defineProps({
  entry: { type: Object, required: true },
  tournament: { type: Object, required: true },
  // { phone, email } from get_entry_contacts, or null.
  contact: { type: Object, default: null },
})
const emit = defineEmits(['close', 'saved'])
const { t } = useI18n()

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const phonePattern = /^\+?[\d\s\-()]{7,20}$/

const members = [...(props.entry.entry_members || [])].sort((a, b) => a.member_order - b.member_order)
const isGoals = scoringFamily(props.tournament.sport || 'tennis') === 'goals'
const isPair = members.length > 1
const showDisplayName = isPair || isGoals || (props.tournament.category === 'doubles' && !isIndividualFormat(props.tournament.format))

const initial = {
  names: members.map(m => m.member_name || ''),
  replace: members.map(() => false),
  displayName: customDisplayName(props.entry),
  phone: props.contact?.phone || '',
  email: props.contact?.email || '',
}
const draft = reactive(JSON.parse(JSON.stringify(initial)))
const saving = ref(false)
const errorText = ref('')

const nameChanged = i => draft.names[i].trim() !== initial.names[i].trim()
const dirty = computed(() => JSON.stringify(draft) !== JSON.stringify(initial))

function memberLabel(i) {
  if (isGoals) return t('registrationForm.teamName')
  if (!isPair) return t('registrationForm.member')
  return i === 0 ? t('registrationForm.memberOne') : t('registrationForm.memberTwo')
}

async function close() {
  if (!(await confirmDiscard(t, dirty.value, saving.value))) return
  emit('close')
}

async function submit() {
  if (saving.value || !dirty.value) return
  const names = draft.names.map(name => name.trim().replace(/\s+/g, ' '))
  const emptyAt = names.findIndex(name => !name)
  if (emptyAt >= 0) {
    errorText.value = t('entryEdit.errors.nameRequired')
    document.getElementById(`entry-edit-name-${emptyAt}`)?.focus()
    return
  }
  const namesError = entryNamesError(props.entry.entry_type, names[0], names[1] || '', draft.displayName)
  if (namesError) { errorText.value = t(namesError); return }
  const phone = draft.phone.trim()
  const email = draft.email.trim()
  if (phone && !phonePattern.test(phone)) { errorText.value = t('entryEdit.errors.invalidPhone'); return }
  if (email && !emailPattern.test(email)) { errorText.value = t('entryEdit.errors.invalidEmail'); return }

  saving.value = true
  errorText.value = ''
  try {
    const { error } = await supabase.rpc('update_entry', {
      p_entry_id: props.entry.id,
      p_members: names,
      p_replace: draft.replace.map((value, i) => value && nameChanged(i)),
      p_display_name: draft.displayName.trim() || null,
      p_phone: phone || null,
      p_email: email || null,
    })
    if (error) throw error
    emit('saved')
    emit('close')
  } catch (error) {
    errorText.value = errorMessage(error, t)
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <AppModal :label="t('entryEdit.title')" @close="close">
    <form class="modal-dialog entry-edit" novalidate @submit.prevent="submit">
      <div class="modal-dialog__head">
        <h2>{{ t('entryEdit.title') }}</h2>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="close">×</button>
      </div>
      <p class="muted entry-edit__hint">{{ t('entryEdit.hint') }}</p>

      <fieldset class="entry-edit__group" :disabled="saving">
        <div v-for="(member, i) in members" :key="member.id" class="form-field">
          <label :for="`entry-edit-name-${i}`">{{ memberLabel(i) }}</label>
          <input
            :id="`entry-edit-name-${i}`"
            v-model="draft.names[i]"
            class="input"
            type="text"
            maxlength="100"
            autocomplete="off"
            required
          />
          <label v-if="nameChanged(i)" class="checkbox-row entry-edit__replace" :for="`entry-edit-replace-${i}`">
            <input :id="`entry-edit-replace-${i}`" v-model="draft.replace[i]" type="checkbox" />
            <span>{{ t('entryEdit.replace') }} <span class="muted">{{ t('entryEdit.replaceHint') }}</span></span>
          </label>
        </div>
        <div v-if="showDisplayName" class="form-field">
          <label for="entry-edit-display">{{ t('registrationForm.displayName') }}</label>
          <input id="entry-edit-display" v-model="draft.displayName" class="input" type="text" maxlength="160" autocomplete="off" />
        </div>
      </fieldset>

      <fieldset class="entry-edit__group entry-edit__contacts" :disabled="saving">
        <div class="form-field">
          <label for="entry-edit-phone">{{ t('registrationForm.phone') }}</label>
          <input id="entry-edit-phone" v-model="draft.phone" class="input" type="tel" inputmode="tel" autocomplete="off" maxlength="20" />
        </div>
        <div class="form-field">
          <label for="entry-edit-email">{{ t('registrationForm.email') }}</label>
          <input id="entry-edit-email" v-model="draft.email" class="input" type="email" inputmode="email" autocomplete="off" maxlength="254" />
        </div>
        <p class="field-hint entry-edit__contact-hint">{{ t('entryEdit.contactHint') }}</p>
      </fieldset>

      <p v-if="errorText" class="error-text" role="alert">{{ errorText }}</p>

      <footer class="entry-edit__actions">
        <button class="btn btn--ghost" type="button" :disabled="saving" @click="close">{{ t('actions.cancel') }}</button>
        <button class="btn btn--primary" type="submit" :disabled="saving || !dirty">
          <span v-if="saving" class="spinner" aria-hidden="true" />
          {{ t('entryEdit.save') }}
        </button>
      </footer>
    </form>
  </AppModal>
</template>

<style scoped>
.entry-edit { gap: var(--space-3); }
.entry-edit__hint { margin: 0; font-size: var(--font-sm); line-height: 1.45; }
.entry-edit__group { margin: 0; padding: 0; border: 0; min-width: 0; display: grid; gap: var(--space-3); }
.entry-edit__contacts { grid-template-columns: repeat(2, minmax(0, 1fr)); padding-top: var(--space-3); border-top: 1px solid var(--border); }
.entry-edit__contact-hint { grid-column: 1 / -1; margin: 0; }
.entry-edit__replace { margin-top: 6px; align-items: flex-start; font-size: 0.875rem; }
.entry-edit__replace .muted { display: block; font-size: 0.8125rem; }
.entry-edit__actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: var(--space-2); }
@media (max-width: 480px) {
  .entry-edit__contacts { grid-template-columns: 1fr; }
}
</style>
