<script setup>
// Shown at the two moments organizers invite people: right after creating the tournament
// (registration is open) and right after starting it (spectators follow the live score).
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppModal from './AppModal.vue'
import AppIcon from './AppIcon.vue'
import CopyTournamentLink from './CopyTournamentLink.vue'
import { tournamentShareUrl } from '../lib/shareLink'
import { SHARE_CHANNELS, shareHref, taggedUrl } from '../lib/shareChannels'
import { track } from '../lib/analytics'

const props = defineProps({
  slug: { type: String, required: true },
  name: { type: String, default: '' },
  // created | started
  moment: { type: String, default: 'created' },
})
const emit = defineEmits(['close', 'qr', 'poster'])
const { t } = useI18n()

const url = tournamentShareUrl(props.slug)
const text = computed(() => t(`share.moment.${props.moment}Message`, { name: props.name }))
const links = computed(() => SHARE_CHANNELS.map(channel => ({
  channel,
  href: shareHref(channel, { url, text: text.value, subject: props.name }),
})))
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
const shareFailed = ref(false)

function sent(channel) {
  track('share_channel', { channel, moment: props.moment })
}

async function systemShare() {
  shareFailed.value = false
  try {
    await navigator.share({ title: props.name || undefined, text: text.value, url: taggedUrl(url, 'system') })
    sent('system')
  } catch (error) {
    // AbortError = the organizer closed the sheet; nothing to report.
    if (error?.name !== 'AbortError') shareFailed.value = true
  }
}
</script>

<template>
  <AppModal :label="t(`share.moment.${moment}Title`)" @close="emit('close')">
    <div class="modal-dialog share-modal">
      <div class="modal-dialog__head">
        <div>
          <h2>{{ t(`share.moment.${moment}Title`) }}</h2>
          <p class="muted">{{ t(`share.moment.${moment}Hint`) }}</p>
        </div>
        <button class="modal-close" type="button" :aria-label="t('actions.close')" @click="emit('close')">×</button>
      </div>

      <div class="share-modal__channels">
        <a
          v-for="link in links"
          :key="link.channel"
          class="share-modal__channel"
          :class="`share-modal__channel--${link.channel}`"
          :href="link.href"
          target="_blank"
          rel="noopener"
          @click="sent(link.channel)"
        >{{ t(`share.channel.${link.channel}`) }}</a>
        <button v-if="canShare" class="share-modal__channel" type="button" @click="systemShare">
          <AppIcon name="share" :size="18" />{{ t('share.channel.more') }}
        </button>
      </div>
      <p v-if="shareFailed" class="alert alert--error" role="alert">{{ t('share.copyFailed') }}</p>

      <div class="share-modal__footer">
        <CopyTournamentLink :slug="slug" :name="name" compact />
        <button class="btn btn--outline btn--sm" type="button" @click="emit('qr')">
          <AppIcon name="qr" :size="18" />{{ t('share.qrButton') }}
        </button>
        <button class="btn btn--outline btn--sm" type="button" @click="emit('poster')">{{ t('poster.open') }}</button>
      </div>
    </div>
  </AppModal>
</template>

<style scoped>
.share-modal {
  max-width: 460px;
  text-align: left;
}

.share-modal__channels {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: var(--space-2);
  margin: var(--space-4) 0;
}

.share-modal__channel {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 48px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  background: var(--surface);
  color: var(--text);
  font: inherit;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
}

.share-modal__channel:hover { border-color: var(--primary); }
.share-modal__channel:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.share-modal__channel--whatsapp { border-color: #25D366; }
.share-modal__channel--telegram { border-color: #229ED9; }
.share-modal__channel--viber { border-color: #7360F2; }

.share-modal__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  align-items: center;
  gap: var(--space-2);
}
</style>
