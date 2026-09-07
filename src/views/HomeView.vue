<script setup>
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import '../components/landing/cinematic.css'

import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import ThemeToggle from '../components/ThemeToggle.vue'
import { maxNetworkTier } from '../lib/rally3d/networkTier'
import { tilt } from '../lib/tilt'
import { useReveal } from '../lib/useReveal'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const activeStep = ref(1)
const motionPaused = ref(false)
const signingIn = ref(false)
const signInError = ref('')
let scrollFrame = 0
let stopScroll = () => {}
const auth = useAuthStore()

const vTilt = tilt
const landingEl = ref(null)
useReveal(landingEl)

// 3D layer: skipped on save-data / 2g networks, via ?no3d or localStorage
// champ_landing3d=off, and disabled if WebGL init fails or the context is lost.
function landing3dAllowed() {
  if (maxNetworkTier() === '2d') return false
  try {
    if (new URLSearchParams(window.location.search).has('no3d')) return false
    if (localStorage.getItem('champ_landing3d') === 'off') return false
  } catch {
    /* ignore */
  }
  return true
}
// The three.js chunk is requested only after window load + an idle slot, so
// it never competes with the text LCP.
const scene3d = ref(false)
const scene3dReady = ref(false)
let idleHandle = 0
let idleIsTimeout = false
function scheduleScene3d() {
  if (!landing3dAllowed()) return
  const go = () => {
    scene3d.value = true
  }
  if ('requestIdleCallback' in window) {
    idleHandle = window.requestIdleCallback(go, { timeout: 1500 })
  } else {
    idleIsTimeout = true
    idleHandle = window.setTimeout(go, 200)
  }
}
onMounted(() => {
  const measure = () => {
    scrollFrame = 0
    const root = landingEl.value
    if (!root) return
    const max = document.documentElement.scrollHeight - innerHeight
    root.style.setProperty('--page-progress', String(max > 0 ? scrollY / max : 0))
    const blocks = [...root.querySelectorAll('[data-step-block]')]
    let nearest = Infinity
    blocks.forEach((block, i) => {
      const rect = block.getBoundingClientRect()
      const distance = Math.abs(rect.top + rect.height * 0.5 - innerHeight * 0.5)
      if (distance < nearest) { nearest = distance; activeStep.value = i + 1 }
    })
  }
  const onScroll = () => { if (!scrollFrame) scrollFrame = requestAnimationFrame(measure) }
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onScroll)
  stopScroll = () => {
    window.removeEventListener('scroll', onScroll)
    window.removeEventListener('resize', onScroll)
    cancelAnimationFrame(scrollFrame)
  }
  measure()
  if (document.readyState === 'complete') scheduleScene3d()
  else window.addEventListener('load', scheduleScene3d, { once: true })
})
onBeforeUnmount(() => {
  stopScroll()
  window.removeEventListener('load', scheduleScene3d)
  if (idleHandle) {
    if (idleIsTimeout) clearTimeout(idleHandle)
    else if ('cancelIdleCallback' in window) window.cancelIdleCallback(idleHandle)
  }
})
const LandingScene3D = defineAsyncComponent({
  loader: () => import('../components/landing/LandingScene3D.vue'),
  onError(error, retry, fail) {
    console.warn('landing3d chunk failed:', error)
    scene3d.value = false
    fail()
  },
})

const sports = ['tennis', 'padel', 'football']
const steps = ['step1', 'step2', 'step3']

const features = [
  { key: 'bracket', path: 'M3 4h6v4H3z M3 16h6v4H3z M15 10h6v4h-6z M9 6h3v12H9 M12 12h3' },
  { key: 'liveScore', path: 'M13 2 4 14h7l-1 8 10-13h-7l1-7' },
  { key: 'spectator', path: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0' },
  { key: 'doubles', path: 'M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M12 7a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0 M16 4a3.5 3.5 0 0 1 0 7 M18 15a4 4 0 0 1 4 4v2' },
  { key: 'registration', path: 'M14 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-9 M17 2v6 M14 5h6 M7 11h5 M7 15h9' },
  { key: 'collaboration', path: 'm12 3 10 5-10 5L2 8l10-5z M2 12l10 5 10-5 M2 16l10 5 10-5' },
]

async function goRegister() {
  if (signingIn.value) return
  signingIn.value = true
  signInError.value = ''
  try { await auth.signInWithGoogle() }
  catch { signInError.value = t('home.cinematic.signInError') }
  finally { signingIn.value = false }
}

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })
}
</script>

<template>
  <div ref="landingEl" class="landing landing--cinematic" :class="{ 'landing--3d': scene3d && scene3dReady, 'landing--no3d': !(scene3d && scene3dReady), 'landing--paused': motionPaused }">
    <LandingScene3D v-if="scene3d" :root="landingEl" :paused="motionPaused" @ready="scene3dReady = true" @unavailable="scene3d = false; scene3dReady = false" />
    <nav class="landing-nav" aria-label="Bracketa">
      <div class="landing-nav__inner">
        <a class="landing-nav__brand" href="#" @click.prevent="scrollTo('top')" aria-label="Bracketa">
          <svg class="landing-nav__logo" width="32" height="32" viewBox="0 0 28 28" fill="none" aria-hidden="true">
            <rect width="28" height="28" rx="8" fill="var(--lime)" />
            <path d="M11 8H8v12h3M17 8h3v12h-3" stroke="#11251c" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
            <circle cx="14" cy="14" r="2.2" fill="#11251c" />
          </svg>
          {{ t('app.title') }}<span class="brand-period">.</span>
        </a>
        <div class="landing-nav__links">
          <a href="#how-it-works" @click.prevent="scrollTo('how-it-works')">{{ t('home.nav.howItWorks') }}</a>
          <a href="#sports" @click.prevent="scrollTo('sports')">{{ t('home.nav.sports') }}</a>
          <a href="#features" @click.prevent="scrollTo('features')">{{ t('home.nav.features') }}</a>
        </div>
        <div class="landing-nav__actions">
          <ThemeToggle />
          <LanguageSwitcher />
          <button class="cinema-login" :disabled="signingIn" @click="goRegister">{{ t('home.cinematic.login') }} <span aria-hidden="true">↗</span></button>
        </div>
      </div>
      <div class="reading-progress" aria-hidden="true"></div>
    </nav>

    <section id="top" class="landing-hero">
      <div class="hero-watermark" aria-hidden="true">PLAY</div>
      <div class="landing-hero__content">
        <p class="cinema-kicker"><span class="status-dot"></span>{{ t('home.cinematic.badge') }}</p>
        <h1 class="landing-hero__title">{{ t('home.cinematic.title') }}<span class="landing-hero__title-accent">{{ t('home.cinematic.titleAccent') }}</span></h1>
        <p class="landing-hero__subtitle">{{ t('home.cinematic.subtitle') }}</p>
        <div class="landing-hero__actions">
          <button class="cinema-button" :disabled="signingIn" @click="goRegister">{{ t('home.cinematic.cta') }}<span aria-hidden="true">↗</span></button>
          <a class="cinema-link" href="#how-it-works" @click.prevent="scrollTo('how-it-works')"><span class="play-icon" aria-hidden="true">▷</span>{{ t('home.cinematic.explore') }}</a>
        </div>
        <p class="landing-hero__note">{{ t('home.cinematic.note') }}</p>
        <p v-if="signInError" class="cinema-error" role="alert">{{ signInError }}</p>
      </div>
      <div class="landing-hero__visual" data-stage="hero">
        <span class="hero-coordinate" aria-hidden="true">BRK / 001 — MATCH POINT</span>
        <div v-tilt="5" class="match-ticket">
          <div class="match-ticket__top"><span>{{ t('home.cinematic.liveTitle') }}</span><span class="match-ticket__live"><i></i> LIVE <small>· {{ t('home.cinematic.demo') }}</small></span></div>
          <p class="match-ticket__meta">{{ t('home.cinematic.semifinal') }} <span>·</span> {{ t('home.cinematic.court') }}</p>
          <div class="ticket-player"><span class="ticket-avatar">AN</span><span>A. Novak</span><span class="ticket-sets">6 &nbsp; 4</span><strong>40</strong></div>
          <div class="ticket-player"><span class="ticket-avatar ticket-avatar--second">MS</span><span>M. Silva</span><span class="ticket-sets">3 &nbsp; 6</span><strong>30</strong></div>
          <div class="match-ticket__bottom"><span class="status-dot"></span>{{ t('home.cinematic.point') }}<span aria-hidden="true">↗</span></div>
        </div>
        <button v-if="scene3d && scene3dReady" class="motion-control" :aria-label="t(motionPaused ? 'home.cinematic.play' : 'home.cinematic.pause')" :aria-pressed="motionPaused" @click="motionPaused = !motionPaused"><span aria-hidden="true">{{ motionPaused ? '▷' : 'Ⅱ' }}</span></button>
      </div>
      <div class="hero-bottom"><a href="#how-it-works" @click.prevent="scrollTo('how-it-works')"><span class="scroll-arrow" aria-hidden="true">↓</span>{{ t('home.cinematic.scroll') }}</a><span class="hero-sports">TENNIS <i>/</i> PADEL <i>/</i> FOOTBALL</span></div>
    </section>

    <div class="cinema-manifesto"><span>{{ t('home.cinematic.strip1') }}</span><span>{{ t('home.cinematic.strip2') }} <i aria-hidden="true">↘</i></span></div>

    <section id="how-it-works" class="landing-section landing-how">
      <div class="cinema-section-head reveal"><p class="landing-eyebrow">01 / {{ t('home.cinematic.storyEyebrow') }}</p><h2>{{ t('home.cinematic.storyTitle') }}</h2><p class="cinema-section-copy">{{ t('home.cinematic.storyText') }}</p></div>
      <div class="how">
        <div class="how__steps">
          <article v-for="(step, i) in steps" :id="`chapter-${i + 1}`" :key="step" class="how-step" :class="{ 'how-step--active': activeStep === i + 1 }" :data-step-block="i + 1">
            <div class="how-step__stage" :data-stage="`step-${i + 1}`" aria-hidden="true"></div>
            <div class="how-step__copy reveal"><span class="how-step__number">0{{ i + 1 }}<span>/ 03</span></span><h3 class="how-step__title">{{ t(`home.cinematic.step${i + 1}Title`) }}</h3><p class="how-step__text">{{ t(`home.cinematic.step${i + 1}Text`) }}</p><span class="step-tag"><span aria-hidden="true">✓</span>{{ t(`home.cinematic.tag${i + 1}`) }}</span></div>
          </article>
        </div>
        <div class="how__stage-col">
          <div class="stage-caption"><span class="status-dot"></span><span>{{ t(`home.cinematic.stage${activeStep}`) }}</span><span class="stage-caption__demo">{{ t('home.cinematic.demo') }}</span></div>
          <div class="how__stage" data-stage="steps" aria-hidden="true"></div>
          <div class="chapter-nav"><button v-for="i in 3" :key="i" :class="{ 'is-active': activeStep === i }" :aria-label="t(`home.cinematic.stage${i}`)" :aria-current="activeStep === i ? 'step' : undefined" @click="scrollTo(`chapter-${i}`)"><span>0{{ i }}</span><i></i></button></div>
        </div>
      </div>
    </section>

    <section id="sports" class="landing-section landing-sports">
      <div class="cinema-section-head cinema-section-head--split reveal"><div><p class="landing-eyebrow">02 / {{ t('home.cinematic.sportEyebrow') }}</p><h2>{{ t('home.cinematic.sportTitle') }}</h2></div><p class="cinema-section-copy">{{ t('home.cinematic.sportText') }}</p></div>
      <div class="sport-tiles">
        <article v-for="(sport, i) in sports" :key="sport" class="sport-tile">
          <div class="sport-tile__top"><span>0{{ i + 1 }}</span><span>{{ sport.toUpperCase() }}</span><span aria-hidden="true">↗</span></div>
          <div class="sport-tile__stage" :data-stage="`sport-${sport}`" aria-hidden="true"></div>
          <div class="sport-tile__copy reveal"><p class="sport-tile__tagline">{{ t(`sportTagline.${sport}`) }}</p><h3 class="sport-tile__title">{{ t(`sport.${sport}`) }}</h3><p class="sport-tile__text">{{ t(`home.sports.${sport}`) }}</p></div>
        </article>
      </div>
    </section>

    <section id="features" class="landing-section cinema-features-section">
      <div class="cinema-section-head reveal"><p class="landing-eyebrow">03 / {{ t('home.cinematic.featureEyebrow') }}</p><h2>{{ t('home.cinematic.featureTitle') }}</h2><p class="cinema-section-copy">{{ t('home.cinematic.featureText') }}</p></div>
      <div class="landing-features">
        <article v-for="(feature, i) in features" :key="feature.key" class="feature-card reveal" :style="{ '--i': i % 3 }">
          <div class="feature-card__top"><svg class="feature-card__glyph" width="29" height="29" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="feature.path" /></svg><span>0{{ i + 1 }}</span></div>
          <h3 class="feature-card__title">{{ t(`home.features.${feature.key}.title`) }}</h3><p class="feature-card__text">{{ t(`home.features.${feature.key}.description`) }}</p>
        </article>
      </div>
    </section>

    <section class="landing-section landing-cta">
      <div class="cta-stage" data-stage="trophy" aria-hidden="true"></div>
      <div class="landing-cta__inner reveal"><p class="landing-eyebrow">{{ t('home.cinematic.closingEyebrow') }}</p><h2 class="landing-cta__title">{{ t('home.cinematic.closingTitle') }}</h2><p class="landing-cta__subtitle">{{ t('home.cinematic.closingText') }}</p><button class="cinema-button" :disabled="signingIn" @click="goRegister">{{ t('home.cinematic.cta') }}<span aria-hidden="true">↗</span></button><p class="landing-hero__note">{{ t('home.cinematic.note') }}</p><p v-if="signInError" class="cinema-error" role="alert">{{ signInError }}</p></div>
    </section>
    <footer class="landing-footer"><a class="footer-brand" href="#top" @click.prevent="scrollTo('top')">Bracketa<span>.</span></a><span>{{ t('home.cinematic.footer') }}</span><span class="landing-footer__copy">&copy; {{ new Date().getFullYear() }} Bracketa</span></footer>
  </div>
</template>
