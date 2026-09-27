<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import SponsorMark from '../sponsor/SponsorMark.vue'
import SponsorEditorModal from './SponsorEditorModal.vue'
import PlacementEditorModal from './PlacementEditorModal.vue'
import PlacementDiagram from './PlacementDiagram.vue'
import SponsorshipAccessCard from './SponsorshipAccessCard.vue'
import { errorMessage } from '../../lib/errorMessages'
import { fetchSponsorshipRequest, requestSponsorship } from '../../lib/sponsorshipRequests'
import { confirmDialog } from '../../lib/confirmDialog'
import { useAuthStore } from '../../stores/auth'
import {
  PLACES, PLACE_GROUPS, applyDemo, clearSponsorship, moveSponsor,
  removeSponsor, sponsorshipConfig, sponsorshipError, sponsorshipStatus,
} from '../../lib/sponsorship'

// "Sponsors" tab. The places on the pages are the entry point: open a place,
// put a sponsor or banners in it. The sponsor list below is secondary.
const props = defineProps({
  tournament: { type: Object, required: true },
  canManage: Boolean,
  isOwner: Boolean,
})
const { t } = useI18n()

// Paid feature: the places open once a platform admin approved the request.
const access = ref({ loading: true, unavailable: false, row: null, busy: false, error: '' })
const approved = computed(() => access.value.row?.status === 'approved')

async function loadAccess() {
  access.value = { ...access.value, loading: !access.value.row, error: '' }
  try {
    const result = await fetchSponsorshipRequest(props.tournament.id)
    access.value = { ...access.value, loading: false, unavailable: Boolean(result.unavailable), row: result.row ?? null }
  } catch (err) {
    access.value = { ...access.value, loading: false, error: errorMessage(err, t, 'sync.loadFailed') }
  }
}

async function askForSponsorship(message) {
  access.value = { ...access.value, busy: true, error: '' }
  try {
    const row = await requestSponsorship(props.tournament.id, message)
    access.value = { ...access.value, busy: false, row }
  } catch (err) {
    access.value = { ...access.value, busy: false, error: errorMessage(err, t, 'errors.generic') }
  }
}

onMounted(loadAccess)
watch(() => props.tournament.id, loadAccess)

const auth = useAuthStore()
// The bundled demo set is a tool for the platform team, not for organizers.
const canUseDemo = computed(() => props.canManage && auth.platformRole === 'superadmin')
const config = computed(() => sponsorshipConfig(props.tournament.id))
const status = computed(() => sponsorshipStatus(props.tournament.id))
const sponsors = computed(() => config.value.sponsors)
const sponsorsById = computed(() => Object.fromEntries(sponsors.value.map((s) => [s.id, s])))
const error = ref('')
const openPlace = ref(null) // place key | null
const sponsorEditor = ref(null) // { sponsor } | null

// What a place card says: who or what is there, and whether it is shown.
function placeState(place) {
  const slot = config.value.slots[place.key]
  if (place.kind === 'logo') {
    const sponsor = sponsorsById.value[slot.sponsorId] || null
    return { filled: Boolean(sponsor), enabled: slot.enabled, sponsor, text: sponsor?.name || '' }
  }
  if (place.kind === 'banner') {
    const n = slot.banners.length
    const sponsor = sponsorsById.value[slot.banners[0]?.sponsorId] || null
    return { filled: n > 0, enabled: slot.enabled, sponsor, text: n ? t('sponsor.place.bannerCount', { n }) : '' }
  }
  const n = slot.sponsorIds ? slot.sponsorIds.length : sponsors.value.length
  return { filled: n > 0, enabled: slot.enabled, sponsor: null, text: n ? t('sponsor.place.sponsorCount', { n }) : '' }
}

const groups = computed(() => PLACE_GROUPS.map((group) => ({
  group,
  places: PLACES.filter((p) => p.group === group).map((p) => ({ ...p, state: placeState(p) })),
})))
const shownCount = computed(() => PLACES.filter((p) => { const s = placeState(p); return s.filled && s.enabled }).length)

async function guard(action) {
  error.value = ''
  try {
    await action()
  } catch (err) {
    error.value = sponsorshipError(err, t)
  }
}

async function deleteSponsor(sponsor) {
  const ok = await confirmDialog(t('sponsor.list.deleteConfirm', { name: sponsor.name }), { danger: true, confirmLabel: t('actions.remove') })
  if (ok) guard(() => removeSponsor(props.tournament.id, sponsor.id))
}

async function fillDemo() {
  if (sponsors.value.length) {
    const ok = await confirmDialog(t('sponsor.demo.replaceConfirm'), { danger: true, confirmLabel: t('sponsor.demo.replace') })
    if (!ok) return
  }
  await guard(() => applyDemo(props.tournament.id, t))
}

async function resetAll() {
  const ok = await confirmDialog(t('sponsor.resetConfirm'), { danger: true, confirmLabel: t('sponsor.reset') })
  if (!ok) return
  await guard(() => clearSponsorship(props.tournament.id))
}

// Where each sponsor is placed, for the list below.
function placesOf(sponsor) {
  return PLACES.filter((p) => {
    const slot = config.value.slots[p.key]
    if (p.kind === 'logo') return slot.sponsorId === sponsor.id
    if (p.kind === 'banner') return slot.banners.some((b) => b.sponsorId === sponsor.id)
    return !slot.sponsorIds || slot.sponsorIds.includes(sponsor.id)
  }).map((p) => t(`sponsor.slot.${p.key}.label`))
}

const publicHref = computed(() => `/tournaments/${props.tournament.slug}`)
const embedHref = computed(() => `/embed/${props.tournament.slug}`)
const posterHref = computed(() => `/tournaments/${props.tournament.slug}/poster`)
</script>

<template>
  <div class="stack sponsors-tab">
    <p v-if="access.loading" class="muted" style="margin: 0">{{ t('actions.loading') }}</p>
    <p v-else-if="access.unavailable" class="alert alert--info" role="status" style="margin: 0">{{ t('sponsor.access.unavailable') }}</p>
    <SponsorshipAccessCard
      v-else
      :row="access.row"
      :is-owner="isOwner"
      :busy="access.busy"
      :error="access.error"
      @request="askForSponsorship"
      @refresh="loadAccess"
    />
    <p v-if="error" class="alert alert--error" role="alert" style="margin: 0">{{ error }}</p>

    <p v-if="approved && status === 'loading'" class="muted" style="margin: 0">{{ t('actions.loading') }}</p>
    <p v-else-if="approved && status === 'unavailable'" class="alert alert--info" role="status" style="margin: 0">{{ t('sponsor.access.unavailable') }}</p>
    <p v-else-if="approved && status === 'error'" class="alert alert--error" role="alert" style="margin: 0">{{ t('sync.loadFailed') }}</p>

    <template v-if="approved && status === 'ready'">
      <!-- 1. Places: the entry point. -->
      <section class="card stack stack--sm admin-settings-card" aria-labelledby="sp-places-title">
        <div class="settings-section__head">
          <div>
            <h2 id="sp-places-title" class="section-title" style="margin: 0">{{ t('sponsor.place.title') }}</h2>
            <p class="muted" style="margin: 4px 0 0">{{ t('sponsor.place.hint') }}</p>
          </div>
          <span class="badge" :class="shownCount ? 'badge--success' : 'badge--neutral'">{{ t('sponsor.place.shown', { n: shownCount, total: PLACES.length }) }}</span>
        </div>

        <div v-for="g in groups" :key="g.group" class="sponsors-tab__group">
          <h3 class="sponsors-tab__group-title">{{ t(`sponsor.place.group.${g.group}`) }}</h3>
          <ul class="sponsors-tab__places">
            <li v-for="place in g.places" :key="place.key">
              <button
                type="button"
                class="place-card"
                :class="{ 'place-card--filled': place.state.filled, 'place-card--off': place.state.filled && !place.state.enabled }"
                @click="openPlace = place.key"
              >
                <span class="place-card__diagram"><PlacementDiagram :place="place.key" /></span>
                <span class="place-card__body">
                  <span class="place-card__name">{{ t(`sponsor.slot.${place.key}.label`) }}</span>
                  <span
                    class="place-card__badge badge"
                    :class="!place.state.filled ? 'badge--neutral' : place.state.enabled ? 'badge--success' : 'badge--warn'"
                  >
                    {{ !place.state.filled ? t('sponsor.place.stateEmpty') : place.state.enabled ? t('sponsor.place.stateOn') : t('sponsor.place.stateOff') }}
                  </span>
                  <span class="place-card__status">
                    <template v-if="place.state.filled">
                      <SponsorMark v-if="place.state.sponsor && (place.state.sponsor.logo || place.state.sponsor.logoDark)" :sponsor="place.state.sponsor" :height="16" />
                      <span class="place-card__what">{{ place.state.text }}</span>
                    </template>
                    <span v-else class="place-card__empty">{{ t('sponsor.place.empty') }}</span>
                  </span>
                </span>
              </button>
            </li>
          </ul>
        </div>

        <div class="sponsors-tab__links">
          <a class="btn btn--outline btn--sm" :href="publicHref" target="_blank" rel="noopener">{{ t('sponsor.links.public') }} ↗</a>
          <a class="btn btn--ghost btn--sm" :href="embedHref" target="_blank" rel="noopener">{{ t('sponsor.links.embed') }} ↗</a>
          <a class="btn btn--ghost btn--sm" :href="posterHref" target="_blank" rel="noopener">{{ t('sponsor.links.poster') }} ↗</a>
        </div>
      </section>

      <!-- 2. Sponsors: secondary list, created mostly from inside a place. -->
      <section class="card stack stack--sm admin-settings-card" aria-labelledby="sp-list-title">
        <div class="settings-section__head">
          <h2 id="sp-list-title" class="section-title section-title--sm" style="margin: 0">{{ t('sponsor.list.title') }} · {{ sponsors.length }}</h2>
          <div class="row sponsors-tab__head-actions">
            <button v-if="canUseDemo" class="btn btn--ghost btn--sm" type="button" @click="fillDemo">{{ t('sponsor.demo.fill') }}</button>
            <button v-if="canManage" class="btn btn--outline btn--sm" type="button" @click="sponsorEditor = { sponsor: null }">+ {{ t('sponsor.list.add') }}</button>
          </div>
        </div>
        <p v-if="!sponsors.length" class="muted" style="margin: 0">{{ t('sponsor.list.emptyPlaces') }}</p>
        <ul v-else class="sponsors-tab__sponsors">
          <li v-for="(sponsor, index) in sponsors" :key="sponsor.id" class="sponsors-tab__sponsor">
            <span class="sponsors-tab__logo"><SponsorMark :sponsor="sponsor" :height="26" /></span>
            <div class="sponsors-tab__sponsor-text">
              <strong>{{ sponsor.name }} <span class="muted sponsors-tab__tier">· {{ t(`sponsor.tier.${sponsor.tier}`, 1) }}</span></strong>
              <span class="muted">{{ placesOf(sponsor).join(', ') || t('sponsor.list.nowhere') }}</span>
            </div>
            <div v-if="canManage" class="sponsors-tab__actions">
              <button class="btn btn--ghost btn--sm btn--icon" type="button" :disabled="index === 0" :aria-label="t('sponsor.list.up')" @click="guard(() => moveSponsor(tournament.id, sponsor.id, -1))">↑</button>
              <button class="btn btn--ghost btn--sm btn--icon" type="button" :disabled="index === sponsors.length - 1" :aria-label="t('sponsor.list.down')" @click="guard(() => moveSponsor(tournament.id, sponsor.id, 1))">↓</button>
              <button class="btn btn--ghost btn--sm" type="button" @click="sponsorEditor = { sponsor }">{{ t('sponsor.edit') }}</button>
              <button class="btn btn--ghost btn--sm" type="button" @click="deleteSponsor(sponsor)">{{ t('actions.remove') }}</button>
            </div>
          </li>
        </ul>
        <div v-if="canManage && sponsors.length" class="sponsors-tab__reset">
          <button class="btn btn--ghost btn--sm" type="button" @click="resetAll">{{ t('sponsor.reset') }}</button>
        </div>
      </section>
    </template>

    <PlacementEditorModal
      v-if="openPlace"
      :tournament-id="tournament.id"
      :place-key="openPlace"
      :can-manage="canManage"
      @close="openPlace = null"
    />
    <SponsorEditorModal
      v-if="sponsorEditor"
      :tournament-id="tournament.id"
      :sponsor="sponsorEditor.sponsor"
      @close="sponsorEditor = null"
    />
  </div>
</template>

<style scoped>
.sponsors-tab__group { display: grid; gap: 8px; }
.sponsors-tab__group + .sponsors-tab__group { margin-top: 6px; }
.sponsors-tab__group-title { margin: 0; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.sponsors-tab__places { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; margin: 0; padding: 0; list-style: none; }
.place-card {
  display: grid;
  grid-template-columns: 96px minmax(0, 1fr);
  align-items: center;
  gap: 12px;
  width: 100%;
  height: 100%;
  padding: 10px 12px 10px 10px;
  color: var(--text);
  font: inherit;
  text-align: left;
  background: var(--surface);
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, box-shadow 0.15s, transform 0.1s;
}
.place-card:hover { border-color: var(--primary); box-shadow: var(--shadow-md); }
.place-card:active { transform: scale(0.99); }
.place-card:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.place-card--filled { border-style: solid; border-color: var(--border); }
.place-card--off { opacity: 0.75; }
.place-card__diagram { display: block; padding: 4px; border-radius: 8px; background: var(--bg); }
.place-card__body { display: grid; justify-items: start; gap: 5px; min-width: 0; }
.place-card__name { font-weight: 700; font-size: 0.9rem; line-height: 1.2; }
.place-card__badge { font-size: 0.72rem; }
.place-card__status { display: flex; align-items: center; gap: 6px; max-width: 100%; min-height: 18px; font-size: 0.8125rem; color: var(--text-muted); }
.place-card__status :deep(.sponsor-mark) { max-width: 56px; }
.place-card__what { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.place-card__empty { color: var(--primary); font-weight: 600; }
.sponsors-tab__links { display: flex; flex-wrap: wrap; gap: 6px; }
.sponsors-tab__head-actions { gap: 6px; flex-wrap: wrap; margin-left: auto; }
.sponsors-tab__sponsors { display: grid; margin: 0; padding: 0; list-style: none; }
.sponsors-tab__sponsor { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 12px; padding: 8px 0; border-top: 1px solid var(--border); }
.sponsors-tab__sponsor:first-child { border-top: 0; }
.sponsors-tab__logo { display: inline-flex; align-items: center; justify-content: center; width: 88px; height: 40px; padding: 4px; color: var(--text); border-radius: 8px; background: var(--surface-2); }
.sponsors-tab__logo :deep(.sponsor-mark) { max-width: 80px; }
.sponsors-tab__sponsor-text { display: grid; gap: 2px; flex: 1 1 200px; min-width: 0; font-size: 0.875rem; }
.sponsors-tab__sponsor-text .muted { font-size: 0.8125rem; overflow-wrap: anywhere; }
.sponsors-tab__tier { font-weight: 500; }
.sponsors-tab__actions { display: flex; flex-wrap: wrap; gap: 2px; }
.sponsors-tab__reset { display: flex; justify-content: flex-end; }
</style>
