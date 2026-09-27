<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { errorMessage } from '../../lib/errorMessages'
import { decideSponsorshipRequest, listSponsorshipRequests } from '../../lib/sponsorshipRequests'

// Platform admin: owners asking for the paid sponsorship feature. Until payments
// exist, approving here is what opens the Sponsors tab of a tournament.
const { t, locale } = useI18n()
const emit = defineEmits(['pending-count'])

const loading = ref(true)
const unavailable = ref(false)
const error = ref('')
const rows = ref([])
const filter = ref('pending')
const pending = ref(new Set())
const FILTERS = ['pending', 'approved', 'rejected', 'all']

const counts = computed(() => Object.fromEntries(FILTERS.map((key) => [key, key === 'all' ? rows.value.length : rows.value.filter((r) => r.status === key).length])))
watch(() => counts.value.pending, (n) => emit('pending-count', n), { immediate: true })
const visible = computed(() => (filter.value === 'all' ? rows.value : rows.value.filter((r) => r.status === filter.value)))

function formatDate(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return ''
  }
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const result = await listSponsorshipRequests()
    unavailable.value = Boolean(result.unavailable)
    rows.value = result.rows || []
    // Nothing to decide: open on the full list instead of an empty "waiting" view.
    if (filter.value === 'pending' && !rows.value.some((r) => r.status === 'pending')) filter.value = 'all'
  } catch (err) {
    error.value = errorMessage(err, t, 'sync.loadFailed')
  } finally {
    loading.value = false
  }
}

async function decide(row, status) {
  if (pending.value.has(row.id)) return
  error.value = ''
  pending.value = new Set([...pending.value, row.id])
  try {
    const updated = await decideSponsorshipRequest(row.id, status)
    rows.value = rows.value.map((r) => (r.id === row.id ? { ...r, status: updated.status, decided_at: updated.decided_at, updated_at: updated.updated_at } : r))
  } catch (err) {
    error.value = errorMessage(err, t, 'errors.generic')
  } finally {
    const next = new Set(pending.value)
    next.delete(row.id)
    pending.value = next
  }
}

const badgeClass = (status) => ({ pending: 'badge--warn', approved: 'badge--success', rejected: 'badge--danger' }[status] || 'badge--neutral')

onMounted(load)
</script>

<template>
  <section class="card stack stack--sm sponsorship-requests" aria-labelledby="sponsorship-requests-title">
    <div class="sponsorship-requests__head">
      <h2 id="sponsorship-requests-title" class="section-title" style="margin: 0">{{ t('sponsor.requests.title') }}</h2>
      <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">{{ t('actions.refresh') }}</button>
    </div>
    <p class="muted" style="margin: 0">{{ t('sponsor.requests.hint') }}</p>

    <p v-if="unavailable" class="alert alert--info" role="status" style="margin: 0">{{ t('sponsor.access.unavailable') }}</p>
    <p v-if="error" class="alert alert--error" role="alert" style="margin: 0">{{ error }}</p>

    <template v-if="!unavailable">
      <div class="filter-segment" role="group" :aria-label="t('sponsor.requests.filter')">
        <button
          v-for="key in FILTERS"
          :key="key"
          type="button"
          class="filter-segment__btn"
          :class="{ 'filter-segment__btn--active': filter === key }"
          :aria-pressed="filter === key"
          @click="filter = key"
        >
          {{ t(`sponsor.requests.filters.${key}`) }} <span class="muted">{{ counts[key] }}</span>
        </button>
      </div>

      <p v-if="loading" class="muted" style="margin: 0">{{ t('actions.loading') }}</p>
      <p v-else-if="!visible.length" class="muted sponsorship-requests__empty">{{ t(rows.length ? 'sponsor.requests.emptyFilter' : 'sponsor.requests.empty') }}</p>

      <div v-else class="sponsorship-requests__scroll">
        <table class="sponsorship-requests__table">
          <thead>
            <tr>
              <th scope="col">{{ t('sponsor.requests.owner') }}</th>
              <th scope="col">{{ t('sponsor.requests.tournament') }}</th>
              <th scope="col">{{ t('sponsor.requests.requested') }}</th>
              <th scope="col">{{ t('sponsor.requests.status') }}</th>
              <th scope="col"><span class="sr-only">{{ t('sponsor.requests.actions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in visible" :key="row.id">
              <td>
                <strong class="sponsorship-requests__name">{{ row.owner_name || row.owner_email || '—' }}</strong>
                <span v-if="row.owner_name && row.owner_email" class="muted sponsorship-requests__sub">{{ row.owner_email }}</span>
              </td>
              <td>
                <a class="sponsorship-requests__name" :href="`/tournaments/${row.tournament_slug}`" target="_blank" rel="noopener">{{ row.tournament_name }} ↗</a>
                <span class="muted sponsorship-requests__sub">{{ t(`tournament.${row.tournament_status}`) }}</span>
              </td>
              <td>
                <span class="sponsorship-requests__date">{{ formatDate(row.created_at) }}</span>
                <span v-if="row.message" class="sponsorship-requests__message">{{ row.message }}</span>
              </td>
              <td>
                <span class="badge" :class="badgeClass(row.status)">{{ t(`sponsor.access.status.${row.status}`) }}</span>
                <span v-if="row.decided_at" class="muted sponsorship-requests__sub">{{ formatDate(row.decided_at) }}</span>
              </td>
              <td class="sponsorship-requests__actions">
                <button
                  v-if="row.status !== 'approved'"
                  class="btn btn--primary btn--sm"
                  type="button"
                  :disabled="pending.has(row.id)"
                  @click="decide(row, 'approved')"
                >{{ t('sponsor.requests.approve') }}</button>
                <button
                  v-if="row.status !== 'rejected'"
                  class="btn btn--ghost btn--sm"
                  type="button"
                  :disabled="pending.has(row.id)"
                  @click="decide(row, 'rejected')"
                >{{ row.status === 'approved' ? t('sponsor.requests.revoke') : t('sponsor.requests.reject') }}</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </section>
</template>

<style scoped>
.sponsorship-requests__head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.sponsorship-requests__empty { margin: 0; padding: 16px; text-align: center; border: 1.5px dashed var(--border-strong); border-radius: var(--radius-sm); }
.sponsorship-requests__scroll { overflow-x: auto; margin: 0 calc(var(--space-4) * -1); padding: 0 var(--space-4); }
.sponsorship-requests__table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 0.875rem; }
.sponsorship-requests__table th {
  padding: 0 10px 8px;
  text-align: left;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.sponsorship-requests__table td { padding: 12px 10px; vertical-align: top; border-bottom: 1px solid var(--border); }
.sponsorship-requests__table th:first-child,
.sponsorship-requests__table td:first-child { padding-left: 0; }
.sponsorship-requests__name { display: block; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
a.sponsorship-requests__name { color: var(--primary); text-decoration: none; }
a.sponsorship-requests__name:hover { text-decoration: underline; }
.sponsorship-requests__sub { display: block; margin-top: 2px; font-size: 0.8125rem; overflow-wrap: anywhere; }
.sponsorship-requests__date { display: block; white-space: nowrap; }
.sponsorship-requests__message { display: block; margin-top: 4px; max-width: 260px; font-size: 0.8125rem; color: var(--text-muted); overflow-wrap: anywhere; }
.sponsorship-requests__table .badge + .sponsorship-requests__sub { margin-top: 6px; }
.sponsorship-requests__actions { white-space: nowrap; text-align: right; }
.sponsorship-requests__actions .btn + .btn { margin-left: 6px; }
</style>
