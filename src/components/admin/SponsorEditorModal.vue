<script setup>
import { computed, reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from '../AppModal.vue'
import SponsorImageField from './SponsorImageField.vue'
import SponsorLockup from '../sponsor/SponsorLockup.vue'
import { createAssetDraft } from '../../lib/sponsorAssets'
import { LOGO_MAX, SPONSOR_TIERS, emptySponsor, safeUrl, saveSponsor, clone } from '../../lib/sponsorship'

// Add or edit one sponsor: name, link, tier, caption and two logos
// (for light and for dark backgrounds).
const props = defineProps({
  tournamentId: { type: String, required: true },
  sponsor: { type: Object, default: null }, // null = new sponsor
})
const emit = defineEmits(['close', 'saved'])
const { t } = useI18n()

const original = props.sponsor ? clone(props.sponsor) : null
const form = reactive(clone(props.sponsor || emptySponsor()))
const draft = createAssetDraft()
const error = ref('')
const urlInvalid = computed(() => Boolean(form.url.trim()) && !safeUrl(form.url))
const preview = computed(() => ({ sponsor: { ...form, name: form.name || t('sponsor.editor.namePlaceholder') }, label: '', slot: 'hero' }))

function close() {
  draft.discard()
  emit('close')
}

function submit() {
  error.value = ''
  if (!form.name.trim() || urlInvalid.value) return
  try {
    saveSponsor(props.tournamentId, clone({ ...form }))
    draft.commit([original?.logo, original?.logoDark], [form.logo, form.logoDark])
    emit('saved', form.id)
    emit('close')
  } catch (err) {
    error.value = t(err?.message === 'quota' ? 'sponsor.errors.quota' : 'sponsor.errors.save')
  }
}
</script>

<template>
  <AppModal :label="sponsor ? t('sponsor.editor.editTitle') : t('sponsor.editor.addTitle')" @close="close">
    <form class="modal-dialog sponsor-editor" @submit.prevent="submit">
      <header class="modal-dialog__head">
        <div>
          <h2 class="section-title" style="margin: 0">{{ sponsor ? t('sponsor.editor.editTitle') : t('sponsor.editor.addTitle') }}</h2>
          <p class="muted" style="margin: 4px 0 0">{{ t('sponsor.editor.hint') }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="close">×</button>
      </header>

      <div class="form-field">
        <label for="sp-name">{{ t('sponsor.editor.name') }} <span class="required" aria-hidden="true">*</span></label>
        <input id="sp-name" v-model="form.name" class="input" required maxlength="80" autocomplete="off" :placeholder="t('sponsor.editor.namePlaceholder')" />
      </div>

      <div class="sponsor-editor__row">
        <div class="form-field">
          <label for="sp-tier">{{ t('sponsor.editor.tier') }}</label>
          <select id="sp-tier" v-model="form.tier" class="input">
            <option v-for="tier in SPONSOR_TIERS" :key="tier" :value="tier">{{ t(`sponsor.tier.${tier}`, 1) }}</option>
          </select>
        </div>
        <div class="form-field">
          <label for="sp-url">{{ t('sponsor.editor.url') }}</label>
          <input id="sp-url" v-model="form.url" class="input" type="text" inputmode="url" maxlength="500" autocomplete="off" placeholder="https://" :aria-invalid="urlInvalid" />
          <p v-if="urlInvalid" class="error-text" role="alert" style="margin: 4px 0 0">{{ t('sponsor.errors.url') }}</p>
        </div>
      </div>

      <div class="form-field">
        <label for="sp-caption">{{ t('sponsor.editor.caption') }}</label>
        <input id="sp-caption" v-model="form.caption" class="input" maxlength="80" autocomplete="off" :placeholder="t('sponsor.editor.captionPlaceholder')" />
        <p class="field-hint">{{ t('sponsor.editor.captionHint') }}</p>
      </div>

      <SponsorImageField
        v-model="form.logo"
        :label="t('sponsor.editor.logo')"
        :hint="t('sponsor.editor.logoHint')"
        :max="LOGO_MAX"
        @uploaded="draft.track"
      />
      <SponsorImageField
        v-model="form.logoDark"
        :label="t('sponsor.editor.logoDark')"
        :hint="t('sponsor.editor.logoDarkHint')"
        :max="LOGO_MAX"
        dark
        @uploaded="draft.track"
      />

      <label class="checkbox-row" for="sp-show-name">
        <input id="sp-show-name" v-model="form.showName" type="checkbox" />
        <span>{{ t('sponsor.editor.showName') }}</span>
      </label>

      <div class="sponsor-editor__preview" aria-hidden="true">
        <span class="sponsor-editor__preview-light"><SponsorLockup :lockup="preview" size="md" /></span>
      </div>

      <p v-if="error" class="error-text" role="alert">{{ error }}</p>
      <footer class="sponsor-editor__foot">
        <button class="btn btn--ghost" type="button" @click="close">{{ t('actions.cancel') }}</button>
        <button class="btn btn--primary" type="submit" :disabled="!form.name.trim() || urlInvalid">{{ t('sponsor.save') }}</button>
      </footer>
    </form>
  </AppModal>
</template>

<style scoped>
.sponsor-editor { display: grid; gap: 14px; width: min(600px, 100%); }
.sponsor-editor .form-field { margin: 0; }
.sponsor-editor__row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr); gap: 12px; }
.sponsor-editor__preview {
  display: flex;
  padding: 14px 16px;
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  border: 1px solid var(--border);
}
.sponsor-editor__preview :deep(.sponsor-lockup) { pointer-events: none; }
.sponsor-editor__foot { display: flex; justify-content: flex-end; gap: 8px; }
@media (max-width: 560px) {
  .sponsor-editor__row { grid-template-columns: minmax(0, 1fr); }
}
</style>
