<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SponsorMark from './SponsorMark.vue'
import { sponsorLink, trackSponsorClick } from '../../lib/sponsorship'

// "Presented by [logo] Name": the quiet attribution line of the logo slots.
// The caption is the organizer's own text, or the slot's default.
const props = defineProps({
  lockup: { type: Object, required: true }, // { sponsor, label, slot }
  size: { type: String, default: 'sm' }, // sm | md
  campaign: { type: String, default: '' },
})
const { t } = useI18n()

const sponsor = computed(() => props.lockup.sponsor)
const caption = computed(() => props.lockup.label || t(`sponsor.slot.${props.lockup.slot}.default`))
// Without a logo the mark already is the name.
const showName = computed(() => sponsor.value.showName && (sponsor.value.logo || sponsor.value.logoDark))
const href = computed(() => sponsorLink(sponsor.value.url, props.lockup.slot, props.campaign))
</script>

<template>
  <component
    :is="href ? 'a' : 'span'"
    class="sponsor-lockup"
    :class="`sponsor-lockup--${size}`"
    :href="href || undefined"
    :target="href ? '_blank' : undefined"
    :rel="href ? 'noopener sponsored' : undefined"
    @click.stop="href && trackSponsorClick(sponsor, lockup.slot)"
  >
    <span v-if="caption" class="sponsor-lockup__label">{{ caption }}</span>
    <SponsorMark :sponsor="sponsor" :height="size === 'md' ? 28 : 20" />
    <span v-if="showName" class="sponsor-lockup__name">{{ sponsor.name }}</span>
  </component>
</template>

<style scoped>
.sponsor-lockup {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  max-width: 100%;
  color: var(--muted);
  text-decoration: none;
  font-size: 0.75rem;
  line-height: 1.1;
  border-radius: 6px;
  transition: color 0.15s;
}
a.sponsor-lockup:hover { color: var(--text); }
.sponsor-lockup:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
.sponsor-lockup__label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sponsor-lockup :deep(.sponsor-mark) { max-width: 140px; color: var(--text); }
.sponsor-lockup__name { font-weight: 700; color: var(--text); white-space: nowrap; }
.sponsor-lockup--md { gap: 9px; font-size: 0.8125rem; }
.sponsor-lockup--md .sponsor-lockup__name { font-size: 0.95rem; }
</style>
