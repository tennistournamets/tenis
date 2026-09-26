<script setup>
// Printable A4 poster for the courts: a big QR code to the public page (utm_source=poster),
// the tournament facts and one line of instructions. Anyone who can see the tournament
// can print it; organizers of private tournaments too (RLS lets them read their own row).
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import QRCode from 'qrcode'
import BrandLogo from '../components/BrandLogo.vue'
import { supabase } from '../lib/supabase'
import { tournamentShareUrl } from '../lib/shareLink'
import { taggedUrl } from '../lib/shareChannels'
import { LABELS, formatDateRange, scheduleSpan } from '../lib/seo'
import { setRobotsMeta } from '../lib/access'
import { useHeaderTitle } from '../lib/headerTitle'

const props = defineProps({ slug: { type: String, required: true } })
const { t, locale } = useI18n()

const tournament = ref(null)
const span = ref({ starts_at: null, ends_at: null })
const state = ref('loading')
const qrSrc = ref('')
useHeaderTitle(() => tournament.value?.name)

const pageUrl = computed(() => tournamentShareUrl(props.slug))
const printedUrl = computed(() => pageUrl.value.replace(/^https?:\/\//, ''))
const facts = computed(() => {
  const row = tournament.value
  if (!row) return []
  const labels = LABELS[locale.value] ?? LABELS.lt
  return [
    labels.sport[row.sport],
    labels.format[row.format],
    formatDateRange(span.value.starts_at, span.value.ends_at, locale.value, row.schedule_config?.timezone),
  ].filter(Boolean)
})

async function load() {
  state.value = 'loading'
  const { data, error } = await supabase
    .from('tournaments')
    .select('id, name, slug, sport, format, venue_address, schedule_config')
    .eq('slug', props.slug)
    .maybeSingle()
  if (error || !data) { state.value = 'missing'; return }
  tournament.value = data
  const { data: rows } = await supabase
    .from('match_schedule')
    .select('scheduled_at, state')
    .eq('tournament_id', data.id)
    .eq('state', 'published')
    .not('scheduled_at', 'is', null)
  span.value = scheduleSpan(rows ?? [])
  state.value = 'ready'
}

watch(pageUrl, async url => {
  qrSrc.value = await QRCode.toDataURL(taggedUrl(url, 'poster', 'qr'), {
    errorCorrectionLevel: 'H',
    margin: 1,
    width: 1200,
    color: { dark: '#11251C', light: '#FFFFFF' },
  })
}, { immediate: true })

onMounted(() => {
  setRobotsMeta(false)
  load()
})
onBeforeUnmount(() => setRobotsMeta(true))

function print() {
  window.print()
}
</script>

<template>
  <div class="poster-page">
    <div class="poster-toolbar">
      <p class="poster-toolbar__hint">{{ t('poster.printHint') }}</p>
      <button class="btn btn--primary" type="button" :disabled="state !== 'ready'" @click="print">{{ t('poster.print') }}</button>
    </div>

    <p v-if="state === 'loading'" class="muted poster-status">{{ t('actions.loading') }}</p>
    <section v-else-if="state === 'missing'" class="card empty-state poster-status" role="alert">
      <p class="empty-state__title">{{ t('errors.notFound') }}</p>
      <p class="empty-state__hint">{{ t('errors.checkLink') }}</p>
    </section>

    <article v-else class="poster" :lang="locale">
      <header class="poster__brand"><BrandLogo :size="44" /><span>Bracketa</span></header>
      <div class="poster__body">
        <p class="poster__kicker">{{ t('poster.kicker') }}</p>
        <h1 class="poster__title">{{ tournament.name }}</h1>
        <ul class="poster__facts">
          <li v-for="fact in facts" :key="fact">{{ fact }}</li>
        </ul>
        <p v-if="tournament.venue_address" class="poster__venue">{{ tournament.venue_address }}</p>
      </div>
      <div class="poster__qr">
        <img :src="qrSrc" :alt="t('poster.qrAlt')" width="600" height="600" />
      </div>
      <p class="poster__scan">{{ t('poster.scan') }}</p>
      <p class="poster__note">{{ t('poster.noApp') }}</p>
      <footer class="poster__footer">
        <span class="poster__url">{{ printedUrl }}</span>
        <span>{{ t('poster.footer') }}</span>
      </footer>
    </article>
  </div>
</template>

<style scoped>
.poster-page {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-4);
  min-height: 100vh;
  background: var(--bg-elevated);
}

.poster-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  width: min(210mm, 100%);
}

.poster-toolbar__hint { margin: 0; color: var(--muted); font-size: 0.875rem; }
.poster-status { width: min(210mm, 100%); }

/* The sheet itself: fixed print colors regardless of the site theme. */
.poster {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 210mm;
  min-height: 297mm;
  padding: 16mm 16mm 12mm;
  background: #FFFFFF;
  color: #11251C;
  font-family: var(--font-body);
  box-shadow: var(--shadow-lg);
  /* Brand colors of the light theme, so the logo prints the same from a dark UI. */
  --primary: #0F7B4D;
  --lime: #C6F24E;
}

.poster h1,
.poster p,
.poster li,
.poster span { color: inherit; }

.poster__brand {
  display: flex;
  align-items: center;
  gap: 12px;
  font: 800 28px/1 var(--font-display);
  letter-spacing: -0.03em;
}

.poster__body { margin-top: 14mm; }

.poster__kicker {
  margin: 0;
  color: #0F7B4D !important;
  font: 700 22px/1.2 var(--font-display);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.poster__title {
  color: #11251C;
  margin: 4mm 0 0;
  font: 800 54px/1.05 var(--font-display);
  letter-spacing: -0.035em;
  overflow-wrap: anywhere;
}

.poster__facts {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 6mm 0 0;
  padding: 0;
  list-style: none;
}

.poster__facts li {
  padding: 6px 16px;
  border: 1.5px solid #11251C;
  border-radius: 999px;
  font-size: 20px;
  font-weight: 600;
}

.poster__venue { margin: 4mm 0 0; font-size: 20px; color: #3D4A43; }

.poster__qr {
  display: flex;
  justify-content: center;
  margin-top: auto;
  padding-top: 10mm;
}

.poster__qr img {
  width: 105mm;
  height: 105mm;
  padding: 5mm;
  border: 3px solid #11251C;
  border-radius: 8mm;
}

.poster__scan {
  color: #11251C;
  margin: 8mm 0 0;
  text-align: center;
  font: 800 34px/1.15 var(--font-display);
  letter-spacing: -0.02em;
}

.poster__note { margin: 3mm 0 0; text-align: center; font-size: 20px; color: #3D4A43; }

.poster__footer {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 8px;
  margin-top: 10mm;
  padding-top: 5mm;
  border-top: 1.5px solid #D8DCD6;
  font-size: 15px;
  color: #3D4A43;
}

.poster__url { font-family: var(--font-mono); font-weight: 600; color: #11251C; }

@media print {
  .poster-page { padding: 0; background: #FFFFFF; min-height: 0; }
  .poster-toolbar { display: none; }
  .poster { box-shadow: none; min-height: 296mm; }
}
</style>

<style>
@page { size: A4 portrait; margin: 0; }
@media print {
  html, body { background: #FFFFFF !important; }
}
</style>
