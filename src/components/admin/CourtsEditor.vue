<script setup>
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { cloneForm, sameForm } from '../../lib/formDraft'

const props = defineProps({
  courts: { type: Array, default: () => [] },
  disabled: Boolean,
})
const emit = defineEmits(['save'])
const { t } = useI18n()

const toDraft = courts => courts.map(c => ({ id: c.id, name: c.name }))
const draft = ref(toDraft(props.courts))
const baseline = ref(cloneForm(draft.value))
// Server rows replace the draft only while nothing is being edited.
watch(() => props.courts, courts => {
  const next = toDraft(courts)
  if (sameForm(draft.value, baseline.value)) draft.value = cloneForm(next)
  baseline.value = cloneForm(next)
}, { deep: true })

const dirty = computed(() => !sameForm(draft.value, baseline.value))
const invalid = computed(() => {
  const names = draft.value.map(c => c.name.trim())
  return names.some(n => !n || n.length > 60) || new Set(names).size !== names.length
})

function add() { draft.value.push({ id: null, name: '' }) }
function remove(index) { draft.value.splice(index, 1) }
function reset() { draft.value = cloneForm(baseline.value) }
function save() {
  if (invalid.value || !dirty.value) return
  emit('save', draft.value.map(c => ({ id: c.id, name: c.name.trim() })))
}
</script>

<template>
  <section class="courts-editor stack stack--sm" :aria-label="t('schedule.courts')">
    <div class="courts-editor__head">
      <h3 class="section-title" style="margin: 0">{{ t('schedule.courts') }}</h3>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="disabled" @click="add">{{ t('schedule.addCourt') }}</button>
    </div>
    <p v-if="!draft.length" class="muted">{{ t('schedule.noCourts') }}</p>
    <ol v-else class="courts-editor__list">
      <li v-for="(court, index) in draft" :key="court.id || `new-${index}`" class="courts-editor__row">
        <span class="courts-editor__index">{{ index + 1 }}</span>
        <input
          v-model="court.name"
          class="input"
          type="text"
          maxlength="60"
          :aria-label="t('schedule.courtName')"
          :placeholder="t('schedule.courtName')"
          :disabled="disabled"
        />
        <button class="btn btn--ghost btn--sm" type="button" :disabled="disabled" :aria-label="t('schedule.removeCourt')" @click="remove(index)">✕</button>
      </li>
    </ol>
    <p class="muted courts-editor__hint">{{ t('schedule.courtsHint') }}</p>
    <div v-if="dirty" class="inline-actions">
      <button class="btn btn--primary btn--sm" type="button" :disabled="disabled || invalid" @click="save">{{ t('schedule.saveCourts') }}</button>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="disabled" @click="reset">{{ t('drafts.discardLeave') }}</button>
      <p v-if="invalid" class="error-text" role="alert" style="margin: 0">{{ t('schedule.errors.invalidCourts') }}</p>
    </div>
  </section>
</template>

<style scoped>
.courts-editor__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.courts-editor__list { margin: 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.courts-editor__row { display: grid; grid-template-columns: 28px minmax(0, 1fr) auto; align-items: center; gap: 8px; }
.courts-editor__index { color: var(--text-muted); font-weight: 700; text-align: center; }
.courts-editor__hint { margin: 0; font-size: 0.82rem; }
</style>
