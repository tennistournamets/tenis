<script setup>
// QR code for the public tournament page. Rendered on demand from the slug —
// nothing is stored; the same modal serves the create wizard and the admin header.
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'

import { tournamentShareUrl, copyTournamentLink } from '../lib/shareLink'

const props = defineProps({
  slug: { type: String, required: true },
  name: { type: String, default: '' },
})

const emit = defineEmits(['close'])

const { t } = useI18n()

const canvasEl = ref(null)
const copyFeedback = ref(false)
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'

const url = tournamentShareUrl(props.slug)

// High error correction so the code scans from posters/screens even when partly obscured.
const QR_OPTS = {
  errorCorrectionLevel: 'H',
  margin: 2,
  color: { dark: '#111111', light: '#ffffff' },
}

onMounted(() => {
  QRCode.toCanvas(canvasEl.value, url, { ...QR_OPTS, width: 260 })
})

async function copyLink() {
  try {
    await copyTournamentLink(props.slug)
  } catch {
    /* still show feedback */
  }
  copyFeedback.value = true
  setTimeout(() => {
    copyFeedback.value = false
  }, 2000)
}

async function downloadPng() {
  const dataUrl = await QRCode.toDataURL(url, { ...QR_OPTS, width: 1024 })
  const a = document.createElement('a')
  a.href = dataUrl
  a.download = `qr-${props.slug}.png`
  a.click()
}

async function shareLink() {
  try {
    await navigator.share({ title: props.name || undefined, url })
  } catch {
    /* user cancelled */
  }
}
</script>

<template>
  <div class="modal-backdrop" @click="emit('close')">
    <div class="modal-dialog qr-modal" role="dialog" aria-modal="true" @click.stop>
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t('share.qrTitle') }}</h2>
          <p v-if="name" class="muted">{{ name }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <div class="qr-modal__code">
        <canvas ref="canvasEl" />
      </div>

      <p class="qr-modal__hint muted">{{ t('share.qrHint') }}</p>

      <p class="qr-modal__url">{{ url }}</p>

      <div class="qr-modal__actions">
        <button class="btn btn--outline btn--sm" type="button" @click="copyLink">
          {{ copyFeedback ? t('share.copied') : t('share.copyLink') }}
        </button>
        <button class="btn btn--outline btn--sm" type="button" @click="downloadPng">
          {{ t('share.qrDownload') }}
        </button>
        <button v-if="canShare" class="btn btn--primary btn--sm" type="button" @click="shareLink">
          {{ t('share.qrShare') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qr-modal {
  max-width: 380px;
  text-align: center;
}

.qr-modal__code {
  display: flex;
  justify-content: center;
  margin: var(--space-3) 0;
}

.qr-modal__code canvas {
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  background: #fff;
}

.qr-modal__hint {
  margin: 0 0 var(--space-2);
  font-size: 0.85rem;
}

.qr-modal__url {
  margin: 0 0 var(--space-4);
  font-family: var(--font-mono);
  font-size: 0.78rem;
  color: var(--muted);
  word-break: break-all;
}

.qr-modal__actions {
  display: flex;
  justify-content: center;
  flex-wrap: wrap;
  gap: var(--space-2);
}
</style>
