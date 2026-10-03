<script setup>
// Organizer button beside "Start live": opens MatchStreamModal for the match.
// The YouTube mark turns red once the match has a link.
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { matchStreamUrl } from '../../lib/matchStream'

const props = defineProps({
  match: { type: Object, required: true },
  // Accessible name with the two sides.
  label: { type: String, default: '' },
})
const emit = defineEmits(['open'])

const { t } = useI18n()
const hasLink = computed(() => Boolean(matchStreamUrl(props.match)))
</script>

<template>
  <button
    class="btn btn--ghost btn--sm stream-btn"
    :class="{ 'stream-btn--set': hasLink }"
    type="button"
    :aria-label="label || t('stream.title')"
    :title="label || t('stream.title')"
    @click.stop="emit('open', match)"
  >
    <svg width="18" height="13" viewBox="0 0 18 13" aria-hidden="true">
      <rect width="18" height="13" rx="3.5" :fill="hasLink ? '#FF0033' : 'currentColor'" :opacity="hasLink ? 1 : 0.55" />
      <path d="M7.2 3.6v5.8L12 6.5z" fill="var(--surface, #fff)" />
    </svg>
    {{ t('stream.button') }}
  </button>
</template>

<style scoped>
.stream-btn { gap: 6px; }
.stream-btn svg { flex: none; }
</style>
