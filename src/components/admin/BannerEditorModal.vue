<script setup>
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import SponsorImageField from './SponsorImageField.vue'
import SponsorBanner from '../sponsor/SponsorBanner.vue'
import { createAssetDraft } from '../../lib/sponsorAssets'
import { BANNER_FORMATS, DEFAULT_BANNER_BG, bannerIsShowable, emptyBanner, safeUrl, saveBanner, clone, sponsorshipError } from '../../lib/sponsorship'

// Add or edit a banner of one slot, with a live preview. A banner is a picture,
// a text on a colour, or a text over a picture — whatever is filled in.
const props = defineProps({
  tournamentId: { type: String, required: true },
  slotKey: { type: String, required: true },
  banner: { type: Object, default: null }, // null = new banner
  sponsors: { type: Array, default: () => [] },
})
const emit = defineEmits(['close'])
const { t } = useI18n()

const COLORS = ['#10284A', '#0F7B4D', '#14201B', '#1C69D4', '#E7222E', '#F2B705', '#F7F7F4', '#FFFFFF']
const format = BANNER_FORMATS[props.slotKey]
const layout = props.slotKey === 'registration' ? 'card' : 'wide'
const original = props.banner ? clone(props.banner) : null
const form = reactive(clone(props.banner || emptyBanner(props.sponsors[0]?.id || null)))
const draft = createAssetDraft()
const error = ref('')
const busy = ref(false)

const sponsor = computed(() => props.sponsors.find((s) => s.id === form.sponsorId) || null)
const urlInvalid = computed(() => Boolean(form.url.trim()) && !safeUrl(form.url))
const showable = computed(() => bannerIsShowable(form))
// Artwork far from the slot's shape gets cropped: say so before it is published.
const ratioWarning = computed(() => {
  const img = form.image
  if (!img?.width || !img?.height || form.title || form.text) return false
  const ratio = img.width / img.height
  return Math.abs(ratio - format.ratio) / format.ratio > 0.3
})
const previewSponsor = computed(() => sponsor.value)

function close() {
  draft.discard()
  emit('close')
}

async function submit() {
  error.value = ''
  if (!showable.value || urlInvalid.value || busy.value) return
  busy.value = true
  try {
    await saveBanner(props.tournamentId, props.slotKey, clone({ ...form, bg: form.bg || DEFAULT_BANNER_BG }))
    draft.commit([original?.image, original?.imageMobile], [form.image, form.imageMobile])
    emit('close')
  } catch (err) {
    error.value = sponsorshipError(err, t)
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <AppModal :label="banner ? t('sponsor.banner.editTitle') : t('sponsor.banner.addTitle')" @close="close">
    <form class="modal-dialog banner-editor" @submit.prevent="submit">
      <header class="modal-dialog__head">
        <div>
          <h2 class="section-title" style="margin: 0">{{ banner ? t('sponsor.banner.editTitle') : t('sponsor.banner.addTitle') }}</h2>
          <p class="muted" style="margin: 4px 0 0">{{ t(`sponsor.slot.${slotKey}.label`) }} · {{ t('sponsor.banner.modesHint') }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="close">×</button>
      </header>

      <div class="banner-editor__preview" :class="`banner-editor__preview--${layout}`">
        <p class="banner-editor__preview-label">{{ t('sponsor.banner.preview') }}</p>
        <SponsorBanner v-if="showable" :banner="form" :sponsor="previewSponsor" :layout="layout" :placement="slotKey" preview />
        <p v-else class="banner-editor__placeholder">{{ t('sponsor.banner.emptyPreview') }}</p>
      </div>

      <div class="form-field">
        <label for="bn-sponsor">{{ t('sponsor.banner.sponsor') }}</label>
        <select id="bn-sponsor" v-model="form.sponsorId" class="input">
          <option :value="null">{{ t('sponsor.banner.noSponsor') }}</option>
          <option v-for="item in sponsors" :key="item.id" :value="item.id">{{ item.name }}</option>
        </select>
      </div>

      <fieldset class="banner-editor__group">
        <legend>{{ t('sponsor.banner.pictureGroup') }}</legend>
        <SponsorImageField
          v-model="form.image"
          :label="t('sponsor.banner.image')"
          :hint="t('sponsor.banner.imageHint', { size: format.size })"
          :max="format.max"
          :tournament-id="tournamentId"
          wide
          @uploaded="draft.track"
        />
        <p v-if="ratioWarning" class="alert alert--info" role="status" style="margin: 0">{{ t('sponsor.banner.ratioWarning', { size: format.size }) }}</p>
        <SponsorImageField
          v-if="format.mobileSize && form.image"
          v-model="form.imageMobile"
          :label="t('sponsor.banner.imageMobile')"
          :hint="t('sponsor.banner.imageMobileHint', { size: format.mobileSize })"
          :max="format.max"
          :tournament-id="tournamentId"
          wide
          @uploaded="draft.track"
        />
        <div v-if="form.image" class="form-field">
          <label for="bn-alt">{{ t('sponsor.banner.alt') }}</label>
          <input id="bn-alt" v-model="form.alt" class="input" maxlength="140" :placeholder="t('sponsor.banner.altPlaceholder')" />
        </div>
      </fieldset>

      <fieldset class="banner-editor__group">
        <legend>{{ t('sponsor.banner.textGroup') }}</legend>
        <p class="field-hint" style="margin: 0">{{ t('sponsor.banner.textHint') }}</p>
        <div class="form-field">
          <label for="bn-eyebrow">{{ t('sponsor.banner.eyebrow') }}</label>
          <input id="bn-eyebrow" v-model="form.eyebrow" class="input" maxlength="40" :placeholder="t('sponsor.banner.eyebrowPlaceholder')" />
        </div>
        <div class="form-field">
          <label for="bn-title">{{ t('sponsor.banner.title') }}</label>
          <input id="bn-title" v-model="form.title" class="input" maxlength="90" :placeholder="t('sponsor.banner.titlePlaceholder')" />
        </div>
        <div class="form-field">
          <label for="bn-text">{{ t('sponsor.banner.text') }}</label>
          <textarea id="bn-text" v-model="form.text" class="input" rows="2" maxlength="220" :placeholder="t('sponsor.banner.textPlaceholder')" />
        </div>
        <div class="banner-editor__row">
          <div class="form-field">
            <label for="bn-cta">{{ t('sponsor.banner.cta') }}</label>
            <input id="bn-cta" v-model="form.cta" class="input" maxlength="30" :placeholder="t('sponsor.banner.ctaPlaceholder')" />
          </div>
          <div class="form-field">
            <label for="bn-url">{{ t('sponsor.banner.url') }}</label>
            <input id="bn-url" v-model="form.url" class="input" inputmode="url" maxlength="500" :placeholder="sponsor?.url || 'https://'" :aria-invalid="urlInvalid" />
            <p v-if="urlInvalid" class="error-text" role="alert" style="margin: 4px 0 0">{{ t('sponsor.errors.url') }}</p>
            <p v-else class="field-hint">{{ t('sponsor.banner.urlHint') }}</p>
          </div>
        </div>
      </fieldset>

      <fieldset class="banner-editor__group">
        <legend>{{ t('sponsor.banner.lookGroup') }}</legend>
        <div v-if="!form.image" class="form-field">
          <span class="label">{{ t('sponsor.banner.bg') }}</span>
          <div class="banner-editor__colors" role="radiogroup" :aria-label="t('sponsor.banner.bg')">
            <button
              v-for="color in COLORS"
              :key="color"
              type="button"
              class="banner-editor__swatch"
              :class="{ 'banner-editor__swatch--active': form.bg.toLowerCase() === color.toLowerCase() }"
              :style="{ background: color }"
              role="radio"
              :aria-checked="form.bg.toLowerCase() === color.toLowerCase()"
              :aria-label="color"
              @click="form.bg = color"
            />
            <label class="banner-editor__custom">
              <input v-model="form.bg" type="color" :aria-label="t('sponsor.banner.bgCustom')" />
              <span>{{ t('sponsor.banner.bgCustom') }}</span>
            </label>
          </div>
        </div>
        <label v-if="sponsor" class="checkbox-row" for="bn-logo">
          <input id="bn-logo" v-model="form.showLogo" type="checkbox" />
          <span>{{ t('sponsor.banner.showLogo') }}</span>
        </label>
        <label class="checkbox-row" for="bn-ad">
          <input id="bn-ad" v-model="form.adLabel" type="checkbox" />
          <span>{{ t('sponsor.banner.adLabel') }}</span>
        </label>
        <p v-if="!form.adLabel" class="field-hint" style="margin: 0">{{ t('sponsor.banner.adLabelHint') }}</p>
      </fieldset>

      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <footer class="banner-editor__foot">
        <button class="btn btn--ghost" type="button" @click="close">{{ t('actions.cancel') }}</button>
        <button class="btn btn--primary" type="submit" :disabled="!showable || urlInvalid || busy">{{ t('sponsor.save') }}</button>
      </footer>
    </form>
  </AppModal>
</template>

<style scoped>
.banner-editor { display: grid; gap: 14px; width: min(760px, 100%); }
.banner-editor .form-field { margin: 0; }
.banner-editor__preview {
  display: grid;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius-sm);
  background: var(--bg);
  border: 1px solid var(--border);
}
.banner-editor__preview--card > :deep(.sponsor-banner) { max-width: 360px; }
.banner-editor__preview-label { margin: 0; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--muted); }
.banner-editor__placeholder { margin: 0; padding: 24px; text-align: center; font-size: 0.875rem; color: var(--muted); border: 1.5px dashed var(--border-strong); border-radius: var(--radius-sm); }
.banner-editor__group { display: grid; gap: 12px; margin: 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.banner-editor__group legend { padding: 0 6px; font-size: 0.8125rem; font-weight: 700; color: var(--text); }
.banner-editor__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 12px; }
.banner-editor__colors { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
.banner-editor__swatch {
  width: 32px;
  height: 32px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  cursor: pointer;
}
.banner-editor__swatch--active { outline: 2px solid var(--primary); outline-offset: 2px; }
.banner-editor__swatch:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.banner-editor__custom { display: inline-flex; align-items: center; gap: 6px; font-size: 0.8125rem; color: var(--muted); cursor: pointer; }
.banner-editor__custom input { width: 36px; height: 32px; padding: 0; border: 1px solid var(--border-strong); border-radius: 8px; background: none; cursor: pointer; }
.banner-editor__foot { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 560px) {
  .banner-editor__row { grid-template-columns: minmax(0, 1fr); }
}
</style>
