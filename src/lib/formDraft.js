import { computed, reactive, ref, watch } from 'vue'

export const cloneForm = value => JSON.parse(JSON.stringify(value))
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
  return value
}
export const sameForm = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
export const matchVersions = rows => rows.map(m => ({ id: m.id, revision: m.score_revision })).sort((a,b) => a.id.localeCompare(b.id))

// The last server snapshot, the edit baseline and the draft are separate values.
// Receiving a snapshot must never silently rebase an edited form.
export function useFormDraft(initial) {
  const form = reactive(cloneForm(initial))
  const baseline = ref(cloneForm(initial))
  const latest = ref(null)
  const revision = ref(null)
  const latestRevision = ref(null)
  const saving = ref(false)
  const dirty = computed(() => !sameForm(form, baseline.value))
  const conflict = computed(() => dirty.value && revision.value !== latestRevision.value)
  function reset(value, version) {
    Object.assign(form, cloneForm(value))
    baseline.value = cloneForm(value)
    revision.value = version
  }
  function receive(value, version) {
    if (latestRevision.value != null && version < latestRevision.value) return false
    latest.value = cloneForm(value)
    latestRevision.value = version
    if (revision.value == null || (!dirty.value && !saving.value)) reset(value, version)
    return true
  }
  function discard() {
    if (latest.value) reset(latest.value, latestRevision.value)
  }
  function accepted(value, version, submitted) {
    // An already delivered newer snapshot must remain visible as a conflict.
    if (sameForm(form, submitted)) reset(value, version)
    else { baseline.value = cloneForm(value); revision.value = version }
    const applied = receive(value, version)
    if (!applied && sameForm(form, baseline.value)) reset(latest.value, latestRevision.value)
  }
  // Undoing every local edit also makes the form eligible for the latest snapshot.
  watch([dirty, saving, latestRevision], () => {
    if (!dirty.value && !saving.value && latest.value && latestRevision.value > revision.value) discard()
  }, { flush: 'post' })
  return { form, baseline, latest, revision, latestRevision, saving, dirty, conflict, receive, discard, accepted }
}
