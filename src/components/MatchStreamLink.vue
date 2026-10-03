<script setup>
// "Watch" link to the YouTube broadcast of a match, on every match card of the
// public and admin boards. Renders nothing without a valid stored link.
// On a phone the page that provides `openMatchStream` shows the stream inside
// (score on top, player below); otherwise the link opens YouTube in a new tab.
import { computed, inject } from 'vue'
import { useI18n } from 'vue-i18n'
import { STREAM_SPLIT_QUERY, matchStreamUrl, youtubeEmbedUrl } from '../lib/matchStream'
import { useNarrowLayout } from '../lib/useNarrowLayout'

const props = defineProps({
  match: { type: Object, required: true },
  // Accessible name with the two sides ("Watch the stream on YouTube: A vs B").
  label: { type: String, default: '' },
  // Icon only: for the narrow bracket card.
  compact: { type: Boolean, default: false },
  // Full-width button: the live viewer.
  block: { type: Boolean, default: false },
})

const { t } = useI18n()
const url = computed(() => matchStreamUrl(props.match))
const name = computed(() => props.label || t('stream.watchOnYoutube'))
const openInside = inject('openMatchStream', null)
const phone = useNarrowLayout(STREAM_SPLIT_QUERY)

function onClick(event) {
  if (!openInside || !phone.value || !youtubeEmbedUrl(url.value)) return
  event.preventDefault()
  openInside(props.match)
}
</script>

<template>
  <a
    v-if="url"
    class="stream-link"
    :class="{ 'stream-link--compact': compact, 'stream-link--block': block }"
    :href="url"
    target="_blank"
    rel="noopener noreferrer"
    :aria-label="name"
    :title="name"
    @click.stop="onClick"
  >
    <svg class="stream-link__icon" width="18" height="13" viewBox="0 0 18 13" aria-hidden="true">
      <rect width="18" height="13" rx="3.5" fill="#FF0033" />
      <path d="M7.2 3.6v5.8L12 6.5z" fill="#fff" />
    </svg>
    <span v-if="!compact">{{ block ? t('stream.watchOnYoutube') : t('stream.watch') }}</span>
  </a>
</template>

<style scoped>
.stream-link {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  background: var(--surface);
  color: var(--text);
  font-size: 0.8125rem;
  font-weight: 600;
  text-decoration: none;
  white-space: nowrap;
  transition: border-color 0.15s, background 0.15s;
}
.stream-link:hover { border-color: #FF0033; background: var(--surface-hover); }
.stream-link:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.stream-link__icon { flex: none; }
.stream-link--compact { min-height: 24px; padding: 0 6px; }
.stream-link--block { width: 100%; min-height: var(--touch-min); font-size: 0.9375rem; }
@media (prefers-reduced-motion: reduce) { .stream-link { transition: none; } }
</style>
