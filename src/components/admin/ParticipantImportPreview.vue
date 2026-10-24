<script setup>
// Editable preview of an imported participant list: names, partner, contact and seed per entry,
// duplicates marked, pairs joined or split. Rows: { key, members, contact, seed, note, error }.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import AppIcon from '../AppIcon.vue'
import { MEMBER_NAME_MAX } from '../../lib/registrationRules'
import { nameKey } from '../../lib/aiSchemas'

const props = defineProps({
  modelValue: { type: Array, required: true },
  // 'single' | 'pair' | 'pairOptional' (see entryShape in lib/aiSchemas.js)
  shape: { type: String, default: 'single' },
  team: Boolean,
  // The list ranked its participants (rating, place): show and keep the seed column.
  showSeed: Boolean,
  // The tournament's entries, to mark people who are already entered.
  entries: { type: Array, default: () => [] },
  disabled: Boolean,
})
const emit = defineEmits(['update:modelValue'])
const { t } = useI18n()

const rows = computed(() => props.modelValue)
const pairs = computed(() => props.shape !== 'single')

const existing = computed(() => {
  const keys = new Set()
  for (const entry of props.entries) {
    if (!['pending', 'approved', 'waitlisted'].includes(entry.status)) continue
    for (const member of entry.entry_members || []) keys.add(nameKey(member.member_name))
  }
  return keys
})

const listCounts = computed(() => {
  const counts = new Map()
  for (const row of rows.value) for (const name of row.members) {
    const key = nameKey(name)
    if (key) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
})

function marks(row) {
  const keys = row.members.map(nameKey).filter(Boolean)
  return {
    existing: keys.some(key => existing.value.has(key)),
    repeated: keys.some(key => (listCounts.value.get(key) ?? 0) > 1),
    incomplete: props.shape === 'pair' && !props.team && filled(row).length < 2,
  }
}

function update(next) {
  emit('update:modelValue', next)
}

function setField(index, field, value) {
  update(rows.value.map((row, i) => (i === index ? { ...row, [field]: value, error: '' } : row)))
}

function setMember(index, position, value) {
  const members = [...rows.value[index].members]
  members[position] = value
  setField(index, 'members', members)
}

function remove(index) {
  update(rows.value.filter((_, i) => i !== index))
}

// Two single players next to each other become one pair.
const filled = row => (row?.members ?? []).filter(name => String(name ?? '').trim())
const canJoin = index => pairs.value && !props.team && filled(rows.value[index]).length === 1 && filled(rows.value[index + 1]).length === 1
const canSplit = row => pairs.value && !props.team && filled(row).length === 2

function joinWithNext(index) {
  const [row, next] = [rows.value[index], rows.value[index + 1]]
  const joined = { ...row, members: [filled(row)[0], filled(next)[0]], contact: row.contact || next.contact, error: '' }
  update([...rows.value.slice(0, index), joined, ...rows.value.slice(index + 2)])
}

function split(index) {
  const row = rows.value[index]
  const second = { key: `${row.key}-2`, members: [row.members[1]], contact: null, seed: null, note: null, error: '' }
  update([...rows.value.slice(0, index), { ...row, members: [row.members[0]], error: '' }, second, ...rows.value.slice(index + 1)])
}
</script>

<template>
  <ol class="import-list">
    <li v-for="(row, index) in rows" :key="row.key" class="import-row" :class="{ 'import-row--error': row.error }">
      <span class="import-row__number" aria-hidden="true">{{ index + 1 }}</span>
      <div class="import-row__body">
        <div class="import-row__fields" :class="{ 'import-row__fields--seed': showSeed }">
          <div class="form-field import-row__name">
            <label :for="`imp-${row.key}-m1`" class="import-row__label">
              {{ team ? t('ai.import.team') : pairs ? t('ai.import.memberOne') : t('ai.import.member') }}
            </label>
            <input
              :id="`imp-${row.key}-m1`"
              class="input"
              type="text"
              :maxlength="MEMBER_NAME_MAX"
              :value="row.members[0]"
              :disabled="disabled"
              @input="setMember(index, 0, $event.target.value)"
            />
          </div>
          <div v-if="pairs && !team" class="form-field import-row__name">
            <label :for="`imp-${row.key}-m2`" class="import-row__label">{{ t('ai.import.memberTwo') }}</label>
            <input
              :id="`imp-${row.key}-m2`"
              class="input"
              type="text"
              :maxlength="MEMBER_NAME_MAX"
              :value="row.members[1] ?? ''"
              :disabled="disabled"
              @input="setMember(index, 1, $event.target.value)"
            />
          </div>
          <div class="form-field import-row__contact">
            <label :for="`imp-${row.key}-contact`" class="import-row__label">{{ t('ai.import.contact') }}</label>
            <input
              :id="`imp-${row.key}-contact`"
              class="input"
              type="text"
              inputmode="email"
              autocomplete="off"
              :value="row.contact ?? ''"
              :disabled="disabled"
              @input="setField(index, 'contact', $event.target.value || null)"
            />
          </div>
          <div v-if="showSeed" class="form-field import-row__seed">
            <label :for="`imp-${row.key}-seed`" class="import-row__label">{{ t('ai.import.seed') }}</label>
            <input
              :id="`imp-${row.key}-seed`"
              class="input"
              type="number"
              min="1"
              max="999"
              inputmode="numeric"
              :value="row.seed ?? ''"
              :disabled="disabled"
              @input="setField(index, 'seed', Number.parseInt($event.target.value, 10) || null)"
            />
          </div>
        </div>
        <div v-if="row.note || row.error || marks(row).existing || marks(row).repeated || marks(row).incomplete || canJoin(index) || canSplit(row)" class="import-row__meta">
          <span v-if="marks(row).incomplete" class="badge badge--warn">{{ t('ai.import.incomplete') }}</span>
          <span v-if="marks(row).existing" class="badge badge--warn">{{ t('ai.import.duplicateExisting') }}</span>
          <span v-else-if="marks(row).repeated" class="badge badge--warn">{{ t('ai.import.duplicateList') }}</span>
          <span v-if="row.note" class="import-row__note">{{ t('ai.import.note', { note: row.note }) }}</span>
          <button v-if="canJoin(index)" type="button" class="btn btn--ghost btn--sm" :disabled="disabled" @click="joinWithNext(index)">
            {{ t('ai.import.pairWithNext') }}
          </button>
          <button v-if="canSplit(row)" type="button" class="btn btn--ghost btn--sm" :disabled="disabled" @click="split(index)">
            {{ t('ai.import.split') }}
          </button>
          <span v-if="row.error" class="import-row__error" role="alert">{{ row.error }}</span>
        </div>
      </div>
      <button
        type="button"
        class="btn btn--ghost btn--icon import-row__remove"
        :aria-label="t('ai.import.remove', { n: index + 1 })"
        :disabled="disabled"
        @click="remove(index)"
      >
        <AppIcon name="close" :size="18" />
      </button>
    </li>
  </ol>
</template>

<style scoped>
.import-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 10px);
  background: var(--surface);
  max-height: min(60vh, 640px);
  overflow-y: auto;
}
.import-row {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr) auto;
  gap: var(--space-2, 8px);
  align-items: start;
  padding: 10px 12px;
  border-top: 1px solid var(--border);
}
.import-row:first-child {
  border-top: none;
}
.import-row--error {
  background: var(--danger-bg);
}
.import-row__number {
  padding-top: 30px;
  font-variant-numeric: tabular-nums;
  font-size: 0.8125rem;
  color: var(--muted);
  text-align: right;
}
.import-row__body {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.import-row__fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: var(--space-2, 8px);
}
/* Names and contact share the width; the seed keeps a narrow last column. */
.import-row__fields--seed {
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)) 5.5rem;
}
.import-row__fields .form-field {
  margin: 0;
}

.import-row__label {
  font-size: 0.75rem;
  color: var(--muted);
}
.import-row__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 10px;
}
.import-row__note {
  font-size: 0.8125rem;
  color: var(--muted);
}
.import-row__error {
  font-size: 0.8125rem;
  color: var(--danger);
}
.import-row__remove {
  margin-top: 22px;
}
@media (max-width: 560px) {
  .import-row {
    grid-template-columns: minmax(0, 1fr) auto;
  }
  .import-row__number {
    display: none;
  }
  /* Phone: full-width names, contact and seed on one line; no scroll inside the page scroll. */
  .import-list {
    max-height: none;
    overflow: visible;
  }
  .import-row__fields {
    grid-template-columns: minmax(0, 1fr);
  }
  .import-row__fields--seed {
    grid-template-columns: minmax(0, 1fr) 4.5rem;
  }
  .import-row__name {
    grid-column: 1 / -1;
  }
}
</style>
