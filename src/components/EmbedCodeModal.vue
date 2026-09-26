<script setup>
// "Website code" for organizers: a live bracket widget for a club site (public/embed.js).
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from './AppModal.vue'
import { embedPreviewUrl, embedSnippet } from '../lib/embedCode'
import { siteOrigin } from '../lib/siteOrigin'
import { track } from '../lib/analytics'

const props = defineProps({
  slug: { type: String, required: true },
  name: { type: String, default: '' },
  // Password and private tournaments are hidden from anonymous visitors, so the widget stays empty.
  available: { type: Boolean, default: true },
})
const emit = defineEmits(['close'])
const { t, locale } = useI18n()

const code = computed(() => embedSnippet({
  origin: siteOrigin,
  slug: props.slug,
  name: props.name,
  linkText: t('share.embedLinkText', { name: props.name }),
  locale: locale.value,
}))
const previewUrl = computed(() => embedPreviewUrl(siteOrigin, props.slug))
const status = ref('idle')
const codeEl = ref(null)

async function copy() {
  try {
    await navigator.clipboard.writeText(code.value)
    status.value = 'copied'
    track('embed_code_copied')
  } catch {
    status.value = 'failed'
    codeEl.value?.select()
  }
}
</script>

<template>
  <AppModal :label="t('share.embedTitle')" @close="emit('close')">
    <div class="modal-dialog embed-modal">
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('share.embedTitle') }}</h2>
          <p v-if="name" class="muted">{{ name }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <p v-if="!available" class="alert alert--info" role="status">{{ t('share.embedUnavailable') }}</p>
      <template v-else>
        <p class="embed-modal__hint muted">{{ t('share.embedHint') }}</p>
        <label class="sr-only" for="embed-code">{{ t('share.embedButton') }}</label>
        <textarea id="embed-code" ref="codeEl" class="embed-modal__code" readonly rows="5" :value="code" @focus="$event.target.select()" />
        <p v-if="status === 'failed'" class="alert alert--error" role="alert">{{ t('share.embedCopyFailed') }}</p>
        <div class="embed-modal__actions">
          <a class="btn btn--outline btn--sm" :href="previewUrl" target="_blank" rel="noopener">{{ t('share.embedPreview') }} ↗</a>
          <button class="btn btn--primary btn--sm" type="button" @click="copy">
            {{ status === 'copied' ? t('share.embedCopied') : t('share.embedCopy') }}
          </button>
        </div>
        <p class="sr-only" role="status">{{ status === 'copied' ? t('share.embedCopied') : '' }}</p>
      </template>
    </div>
  </AppModal>
</template>

<style scoped>
.embed-modal {
  max-width: 560px;
  text-align: left;
}

.embed-modal__hint {
  margin: 0 0 var(--space-3);
  font-size: 0.875rem;
}

.embed-modal__code {
  width: 100%;
  resize: vertical;
  padding: var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface-2);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  line-height: 1.5;
}

.embed-modal__actions {
  display: flex;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}
</style>
