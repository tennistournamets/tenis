<script setup>
import { computed, nextTick, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { confirmDiscard, useUnsavedChanges } from '../../lib/unsavedChanges'
import { mergeOrder, moveIndex, moveToPosition, parsePosition } from '../../lib/seedOrder'

// The approved field as one draggable list: drag a row by its handle (mouse or
// finger), type a place into "№", or use the arrow keys on the handle. The
// first `seedCount` rows are the seeds of a knockout draw; a line marks where
// the lot starts. Nothing is saved until "Save".
const props = defineProps({
  // [{ id, label }] in the current seed order.
  items: { type: Array, required: true },
  // Ids in registration order, for "Reset".
  registration: { type: Array, default: () => [] },
  seedCount: { type: Number, default: 0 },
  // Rating kinds offered for "Order by rating" ([{ value, label }]) and the
  // function that orders ids by one of them.
  ratingKinds: { type: Array, default: () => [] },
  rankByRating: { type: Function, default: null },
  saving: Boolean,
})
const emit = defineEmits(['save', 'cancel'])
const { t } = useI18n()

const initial = ref(props.items.map(i => i.id))
const order = ref(initial.value.slice())
const byId = computed(() => Object.fromEntries(props.items.map(i => [i.id, i])))
const rows = computed(() => order.value.map(id => byId.value[id]).filter(Boolean))
const dirty = computed(() => order.value.join() !== initial.value.join())
const ratingKind = ref(props.ratingKinds[0]?.value || '')
const announcement = ref('')
const listEl = ref(null)

// Entries approved or withdrawn while editing: keep the draft, add or drop them.
watch(() => props.items.map(i => i.id).join(), () => {
  const ids = props.items.map(i => i.id)
  order.value = mergeOrder(order.value, ids)
  initial.value = mergeOrder(initial.value, ids)
})

useUnsavedChanges(() => dirty.value, () => props.saving)

function announce(id) {
  announcement.value = t('seedEditor.moved', { name: byId.value[id]?.label || '', place: order.value.indexOf(id) + 1 })
}

function place(id, position) {
  order.value = moveToPosition(order.value, id, position)
  announce(id)
}

function onNumber(event, id) {
  const position = parsePosition(event.target.value)
  if (position == null) { event.target.value = String(order.value.indexOf(id) + 1); return }
  place(id, position)
  event.target.value = String(order.value.indexOf(id) + 1)
}

async function onKey(event, id) {
  const index = order.value.indexOf(id)
  const target = { ArrowUp: index - 1, ArrowDown: index + 1, Home: 0, End: order.value.length - 1 }[event.key]
  if (target == null) return
  event.preventDefault()
  order.value = moveIndex(order.value, index, target)
  announce(id)
  await nextTick()
  listEl.value?.querySelector(`[data-handle="${id}"]`)?.focus()
}

// Pointer drag: the row follows the pointer; the list reorders as it crosses
// the middle of a neighbour. Works the same for a mouse and a finger.
const dragging = ref(null)
function startDrag(event, id) {
  if (props.saving || (event.pointerType === 'mouse' && event.button !== 0)) return
  event.preventDefault()
  // Capture keeps the moves coming when the pointer leaves the handle; a
  // pointer that is already gone cannot be captured, and dragging still works.
  try { event.currentTarget.setPointerCapture?.(event.pointerId) } catch { /* not capturable */ }
  dragging.value = id
}
function moveDrag(event) {
  if (!dragging.value || !listEl.value) return
  const rowsEls = [...listEl.value.querySelectorAll('[data-row]')]
  const from = order.value.indexOf(dragging.value)
  let to = 0
  for (const el of rowsEls) {
    if (el.dataset.row === dragging.value) continue
    const box = el.getBoundingClientRect()
    if (event.clientY > box.top + box.height / 2) to++
  }
  if (to !== from) order.value = moveIndex(order.value, from, to)
}
function endDrag() {
  if (!dragging.value) return
  announce(dragging.value)
  dragging.value = null
}

function reset() {
  order.value = mergeOrder(props.registration.filter(id => byId.value[id]), props.items.map(i => i.id))
  announcement.value = t('seedEditor.resetDone')
}

function orderByRating() {
  if (!props.rankByRating || !ratingKind.value) return
  order.value = props.rankByRating(order.value, ratingKind.value)
  announcement.value = t('seedEditor.ratingDone')
}

async function cancel() {
  if (!(await confirmDiscard(t, dirty.value, props.saving))) return
  emit('cancel')
}
</script>

<template>
  <section class="seed-editor" :aria-label="t('seedEditor.title')">
    <p class="field-hint seed-editor__hint">{{ t('seedEditor.hint') }}</p>

    <div class="seed-editor__tools">
      <button class="btn btn--ghost btn--sm" type="button" :disabled="saving" @click="reset">{{ t('seedEditor.reset') }}</button>
      <template v-if="ratingKinds.length && rankByRating">
        <select v-model="ratingKind" class="input seed-editor__kind" :aria-label="t('playerRating.seedKind')" :disabled="saving">
          <option v-for="kind in ratingKinds" :key="kind.value" :value="kind.value">{{ kind.label }}</option>
        </select>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="saving" @click="orderByRating">{{ t('seedEditor.byRating') }}</button>
      </template>
    </div>

    <ol ref="listEl" class="seed-editor__list" @pointermove="moveDrag" @pointerup="endDrag" @pointercancel="endDrag">
      <template v-for="(row, index) in rows" :key="row.id">
        <li
          class="seed-editor__row"
          :class="{ 'seed-editor__row--dragging': dragging === row.id, 'seed-editor__row--seed': index < seedCount }"
          :data-row="row.id"
        >
          <button
            class="seed-editor__handle"
            type="button"
            :data-handle="row.id"
            :aria-label="t('seedEditor.handle', { name: row.label })"
            :aria-describedby="`seed-editor-keys`"
            :disabled="saving"
            @pointerdown="startDrag($event, row.id)"
            @keydown="onKey($event, row.id)"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>
          </button>
          <input
            class="input seed-editor__number"
            type="text"
            inputmode="numeric"
            :value="index + 1"
            :aria-label="t('seedEditor.number', { name: row.label })"
            :disabled="saving"
            @change="onNumber($event, row.id)"
            @keydown.enter.prevent="$event.target.blur()"
          />
          <span class="seed-editor__name">
            {{ row.label }}
            <slot name="detail" :item="row" />
          </span>
          <span v-if="index < seedCount" class="seed-editor__badge">{{ t('seedEditor.seed', { n: index + 1 }) }}</span>
        </li>
        <li v-if="seedCount && index === seedCount - 1 && rows.length > seedCount" class="seed-editor__cut" aria-hidden="true">
          <span>{{ t('seedEditor.lotBelow') }}</span>
        </li>
      </template>
    </ol>
    <p id="seed-editor-keys" class="sr-only">{{ t('seedEditor.keys') }}</p>
    <p class="sr-only" role="status" aria-live="polite">{{ announcement }}</p>

    <footer class="seed-editor__actions">
      <button class="btn btn--primary btn--sm" type="button" :disabled="saving || !dirty" @click="emit('save', order.slice())">
        <span v-if="saving" class="spinner" aria-hidden="true" />
        {{ t('seedEditor.save') }}
      </button>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="saving" @click="cancel">{{ t('actions.cancel') }}</button>
    </footer>
  </section>
</template>

<style scoped>
.seed-editor { display: grid; gap: var(--space-3); }
.seed-editor__hint { margin: 0; }
.seed-editor__tools { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.seed-editor__kind { width: auto; max-width: 240px; }
.seed-editor__list { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface); overflow: hidden; }
.seed-editor__row {
  display: grid;
  grid-template-columns: var(--touch-min) 56px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3) var(--space-2) var(--space-1);
  background: var(--surface);
}
.seed-editor__row + .seed-editor__row { border-top: 1px solid var(--border); }
.seed-editor__row--dragging { background: var(--surface-hover); box-shadow: inset 3px 0 0 var(--primary); }
.seed-editor__handle {
  width: var(--touch-min);
  height: var(--touch-min);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted);
  cursor: grab;
  touch-action: none;
}
.seed-editor__handle:hover, .seed-editor__handle:focus-visible { color: var(--text); background: var(--surface-hover); }
.seed-editor__row--dragging .seed-editor__handle { cursor: grabbing; }
.seed-editor__number { min-height: 36px; padding: 4px 8px; text-align: center; font-variant-numeric: tabular-nums; }
.seed-editor__name { min-width: 0; font-weight: 600; font-size: 0.9375rem; overflow-wrap: anywhere; }
.seed-editor__badge { font-size: 0.75rem; font-weight: 700; padding: 3px 8px; border-radius: 999px; background: var(--primary-muted); color: var(--primary); white-space: nowrap; }
.seed-editor__cut { display: flex; align-items: center; gap: var(--space-2); padding: 6px var(--space-3); border-top: 1px dashed var(--border-strong, var(--border)); font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); background: var(--surface-2); }
.seed-editor__cut + .seed-editor__row { border-top: 0; }
.seed-editor__actions { display: flex; flex-wrap: wrap; gap: var(--space-2); }
@media (max-width: 520px) {
  .seed-editor__row { grid-template-columns: var(--touch-min) 48px minmax(0, 1fr); }
  .seed-editor__badge { grid-column: 3; justify-self: start; }
}
</style>
