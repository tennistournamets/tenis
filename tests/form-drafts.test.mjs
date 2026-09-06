import assert from 'node:assert/strict'
import { test } from 'node:test'
import { nextTick } from 'vue'
import { useFormDraft, cloneForm, sameForm } from '../src/lib/formDraft.js'
import { registerUnsavedForm, hasUnsavedChanges, beforeUnload, confirmLeaveForms, withApprovedDeparture } from '../src/lib/unsavedChanges.js'
import { confirmState, settleConfirm } from '../src/lib/confirmDialog.js'
const initial = { name: 'Cup', public: false, rules: { deciding: 'set', target: 7 } }

test('settings refresh preserves nested input and baseline; conflicts require explicit discard', () => {
  const d = useFormDraft(initial); d.receive(initial, 1)
  d.form.rules.target = 10
  d.receive({ ...initial, name: 'Other editor' }, 2)
  assert.equal(d.form.name, 'Cup'); assert.equal(d.form.rules.target, 10)
  assert.equal(d.baseline.value.rules.target, 7); assert.equal(d.conflict.value, true)
  d.discard()
  assert.equal(d.form.name, 'Other editor'); assert.equal(d.form.rules.target, 7)
  assert.equal(d.dirty.value, false); assert.equal(d.conflict.value, false)
})
test('pristine drafts update and older snapshots cannot roll back accepted settings', () => {
  const d = useFormDraft(initial); d.receive(initial, 1)
  d.receive({ ...initial, name: 'Latest' }, 3)
  assert.equal(d.receive(initial, 2), false); assert.equal(d.form.name, 'Latest')
  assert.ok(sameForm(d.form, { rules: { target: 7, deciding: 'set' }, public: false, name: 'Latest' }))
})
test('a realtime snapshot delivered before the save response does not resurrect an old version', () => {
  const d = useFormDraft(initial); d.receive(initial, 1)
  d.form.name = 'Mine'; const sent = cloneForm(d.form); d.saving.value = true
  d.receive(sent, 2); d.receive({ ...sent, name: 'Newer' }, 3)
  d.accepted(sent, 2, sent); d.saving.value = false
  assert.equal(d.form.name, 'Newer'); assert.equal(d.revision.value, 3); assert.equal(d.dirty.value, false)
})
test('input made during an in-flight save is retained and conflicts with a newer revision', () => {
  const d = useFormDraft(initial); d.receive(initial, 1)
  d.form.name = 'Mine'; const sent = cloneForm(d.form); d.saving.value = true
  d.form.name = 'Typed later'; d.receive({ ...sent, public: true }, 3)
  d.accepted(sent, 2, sent); d.saving.value = false
  assert.equal(d.form.name, 'Typed later'); assert.equal(d.baseline.value.name, 'Mine')
  assert.equal(d.conflict.value, true)
})
test('undoing all local edits follows the latest snapshot instead of leaving stale pristine fields', async () => {
  const d = useFormDraft(initial); d.receive(initial, 1)
  d.form.name = 'Draft'; d.receive({ ...initial, name: 'Changed remotely' }, 2)
  d.form.name = initial.name; await nextTick()
  assert.equal(d.form.name, 'Changed remotely'); assert.equal(d.revision.value, 2)
})
test('route cancellation, confirmation and native reload protect all registered forms', async () => {
  let dirty = true, busy = false
  const unregister = registerUnsavedForm(() => dirty, () => busy)
  try {
    assert.equal(hasUnsavedChanges(), true)
    const event = { preventDefault() { this.prevented = true } }; beforeUnload(event)
    assert.equal(event.prevented, true); assert.equal(event.returnValue, '')
    const cancelled = confirmLeaveForms(x => x); assert.equal(confirmState.open, true)
    settleConfirm(false); assert.equal(await cancelled, false); assert.equal(dirty, true)
    const accepted = confirmLeaveForms(x => x); settleConfirm(true); assert.equal(await accepted, true)
    busy = true; dirty = false
    assert.equal(await confirmLeaveForms(x => x), false)
    assert.equal(await withApprovedDeparture(() => confirmLeaveForms(x => x)), true)
    assert.equal(await confirmLeaveForms(x => x), false)
  } finally { unregister(); settleConfirm(false) }
  assert.equal(hasUnsavedChanges(), false)
  const event = { preventDefault() { this.prevented = true } }; beforeUnload(event)
  assert.equal(event.prevented, undefined)
})
