<script setup>
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import SponsorMark from './SponsorMark.vue'
import { resolveAssetUrl } from '../../lib/sponsorAssets'
import { sponsorLink, trackSponsorClick } from '../../lib/sponsorship'

// One sponsor banner, built from what the organizer filled in:
//   picture only        — the uploaded artwork as is (own mobile version optional);
//   text only           — logo, eyebrow, headline, text and button on a brand colour;
//   picture + text      — the text over the picture with a dark scrim for legibility.
// The whole banner is one link; "Ad" stays on unless the organizer turned it off.
const props = defineProps({
  banner: { type: Object, required: true },
  sponsor: { type: Object, default: null },
  layout: { type: String, default: 'wide' }, // wide | card
  placement: { type: String, required: true },
  campaign: { type: String, default: '' },
  preview: Boolean, // editor preview: no link, no tracking
})
const { t } = useI18n()

const imageSrc = computed(() => resolveAssetUrl(props.banner.image))
const mobileSrc = computed(() => resolveAssetUrl(props.banner.imageMobile))
const hasText = computed(() => Boolean(props.banner.title || props.banner.text || props.banner.cta || props.banner.eyebrow))
const mode = computed(() => (props.banner.image ? (hasText.value ? 'overlay' : 'image') : 'text'))

function luminance(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '')
  if (!m) return 0
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4))
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
// Text sits on the picture's scrim or on the chosen colour.
const onDark = computed(() => mode.value !== 'text' || luminance(props.banner.bg) < 0.4)
const showLogo = computed(() => props.banner.showLogo && props.sponsor && mode.value !== 'image')
const href = computed(() => (props.preview ? '' : sponsorLink(props.banner.url || props.sponsor?.url, props.placement, props.campaign)))
const label = computed(() => props.banner.alt || props.banner.title || props.sponsor?.name || t('sponsor.ad'))

function onClick() {
  if (href.value) trackSponsorClick(props.sponsor, props.placement)
}
</script>

<template>
  <component
    :is="href ? 'a' : 'div'"
    class="sponsor-banner"
    :class="[`sponsor-banner--${layout}`, `sponsor-banner--${mode}`, { 'sponsor-banner--light': !onDark }]"
    :style="mode === 'text' ? { background: banner.bg } : undefined"
    :href="href || undefined"
    :target="href ? '_blank' : undefined"
    :rel="href ? 'noopener sponsored' : undefined"
    :aria-label="href ? `${label} — ${t('sponsor.ad')}` : undefined"
    @click="onClick"
  >
    <picture v-if="mode !== 'text' && imageSrc" class="sponsor-banner__picture">
      <source v-if="mobileSrc" media="(max-width: 560px)" :srcset="mobileSrc" />
      <img
        class="sponsor-banner__img"
        :src="imageSrc"
        :alt="mode === 'image' ? label : ''"
        :width="banner.image?.width"
        :height="banner.image?.height"
        loading="lazy"
        decoding="async"
      />
    </picture>

    <div v-if="mode !== 'image'" class="sponsor-banner__content">
      <SponsorMark v-if="showLogo" class="sponsor-banner__logo" :sponsor="sponsor" :height="layout === 'wide' ? 40 : 34" :on-dark="onDark" />
      <div class="sponsor-banner__body">
        <p v-if="banner.adLabel || banner.eyebrow" class="sponsor-banner__eyebrow">
          <span v-if="banner.adLabel" class="sponsor-banner__ad">{{ t('sponsor.ad') }}</span>
          <span v-if="banner.eyebrow">{{ banner.eyebrow }}</span>
        </p>
        <p v-if="banner.title" class="sponsor-banner__title">{{ banner.title }}</p>
        <p v-if="banner.text" class="sponsor-banner__text">{{ banner.text }}</p>
      </div>
      <span v-if="banner.cta" class="sponsor-banner__cta">{{ banner.cta }} <span aria-hidden="true">→</span></span>
    </div>
    <span v-else-if="banner.adLabel" class="sponsor-banner__ad sponsor-banner__ad--corner">{{ t('sponsor.ad') }}</span>
  </component>
</template>

<style scoped>
.sponsor-banner {
  --banner-ink: #fff;
  --banner-soft: rgba(255, 255, 255, 0.8);
  --banner-line: rgba(255, 255, 255, 0.4);
  position: relative;
  isolation: isolate;
  display: block;
  overflow: hidden;
  color: var(--banner-ink);
  text-decoration: none;
  border-radius: var(--radius);
  background: #0A1628;
  box-shadow: var(--shadow-sm);
  transition: box-shadow 0.15s, transform 0.15s;
}
a.sponsor-banner:hover { box-shadow: var(--shadow-md); }
a.sponsor-banner:focus-visible { outline: 2px solid var(--primary); outline-offset: 3px; }
.sponsor-banner--light {
  --banner-ink: #14201B;
  --banner-soft: rgba(20, 32, 27, 0.75);
  --banner-line: rgba(20, 32, 27, 0.3);
  border: 1px solid var(--border);
}

.sponsor-banner__picture { display: block; }
.sponsor-banner__img { display: block; width: 100%; height: auto; }
/* Each slot keeps its shape whatever was uploaded: 4:1 wide (2:1 on phones), 4:3 card. */
.sponsor-banner--image .sponsor-banner__img { aspect-ratio: 4 / 1; object-fit: cover; }
.sponsor-banner--card.sponsor-banner--image .sponsor-banner__img { aspect-ratio: 4 / 3; }

/* Picture + text: the picture fills the banner, a scrim keeps the text readable. */
.sponsor-banner--overlay .sponsor-banner__picture { position: absolute; inset: 0; z-index: -2; }
.sponsor-banner--overlay .sponsor-banner__img { width: 100%; height: 100%; object-fit: cover; }
.sponsor-banner--overlay::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: -1;
  background: linear-gradient(90deg, rgba(6, 12, 20, 0.88) 0%, rgba(6, 12, 20, 0.68) 55%, rgba(6, 12, 20, 0.3) 100%);
}
.sponsor-banner--card.sponsor-banner--overlay::before {
  background: linear-gradient(0deg, rgba(6, 12, 20, 0.92) 0%, rgba(6, 12, 20, 0.78) 55%, rgba(6, 12, 20, 0.5) 100%);
}

.sponsor-banner__content {
  display: grid;
  gap: 14px;
  padding: 18px;
}
.sponsor-banner--wide .sponsor-banner__content {
  grid-template-columns: auto minmax(0, 1fr) auto;
  align-items: center;
  gap: 20px;
  padding: 22px 26px;
}
.sponsor-banner--wide.sponsor-banner--overlay .sponsor-banner__content { min-height: 180px; }
.sponsor-banner--card.sponsor-banner--overlay .sponsor-banner__content { min-height: 260px; align-content: end; }
.sponsor-banner--wide .sponsor-banner__content:not(:has(.sponsor-banner__logo)) { grid-template-columns: minmax(0, 1fr) auto; }
.sponsor-banner__logo { max-width: 160px; }
.sponsor-banner__body { display: grid; gap: 6px; min-width: 0; }
.sponsor-banner__eyebrow {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--banner-soft);
}
.sponsor-banner__ad {
  padding: 2px 6px;
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  border: 1px solid var(--banner-line);
  border-radius: 4px;
}
.sponsor-banner__ad--corner {
  position: absolute;
  top: 10px;
  right: 10px;
  color: #fff;
  background: rgba(0, 0, 0, 0.45);
  border-color: rgba(255, 255, 255, 0.35);
}
.sponsor-banner__title {
  margin: 0;
  color: var(--banner-ink);
  font-family: var(--font-display);
  font-size: 1.2rem;
  font-weight: 700;
  line-height: 1.2;
  letter-spacing: -0.01em;
  overflow-wrap: anywhere;
}
.sponsor-banner--wide .sponsor-banner__title { font-size: 1.35rem; }
.sponsor-banner__text { margin: 0; font-size: 0.875rem; line-height: 1.45; color: var(--banner-soft); overflow-wrap: anywhere; }
.sponsor-banner__cta {
  justify-self: start;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 16px;
  font-size: 0.875rem;
  font-weight: 600;
  white-space: nowrap;
  color: #0A1628;
  background: #fff;
  border-radius: 999px;
}
.sponsor-banner--light .sponsor-banner__cta { color: #fff; background: #14201B; }
.sponsor-banner--wide .sponsor-banner__cta { justify-self: end; }

@media (max-width: 560px) {
  .sponsor-banner--wide.sponsor-banner--image .sponsor-banner__img { aspect-ratio: 2 / 1; }
}
@media (max-width: 640px) {
  .sponsor-banner--wide .sponsor-banner__content,
  .sponsor-banner--wide .sponsor-banner__content:not(:has(.sponsor-banner__logo)) {
    grid-template-columns: minmax(0, 1fr);
    gap: 12px;
    padding: 18px;
  }
  .sponsor-banner--wide .sponsor-banner__cta { justify-self: start; }
  .sponsor-banner--wide.sponsor-banner--overlay::before {
    background: linear-gradient(0deg, rgba(6, 12, 20, 0.88) 0%, rgba(6, 12, 20, 0.5) 70%, rgba(6, 12, 20, 0.25) 100%);
  }
}
</style>
