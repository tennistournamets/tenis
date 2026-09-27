<script setup>
import { useI18n } from 'vue-i18n'
import SponsorMark from './SponsorMark.vue'
import { sponsorLink, trackSponsorClick } from '../../lib/sponsorship'

// Partners block at the bottom of the public page: sponsors grouped by tier,
// the title partner biggest.
defineProps({
  partners: { type: Object, required: true }, // { title, groups: [{ tier, sponsors }] }
  campaign: { type: String, default: '' },
})
const { t } = useI18n()
</script>

<template>
  <section class="card sponsor-partners" :aria-label="partners.title || t('sponsor.partnersTitle')">
    <p class="sponsor-partners__title">{{ partners.title || t('sponsor.partnersTitle') }}</p>
    <div class="sponsor-partners__groups">
    <div v-for="group in partners.groups" :key="group.tier" class="sponsor-partners__group" :class="`sponsor-partners__group--${group.tier}`">
      <p class="sponsor-partners__tier">{{ t(`sponsor.tier.${group.tier}`, group.sponsors.length) }}</p>
      <ul class="sponsor-partners__list">
        <li v-for="sponsor in group.sponsors" :key="sponsor.id">
          <component
            :is="sponsor.url ? 'a' : 'span'"
            class="sponsor-partners__item"
            :href="sponsorLink(sponsor.url, 'partners', campaign) || undefined"
            :target="sponsor.url ? '_blank' : undefined"
            :rel="sponsor.url ? 'noopener sponsored' : undefined"
            @click="sponsor.url && trackSponsorClick(sponsor, 'partners')"
          >
            <SponsorMark :sponsor="sponsor" :height="group.tier === 'title' ? 56 : 36" />
            <span v-if="(sponsor.showName && (sponsor.logo || sponsor.logoDark)) || sponsor.caption" class="sponsor-partners__text">
              <strong v-if="sponsor.showName && (sponsor.logo || sponsor.logoDark)" class="sponsor-partners__name">{{ sponsor.name }}</strong>
              <span v-if="sponsor.caption" class="sponsor-partners__caption">{{ sponsor.caption }}</span>
            </span>
          </component>
        </li>
      </ul>
    </div>
    </div>
  </section>
</template>

<style scoped>
.sponsor-partners { display: grid; gap: 16px; padding: 18px 20px; }
.sponsor-partners__title {
  margin: 0;
  font-size: 0.75rem;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted);
}
.sponsor-partners__groups { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 18px 48px; }
.sponsor-partners__group { display: grid; gap: 8px; align-content: start; }
.sponsor-partners__group--title { flex-basis: 100%; }
.sponsor-partners__tier { margin: 0; font-size: 0.8125rem; font-weight: 600; color: var(--text-muted); }
.sponsor-partners__list { display: flex; flex-wrap: wrap; align-items: center; gap: 14px 32px; margin: 0; padding: 0; list-style: none; }
.sponsor-partners__item {
  display: inline-flex;
  align-items: center;
  gap: 12px;
  min-height: 44px;
  color: var(--text);
  text-decoration: none;
  border-radius: var(--radius-sm);
}
a.sponsor-partners__item:hover .sponsor-partners__name { color: var(--primary); }
.sponsor-partners__item:focus-visible { outline: 2px solid var(--primary); outline-offset: 4px; }
.sponsor-partners__item :deep(.sponsor-mark) { max-width: 200px; }
.sponsor-partners__text { display: grid; gap: 2px; }
.sponsor-partners__name { font-size: 1.05rem; }
.sponsor-partners__group--title .sponsor-partners__name { font-size: 1.25rem; }
.sponsor-partners__caption { font-size: 0.8125rem; color: var(--text-muted); }
</style>
