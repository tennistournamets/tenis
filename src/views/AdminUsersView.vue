<script setup>
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { supabase } from '../lib/supabase'
import { errorMessage } from '../lib/errorMessages'
import { countText } from '../lib/plural'
import { statusBadgeClass } from '../lib/tournamentStatus'
import { USER_FILTERS, USER_SORTS, filterCounts, filterUsers, latestTournament, sortUsers } from '../lib/platformUsers'

// Super-admin: every account, the tournaments it runs and platform totals
// (platform_users_overview). Reached from the profile menu.
const { t, locale } = useI18n()

const loading = ref(true)
const error = ref('')
const totals = ref(null)
const users = ref([])
const query = ref('')
const filter = ref('all')
const sortKey = ref('created')
const expanded = ref(new Set())
const failedAvatars = ref(new Set())
const searchId = useId()
const sortId = useId()

const counts = computed(() => filterCounts(users.value))
const visible = computed(() => sortUsers(filterUsers(users.value, { query: query.value, filter: filter.value }), sortKey.value))

const number = (value) => {
  try {
    return new Intl.NumberFormat(locale.value).format(value ?? 0)
  } catch {
    return String(value ?? 0)
  }
}

const stats = computed(() => {
  const s = totals.value
  if (!s) return []
  const percent = s.users ? Math.round((s.organizers / s.users) * 100) : 0
  return [
    { key: 'users', value: s.users, note: t('platformUsers.stats.new7d', { n: number(s.users_7d) }), sub: t('platformUsers.stats.new30d', { n: number(s.users_30d) }) },
    { key: 'active', value: s.active_7d },
    { key: 'organizers', value: s.organizers, note: t('platformUsers.stats.ofUsers', { percent }) },
    { key: 'tournaments', value: s.tournaments, note: t('platformUsers.stats.new7d', { n: number(s.tournaments_7d) }), sub: t('platformUsers.stats.new30d', { n: number(s.tournaments_30d) }) },
    { key: 'inProgress', value: s.in_progress, note: t('platformUsers.stats.completed', { n: number(s.completed) }) },
    { key: 'participants', value: s.participants, note: t('platformUsers.stats.matchesPlayed', { n: number(s.matches_played) }) },
  ]
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const { data, error: rpcError } = await supabase.rpc('platform_users_overview')
    if (rpcError) throw rpcError
    totals.value = data?.totals ?? null
    users.value = data?.users ?? []
  } catch (err) {
    error.value = errorMessage(err, t, 'sync.loadFailed')
  } finally {
    loading.value = false
  }
}

function toggle(user) {
  const next = new Set(expanded.value)
  if (next.has(user.id)) next.delete(user.id)
  else next.add(user.id)
  expanded.value = next
}

// A narrow column wraps an address before "@", not in the middle of a word.
const emailParts = (email) => {
  const at = email.lastIndexOf('@')
  return at > 0 ? [email.slice(0, at), email.slice(at)] : [email, '']
}
const displayName = (user) => user.name || user.email || t('platformUsers.noName')
const initial = (user) => ((user.name || user.email || '').trim()[0] || '?').toLocaleUpperCase()
const showAvatar = (user) => Boolean(user.avatar_url) && !failedAvatars.value.has(user.id)
function avatarFailed(user) {
  failedAvatars.value = new Set([...failedAvatars.value, user.id])
}

function formatDate(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(value))
  } catch {
    return ''
  }
}

// "3 days ago" reads faster than a date for activity; the exact time is in the tooltip.
const RELATIVE_STEPS = [['year', 31536000], ['month', 2592000], ['week', 604800], ['day', 86400], ['hour', 3600], ['minute', 60]]
function formatRelative(value) {
  if (!value) return t('platformUsers.never')
  // A moment "in the future" is clock skew between this device and the server: read it as now.
  const seconds = Math.min((new Date(value).getTime() - Date.now()) / 1000, 0)
  if (!Number.isFinite(seconds)) return ''
  try {
    const rtf = new Intl.RelativeTimeFormat(locale.value, { numeric: 'auto' })
    for (const [unit, size] of RELATIVE_STEPS) {
      if (Math.abs(seconds) >= size) return rtf.format(Math.round(seconds / size), unit)
    }
    return rtf.format(0, 'minute')
  } catch {
    return formatDate(value)
  }
}

function formatDateTime(value) {
  if (!value) return ''
  try {
    return new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value))
  } catch {
    return ''
  }
}

// Exact time of the last activity, and when the account last signed in with Google.
const activityTitle = (user) => [
  formatDateTime(user.last_seen_at),
  user.last_sign_in_at ? t('platformUsers.signedIn', { date: formatDateTime(user.last_sign_in_at) }) : '',
].filter(Boolean).join('\n')

const tournamentMeta = (item) => [t(`sport.${item.sport}`), t(`tournamentFormat.${item.format}`)].join(' · ')

onMounted(load)
</script>

<template>
  <div class="stack" style="max-width: 1120px">
    <div>
      <RouterLink class="admin-back-link" :to="{ name: 'admin-tournaments' }">
        {{ t('admin.backToList') }}
      </RouterLink>
      <div class="users-head">
        <h1 class="page-title">{{ t('platformUsers.title') }}</h1>
        <button class="btn btn--ghost btn--sm" type="button" :disabled="loading" @click="load">{{ t('platformUsers.refresh') }}</button>
      </div>
      <p class="muted">{{ t('platformUsers.intro') }}</p>
    </div>

    <p v-if="error" class="alert alert--error" role="alert">{{ error }}</p>

    <ul v-if="stats.length" class="users-stats" :aria-busy="loading">
      <li v-for="stat in stats" :key="stat.key" class="card users-stat">
        <span class="users-stat__label">{{ t(`platformUsers.stats.${stat.key}`) }}</span>
        <span class="users-stat__value">{{ number(stat.value) }}</span>
        <span v-if="stat.note" class="users-stat__note">{{ stat.note }}</span>
        <span v-if="stat.sub" class="users-stat__note">{{ stat.sub }}</span>
      </li>
    </ul>

    <section class="card stack stack--sm" :aria-busy="loading" :aria-label="t('platformUsers.title')">
      <div class="users-toolbar">
        <label class="sr-only" :for="searchId">{{ t('platformUsers.search') }}</label>
        <input :id="searchId" v-model="query" class="input users-toolbar__search" type="search" :placeholder="t('platformUsers.search')" autocomplete="off" />
        <div class="filter-segment" role="group" :aria-label="t('platformUsers.filters.label')">
          <button
            v-for="key in USER_FILTERS"
            :key="key"
            type="button"
            class="filter-segment__btn"
            :class="{ 'filter-segment__btn--active': filter === key }"
            :aria-pressed="filter === key"
            @click="filter = key"
          >
            {{ t(`platformUsers.filters.${key}`) }} <span class="muted users-filter__count">{{ counts[key] }}</span>
          </button>
        </div>
        <label class="sr-only" :for="sortId">{{ t('platformUsers.sort.label') }}</label>
        <select :id="sortId" v-model="sortKey" class="input users-toolbar__sort">
          <option v-for="key in USER_SORTS" :key="key" :value="key">{{ t(`platformUsers.sort.${key}`) }}</option>
        </select>
      </div>

      <p v-if="loading && !users.length" class="muted" style="margin: 0">{{ t('actions.loading') }}</p>
      <p v-else-if="!visible.length && !error" class="muted users-empty">{{ t(users.length ? 'platformUsers.emptyFilter' : 'platformUsers.empty') }}</p>

      <div v-else-if="visible.length" class="users-scroll">
        <table class="users-table">
          <thead>
            <tr>
              <th scope="col">{{ t('platformUsers.columns.user') }}</th>
              <th scope="col">{{ t('platformUsers.columns.registered') }}</th>
              <th scope="col">{{ t('platformUsers.columns.lastSeen') }}</th>
              <th scope="col">{{ t('platformUsers.columns.tournaments') }}</th>
              <th scope="col">{{ t('platformUsers.columns.latest') }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="user in visible" :key="user.id">
              <tr :class="{ 'users-table__row--open': expanded.has(user.id) }">
                <td class="users-table__person">
                  <div class="users-person">
                    <img v-if="showAvatar(user)" class="users-person__avatar" :src="user.avatar_url" alt="" referrerpolicy="no-referrer" loading="lazy" @error="avatarFailed(user)" />
                    <span v-else class="users-person__avatar" aria-hidden="true">{{ initial(user) }}</span>
                    <span class="users-person__text">
                      <strong class="users-person__name">
                        {{ displayName(user) }}
                        <span v-if="user.is_platform_admin" class="badge badge--neutral">{{ t('platformUsers.superadmin') }}</span>
                      </strong>
                      <span v-if="user.name && user.email" class="muted users-sub users-email">{{ emailParts(user.email)[0] }}<wbr>{{ emailParts(user.email)[1] }}</span>
                    </span>
                  </div>
                </td>
                <td class="users-nowrap" :data-label="t('platformUsers.columns.registered')">{{ formatDate(user.created_at) }}</td>
                <td class="users-nowrap" :data-label="t('platformUsers.columns.lastSeen')" :title="activityTitle(user)">{{ formatRelative(user.last_seen_at) }}</td>
                <td :data-label="t('platformUsers.columns.tournaments')">
                  <button
                    v-if="user.tournaments.length"
                    type="button"
                    class="users-count"
                    :aria-expanded="expanded.has(user.id)"
                    :aria-label="`${countText(t, locale, 'tournaments', user.tournaments.length)}. ${t(expanded.has(user.id) ? 'platformUsers.hideTournaments' : 'platformUsers.showTournaments', { name: displayName(user) })}`"
                    @click="toggle(user)"
                  >
                    {{ countText(t, locale, 'tournaments', user.tournaments.length) }}
                    <svg class="users-count__chevron" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg>
                  </button>
                  <span v-else class="muted">{{ t('platformUsers.none') }}</span>
                </td>
                <td :data-label="t('platformUsers.columns.latest')" :class="{ 'users-table__latest--empty': !latestTournament(user) }">
                  <template v-if="latestTournament(user)">
                    <span class="users-latest">{{ latestTournament(user).name }}</span>
                    <span class="muted users-sub">{{ formatDate(latestTournament(user).created_at) }}</span>
                  </template>
                  <span v-else class="muted">—</span>
                </td>
              </tr>
              <tr v-if="expanded.has(user.id)" class="users-table__detail">
                <td colspan="5">
                  <ul class="users-tournaments">
                    <li v-for="item in user.tournaments" :key="item.id" class="users-tournament">
                      <div class="users-tournament__main">
                        <a class="users-tournament__name" :href="`/tournaments/${item.slug}`" target="_blank" rel="noopener" :title="t('platformUsers.openPublic')">{{ item.name }} ↗</a>
                        <span class="muted users-sub">{{ tournamentMeta(item) }} · {{ t('platformUsers.createdOn', { date: formatDate(item.created_at) }) }}</span>
                      </div>
                      <div class="users-tournament__badges">
                        <span class="badge" :class="statusBadgeClass(item.status)">{{ t(`tournament.${item.status}`) }}</span>
                        <span v-if="item.role !== 'owner'" class="badge badge--neutral">{{ t(`admin.${item.role}`) }}</span>
                        <span v-if="item.visibility && item.visibility !== 'link'" class="badge badge--neutral">{{ t(`access.visibility.${item.visibility}`) }}</span>
                      </div>
                      <div class="users-tournament__numbers">
                        <span>{{ countText(t, locale, 'participants', item.approved) }}</span>
                        <span v-if="item.pending" class="users-sub users-pending">{{ t('platformUsers.pendingEntries', { n: item.pending }) }}</span>
                        <span v-if="item.matches" class="muted users-sub">{{ t('platformUsers.playedOf', { played: item.played, total: item.matches }) }}</span>
                      </div>
                    </li>
                  </ul>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.users-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
.users-stats { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: var(--space-3); }
.users-stat { display: flex; flex-direction: column; gap: 2px; padding: var(--space-4); min-width: 0; }
.users-stat__label { font-size: 0.8125rem; color: var(--muted); }
.users-stat__value { font-family: var(--font-display); font-size: 1.75rem; font-weight: 700; line-height: 1.2; color: var(--heading); }
.users-stat__note { font-size: 0.8125rem; color: var(--muted); font-variant-numeric: tabular-nums; }

.users-toolbar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-3); }
.users-toolbar__search { flex: 1 1 220px; min-width: 0; }
.users-toolbar__sort { flex: 0 1 auto; width: auto; }
.users-empty { margin: 0; padding: 16px; text-align: center; border: 1.5px dashed var(--border-strong); border-radius: var(--radius-sm); }

.users-scroll { overflow-x: auto; margin: 0 calc(var(--space-4) * -1); padding: 0 var(--space-4); }
.users-table { width: 100%; min-width: 720px; border-collapse: collapse; font-size: 0.875rem; }
.users-table th {
  padding: 0 10px 8px;
  text-align: left;
  font-size: 0.75rem;
  font-weight: 600;
  color: var(--muted);
  border-bottom: 1px solid var(--border);
}
.users-table td { padding: 12px 10px; vertical-align: middle; border-bottom: 1px solid var(--border); }
.users-table th:first-child,
.users-table td:first-child { padding-left: 0; }
.users-table__row--open td { border-bottom-color: transparent; }
.users-table__detail td { padding-top: 0; }
.users-nowrap { white-space: nowrap; }
.users-sub { display: block; margin-top: 2px; font-size: 0.8125rem; overflow-wrap: anywhere; }

.users-person { display: flex; align-items: center; gap: 10px; min-width: 0; }
.users-person__avatar {
  flex: none; width: 32px; height: 32px; border-radius: 50%; object-fit: cover;
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--primary-soft); color: var(--primary); font-weight: 600;
}
.users-person__text { min-width: 0; }
.users-person__name { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-weight: 600; color: var(--text); overflow-wrap: anywhere; }
.users-latest { display: block; overflow-wrap: anywhere; }
.users-email { overflow-wrap: break-word; }

.users-count {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 8px; margin-left: -8px;
  border: 0; border-radius: 8px; background: transparent; color: var(--primary); font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap;
}
.users-count:hover { background: var(--primary-soft); }
.users-count:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.users-count__chevron { transition: transform 0.15s ease; }
.users-count[aria-expanded='true'] .users-count__chevron { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .users-count__chevron { transition: none; } }

.users-tournaments { list-style: none; margin: 0; padding: 4px 0 4px 42px; display: flex; flex-direction: column; gap: 8px; }
.users-tournament {
  display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(150px, auto); align-items: center; gap: 8px 16px;
  padding: 10px 12px; border-radius: var(--radius-sm); background: var(--surface-row);
}
.users-tournament__main { min-width: 0; }
.users-tournament__name { font-weight: 600; color: var(--primary); text-decoration: none; overflow-wrap: anywhere; }
.users-tournament__name:hover { text-decoration: underline; }
.users-tournament__badges { display: flex; flex-wrap: wrap; gap: 6px; }
.users-tournament__numbers { text-align: right; font-variant-numeric: tabular-nums; }
.users-pending { color: var(--warning-text); }

/* Phones: each user becomes a card (labelled facts in two columns), no sideways scrolling. */
@media (max-width: 640px) {
  .users-toolbar__sort { flex: 1 1 100%; }
  /* Three equal segments across the width, the count under its label. */
  .users-toolbar .filter-segment { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); flex: 1 1 100%; }
  .users-toolbar .filter-segment__btn { padding: 6px 4px; line-height: 1.25; font-size: 0.8125rem; }
  .users-filter__count { display: block; }
  .users-count { min-height: 44px; }
  .users-table__latest--empty { display: none !important; }
  .users-scroll { overflow-x: visible; margin: 0; padding: 0; }
  .users-table { min-width: 0; display: block; }
  .users-table thead { display: none; }
  .users-table tbody { display: flex; flex-direction: column; }
  .users-table tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 12px; padding: 14px 0; border-bottom: 1px solid var(--border); }
  .users-table td { display: block; padding: 0; border: 0; min-width: 0; }
  .users-table td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 2px; font-size: 0.75rem; font-weight: 600; color: var(--muted); }
  .users-table__person { grid-column: 1 / -1; }
  .users-nowrap { white-space: normal; }
  .users-table tr.users-table__row--open { border-bottom: 0; padding-bottom: 6px; }
  .users-table__detail { padding-top: 0; }
  .users-table__detail td { grid-column: 1 / -1; }
  .users-tournaments { padding-left: 0; }
  .users-tournament { grid-template-columns: minmax(0, 1fr); }
  .users-tournament__numbers { text-align: left; }
}
</style>
