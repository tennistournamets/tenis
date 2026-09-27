<script setup>
import { computed, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { ACCEPTED_TYPES, prepareImage, resolveAssetUrl, uploadAsset } from '../../lib/sponsorAssets'

// One image of a sponsor or a banner: pick or drop a file, see it, replace or remove it.
// Uploads are shrunk to `max` and stored in the tournament's Storage folder.
const props = defineProps({
  modelValue: { type: Object, default: null },
  tournamentId: { type: String, required: true }, // files go into this tournament's folder
  label: { type: String, required: true },
  hint: { type: String, default: '' },
  max: { type: Object, default: () => ({ maxWidth: 1600, maxHeight: 1600 }) },
  dark: Boolean, // preview on a dark background (logo for the dark theme)
  wide: Boolean, // banner-shaped preview
  disabled: Boolean,
})
const emit = defineEmits(['update:modelValue', 'uploaded'])
const { t } = useI18n()
const inputId = useId()
const input = ref(null)
const busy = ref(false)
const error = ref('')
const dragging = ref(false)
const src = computed(() => resolveAssetUrl(props.modelValue))

async function accept(file) {
  if (!file) return
  error.value = ''
  busy.value = true
  try {
    const asset = await uploadAsset(props.tournamentId, await prepareImage(file, props.max))
    emit('uploaded', asset)
    emit('update:modelValue', asset)
  } catch (err) {
    const code = err?.message
    error.value = t(code === 'type' ? 'sponsor.image.errorType'
      : code === 'size' ? 'sponsor.image.errorSize'
        : code === 'upload' ? 'sponsor.image.errorUpload' : 'sponsor.image.errorGeneric')
  } finally {
    busy.value = false
    if (input.value) input.value.value = ''
  }
}

function onDrop(event) {
  dragging.value = false
  if (!props.disabled) void accept(event.dataTransfer?.files?.[0])
}
</script>

<template>
  <div class="form-field sponsor-image-field">
    <label :for="inputId">{{ label }}</label>
    <div
      class="sponsor-image-field__box"
      :class="{ 'sponsor-image-field__box--dark': dark, 'sponsor-image-field__box--wide': wide, 'sponsor-image-field__box--drag': dragging }"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <img v-if="src" class="sponsor-image-field__preview" :src="src" alt="" />
      <span v-else class="sponsor-image-field__empty">{{ busy ? t('sponsor.image.processing') : t('sponsor.image.drop') }}</span>
      <div class="sponsor-image-field__actions">
        <button class="btn btn--outline btn--sm" type="button" :disabled="disabled || busy" @click="input?.click()">
          {{ modelValue ? t('sponsor.image.replace') : t('sponsor.image.choose') }}
        </button>
        <button v-if="modelValue" class="btn btn--ghost btn--sm" type="button" :disabled="disabled || busy" @click="emit('update:modelValue', null)">
          {{ t('actions.remove') }}
        </button>
      </div>
    </div>
    <input
      :id="inputId"
      ref="input"
      class="sr-only"
      type="file"
      :accept="ACCEPTED_TYPES.join(',')"
      :disabled="disabled || busy"
      @change="accept($event.target.files?.[0])"
    />
    <p v-if="error" class="error-text" role="alert" style="margin: 4px 0 0">{{ error }}</p>
    <p v-else-if="hint" class="field-hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.sponsor-image-field__box {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  min-height: 76px;
  padding: 10px 12px;
  border: 1.5px dashed var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  transition: border-color 0.15s, background 0.15s;
}
.sponsor-image-field__box--drag { border-color: var(--primary); background: var(--primary-muted); }
.sponsor-image-field__box--dark { background: #10284A; border-color: #2B4A74; }
.sponsor-image-field__box--dark .sponsor-image-field__empty { color: rgba(255, 255, 255, 0.7); }
.sponsor-image-field__preview { display: block; max-width: 180px; max-height: 56px; object-fit: contain; }
.sponsor-image-field__box--wide .sponsor-image-field__preview { max-width: 100%; max-height: 120px; border-radius: 8px; }
.sponsor-image-field__box--wide { flex-direction: column; align-items: flex-start; }
.sponsor-image-field__empty { font-size: 0.8125rem; color: var(--muted); }
.sponsor-image-field__actions { display: flex; flex-wrap: wrap; gap: 6px; margin-left: auto; }
.sponsor-image-field__box--wide .sponsor-image-field__actions { margin-left: 0; }
</style>
