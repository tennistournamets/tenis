<script setup>
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import PlacementDiagram from './PlacementDiagram.vue'
import SponsorEditorModal from './SponsorEditorModal.vue'
import BannerEditorModal from './BannerEditorModal.vue'
import SponsorMark from '../sponsor/SponsorMark.vue'
import SponsorLockup from '../sponsor/SponsorLockup.vue'
import SponsorBanner from '../sponsor/SponsorBanner.vue'
import { confirmDialog } from '../../lib/confirmDialog'
import { BANNER_FORMATS, PLACES, patchSlot, removeBanner, sponsorshipConfig } from '../../lib/sponsorship'

// One place on the page, and everything that goes into it: who is shown there,
// with which caption, or which banners — plus a preview of the result.
const props = defineProps({
  tournamentId: { type: String, required: true },
  placeKey: { type: String, required: true },
  canManage: Boolean,
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const place = PLACES.find((p) => p.key === props.placeKey)
const config = computed(() => sponsorshipConfig(props.tournamentId))
const slot = computed(() => config.value.slots[props.placeKey])
const sponsors = computed(() => config.value.sponsors)
const sponsorsById = computed(() => Object.fromEntries(sponsors.value.map((s) => [s.id, s])))
const selected = computed(() => sponsorsById.value[slot.value.sponsorId] || null)
const error = ref('')
const sponsorEditor = ref(null) // { sponsor } | null
const bannerEditor = ref(null) // { banner } | null
const layout = props.placeKey === 'registration' ? 'card' : 'wide'

function save(patch) {
  error.value = ''
  try {
    patchSlot(props.tournamentId, props.placeKey, patch)
  } catch (err) {
    error.value = t(err?.message === 'quota' ? 'sponsor.errors.quota' : 'sponsor.errors.save')
  }
}

// A sponsor created from a logo place goes straight into it.
function onSponsorSaved(id) {
  if (place.kind === 'logo') save({ sponsorId: id, enabled: true })
  if (place.kind === 'partners' && slot.value.sponsorIds) save({ sponsorIds: [...slot.value.sponsorIds, id] })
}

function partnerChecked(id) {
  return !slot.value.sponsorIds || slot.value.sponsorIds.includes(id)
}
function togglePartner(id, on) {
  const current = slot.value.sponsorIds || sponsors.value.map((s) => s.id)
  const next = on ? [...new Set([...current, id])] : current.filter((x) => x !== id)
  const all = sponsors.value.every((s) => next.includes(s.id))
  save({ sponsorIds: all ? null : sponsors.value.map((s) => s.id).filter((x) => next.includes(x)) })
}

async function deleteBanner(banner) {
  const ok = await confirmDialog(t('sponsor.banner.deleteConfirm'), { danger: true, confirmLabel: t('actions.remove') })
  if (ok) removeBanner(props.tournamentId, props.placeKey, banner.id)
}

const previewLockup = computed(() => (selected.value ? { sponsor: selected.value, label: slot.value.label, slot: props.placeKey } : null))
const partnerCount = computed(() => (slot.value.sponsorIds ? slot.value.sponsorIds.length : sponsors.value.length))
</script>

<template>
  <AppModal :label="t(`sponsor.slot.${placeKey}.label`)" @close="emit('close')">
    <div class="modal-dialog place-editor">
      <header class="modal-dialog__head place-editor__head">
        <div class="place-editor__diagram"><PlacementDiagram :place="placeKey" /></div>
        <div class="place-editor__title">
          <h2 class="section-title" style="margin: 0">{{ t(`sponsor.slot.${placeKey}.label`) }}</h2>
          <p class="muted" style="margin: 4px 0 0">{{ t(`sponsor.slot.${placeKey}.hint`) }}</p>
          <p v-if="place.kind === 'banner'" class="place-editor__size">{{ t('sponsor.banners.size', { size: BANNER_FORMATS[placeKey].size }) }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </header>

      <label class="place-editor__switch switch">
        <input type="checkbox" :checked="slot.enabled" :disabled="!canManage" @change="save({ enabled: $event.target.checked })" />
        <span class="switch__track"><span class="switch__thumb"></span></span>
        <span class="switch__label">{{ slot.enabled ? t('sponsor.place.on') : t('sponsor.place.off') }}</span>
      </label>

      <!-- Logo place: pick who is shown, write the caption. -->
      <template v-if="place.kind === 'logo'">
        <fieldset class="place-editor__group">
          <legend>{{ t('sponsor.place.whoTitle') }}</legend>
          <div class="place-editor__choices" role="radiogroup" :aria-label="t('sponsor.place.whoTitle')">
            <button
              v-for="sponsor in sponsors"
              :key="sponsor.id"
              type="button"
              role="radio"
              class="place-editor__choice"
              :class="{ 'place-editor__choice--active': slot.sponsorId === sponsor.id }"
              :aria-checked="slot.sponsorId === sponsor.id"
              :disabled="!canManage"
              @click="save({ sponsorId: slot.sponsorId === sponsor.id ? null : sponsor.id })"
            >
              <SponsorMark :sponsor="sponsor" :height="28" />
              <span v-if="sponsor.logo || sponsor.logoDark" class="place-editor__choice-name">{{ sponsor.name }}</span>
            </button>
            <button v-if="canManage" type="button" class="place-editor__choice place-editor__choice--add" @click="sponsorEditor = { sponsor: null }">
              <span class="place-editor__plus" aria-hidden="true">+</span>
              <span class="place-editor__choice-name">{{ t('sponsor.place.newSponsor') }}</span>
            </button>
          </div>
          <p v-if="!sponsors.length" class="field-hint" style="margin: 0">{{ t('sponsor.place.noSponsorsHint') }}</p>
          <div v-if="selected && canManage" class="row" style="gap: 6px">
            <button class="btn btn--ghost btn--sm" type="button" @click="sponsorEditor = { sponsor: selected }">{{ t('sponsor.place.editSponsor', { name: selected.name }) }}</button>
          </div>
        </fieldset>

        <div class="form-field" style="margin: 0">
          <label :for="`place-${placeKey}-caption`">{{ t('sponsor.logos.caption') }}</label>
          <input
            :id="`place-${placeKey}-caption`"
            class="input"
            maxlength="60"
            :value="slot.label"
            :placeholder="t(`sponsor.slot.${placeKey}.default`)"
            :disabled="!canManage"
            @change="save({ label: $event.target.value.trim() })"
          />
        </div>

        <div class="place-editor__preview">
          <p class="place-editor__preview-label">{{ t('sponsor.banner.preview') }}</p>
          <SponsorLockup v-if="previewLockup" :lockup="previewLockup" size="md" />
          <p v-else class="muted" style="margin: 0">{{ t('sponsor.place.emptyPreview') }}</p>
        </div>
      </template>

      <!-- Banner place: its banners (one is shown per page view). -->
      <template v-else-if="place.kind === 'banner'">
        <ul v-if="slot.banners.length" class="place-editor__banners">
          <li v-for="banner in slot.banners" :key="banner.id" class="place-editor__banner">
            <div class="place-editor__banner-thumb" :class="{ 'place-editor__banner-thumb--card': layout === 'card' }">
              <SponsorBanner :banner="banner" :sponsor="sponsorsById[banner.sponsorId] || null" :layout="layout" :placement="placeKey" preview />
            </div>
            <div v-if="canManage" class="row" style="gap: 6px">
              <button class="btn btn--outline btn--sm" type="button" @click="bannerEditor = { banner }">{{ t('sponsor.edit') }}</button>
              <button class="btn btn--ghost btn--sm" type="button" @click="deleteBanner(banner)">{{ t('actions.remove') }}</button>
            </div>
          </li>
        </ul>
        <div v-else class="place-editor__empty">
          <p class="empty-state__title" style="margin: 0">{{ t('sponsor.place.noBanners') }}</p>
          <p class="muted" style="margin: 0">{{ t('sponsor.place.noBannersHint') }}</p>
        </div>
        <p v-if="slot.banners.length > 1" class="field-hint" style="margin: 0">{{ t('sponsor.banners.rotation', { n: slot.banners.length }) }}</p>
        <div v-if="canManage">
          <button class="btn btn--primary btn--sm" type="button" @click="bannerEditor = { banner: null }">+ {{ t('sponsor.banners.add') }}</button>
        </div>
      </template>

      <!-- Partners block: heading and who is in it. -->
      <template v-else>
        <div class="form-field" style="margin: 0">
          <label for="place-partners-title">{{ t('sponsor.partners.heading') }}</label>
          <input id="place-partners-title" class="input" maxlength="60" :value="slot.title" :placeholder="t('sponsor.partnersTitle')" :disabled="!canManage" @change="save({ title: $event.target.value.trim() })" />
        </div>
        <fieldset class="place-editor__group">
          <legend>{{ t('sponsor.partners.who') }} · {{ partnerCount }}</legend>
          <label v-for="sponsor in sponsors" :key="sponsor.id" class="checkbox-row">
            <input type="checkbox" :checked="partnerChecked(sponsor.id)" :disabled="!canManage" @change="togglePartner(sponsor.id, $event.target.checked)" />
            <span>{{ sponsor.name }} <span class="muted">· {{ t(`sponsor.tier.${sponsor.tier}`, 1) }}</span></span>
          </label>
          <p v-if="!sponsors.length" class="field-hint" style="margin: 0">{{ t('sponsor.place.noSponsorsHint') }}</p>
          <div v-if="canManage">
            <button class="btn btn--outline btn--sm" type="button" @click="sponsorEditor = { sponsor: null }">+ {{ t('sponsor.place.newSponsor') }}</button>
          </div>
        </fieldset>
      </template>

      <p v-if="error" class="error-text" role="alert" style="margin: 0">{{ error }}</p>
      <footer class="place-editor__foot">
        <button class="btn btn--primary" type="button" @click="emit('close')">{{ t('sponsor.place.done') }}</button>
      </footer>
    </div>

    <SponsorEditorModal
      v-if="sponsorEditor"
      :tournament-id="tournamentId"
      :sponsor="sponsorEditor.sponsor"
      @saved="!sponsorEditor.sponsor && onSponsorSaved($event)"
      @close="sponsorEditor = null"
    />
    <BannerEditorModal
      v-if="bannerEditor"
      :tournament-id="tournamentId"
      :slot-key="placeKey"
      :banner="bannerEditor.banner"
      :sponsors="sponsors"
      @close="bannerEditor = null"
    />
  </AppModal>
</template>

<style scoped>
.place-editor { display: grid; gap: 16px; width: min(640px, 100%); }
.place-editor__head { display: grid; grid-template-columns: 112px minmax(0, 1fr) auto; align-items: start; gap: 14px; margin: 0; }
.place-editor__diagram { padding: 6px; border-radius: var(--radius-sm); background: var(--bg); }
.place-editor__size { margin: 6px 0 0; font-size: 0.8125rem; color: var(--muted); }
.place-editor__switch { min-height: 32px; }
.place-editor__group { display: grid; gap: 10px; margin: 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.place-editor__group legend { padding: 0 6px; font-size: 0.8125rem; font-weight: 700; color: var(--text); }
.place-editor__choices { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 8px; }
.place-editor__choice {
  display: grid;
  justify-items: center;
  align-content: center;
  gap: 8px;
  min-height: 84px;
  padding: 10px;
  color: var(--text);
  font: inherit;
  text-align: center;
  background: var(--surface-2);
  border: 1.5px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.place-editor__choice:hover:not(:disabled) { border-color: var(--border-strong); }
.place-editor__choice:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.place-editor__choice--active { border-color: var(--primary); background: var(--primary-muted); }
.place-editor__choice--add { border-style: dashed; color: var(--primary); }
.place-editor__choice :deep(.sponsor-mark) { max-width: 110px; }
.place-editor__choice-name { font-size: 0.8125rem; font-weight: 600; overflow-wrap: anywhere; }
.place-editor__plus { font-size: 1.5rem; line-height: 1; }
.place-editor__preview { display: grid; gap: 8px; padding: 12px 14px; border-radius: var(--radius-sm); background: var(--bg); border: 1px solid var(--border); }
.place-editor__preview :deep(.sponsor-lockup) { pointer-events: none; }
.place-editor__preview-label { margin: 0; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.place-editor__banners { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
.place-editor__banner { display: grid; gap: 8px; padding: 10px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--surface-2); }
.place-editor__banner-thumb { pointer-events: none; min-width: 0; }
.place-editor__banner-thumb--card { width: min(280px, 100%); }
.place-editor__banner-thumb :deep(.sponsor-banner) { box-shadow: none; }
.place-editor__empty { display: grid; gap: 4px; padding: 20px; text-align: center; border: 1.5px dashed var(--border-strong); border-radius: var(--radius-sm); }
.place-editor__foot { display: flex; justify-content: flex-end; }
@media (max-width: 520px) {
  .place-editor__head { grid-template-columns: 72px minmax(0, 1fr) auto; }
}
</style>
