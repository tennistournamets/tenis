<script setup>
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import ThemeToggle from '../components/ThemeToggle.vue'
import { maxNetworkTier } from '../lib/rally3d/networkTier'
import { tilt } from '../lib/tilt'
import { useReveal } from '../lib/useReveal'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
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
  if (document.readyState === 'complete') scheduleScene3d()
  else window.addEventListener('load', scheduleScene3d, { once: true })
})
onBeforeUnmount(() => {
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
  { key: 'bracket', icon: 'bracket', tone: '' },
  { key: 'liveScore', icon: 'bolt', tone: 'feature-card__icon--accent' },
  { key: 'spectator', icon: 'eye', tone: 'feature-card__icon--success' },
  { key: 'doubles', icon: 'users', tone: 'feature-card__icon--warning' },
  { key: 'registration', icon: 'user-plus', tone: 'feature-card__icon--info' },
  { key: 'collaboration', icon: 'layers', tone: 'feature-card__icon--purple' },
]

async function goRegister() {
  await auth.signInWithGoogle()
}

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}
</script>

<template>
  <div
    ref="landingEl"
    class="landing"
    :class="{ 'landing--3d': scene3d && scene3dReady, 'landing--no3d': !scene3d }"
  >
    <LandingScene3D
      v-if="scene3d"
      :root="landingEl"
      @ready="scene3dReady = true"
      @unavailable="scene3d = false"
    />

    <!-- Navbar -->
    <nav class="landing-nav">
      <div class="landing-nav__inner">
        <span class="landing-nav__brand">
          <svg class="landing-nav__logo" width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect width="28" height="28" rx="8" fill="var(--primary)" />
            <path d="M11 8H9.5A1.5 1.5 0 0 0 8 9.5v9A1.5 1.5 0 0 0 9.5 20H11" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" />
            <path d="M17 8h1.5A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5H17" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none" />
            <circle cx="14" cy="14" r="2.2" fill="var(--lime)" />
          </svg>
          {{ t('app.title') }}
        </span>
        <div class="landing-nav__links">
          <a class="landing-nav__link" href="#how-it-works" @click.prevent="scrollTo('how-it-works')">{{ t('home.nav.howItWorks') }}</a>
          <a class="landing-nav__link" href="#features" @click.prevent="scrollTo('features')">{{ t('home.nav.features') }}</a>
          <a class="landing-nav__link" href="#sports" @click.prevent="scrollTo('sports')">{{ t('home.nav.sports') }}</a>
        </div>
        <div class="landing-nav__actions">
          <ThemeToggle />
          <LanguageSwitcher />
          <button class="btn btn--primary btn--sm" @click="goRegister">
            {{ t('home.admin.button') }}
          </button>
        </div>
      </div>
    </nav>

    <!-- Hero -->
    <section class="landing-hero">
      <div class="landing-hero__content">
        <span class="landing-hero__badge"><span class="landing-hero__badge-dot"></span>{{ t('home.hero.badge') }}</span>
        <h1 class="landing-hero__title">
          {{ t('home.hero.title') }}
          <span class="landing-hero__title-accent">{{ t('home.hero.titleAccent') }}</span>
        </h1>
        <p class="landing-hero__subtitle">{{ t('home.hero.subtitle') }}</p>
        <div class="landing-hero__actions">
          <button class="btn btn--primary btn--lg" @click="goRegister">
            {{ t('home.hero.cta') }}
          </button>
          <button class="btn btn--outline btn--lg" @click="scrollTo('how-it-works')">
            {{ t('home.hero.ctaSecondary') }}
          </button>
        </div>
        <p class="landing-hero__note">{{ t('home.hero.note') }}</p>
      </div>
      <div class="landing-hero__visual" data-stage="hero">
        <div v-tilt="7" class="demo-card" aria-hidden="true">
          <div class="demo-card__head">
            <span class="demo-card__title">Летний кубок · полуфиналы</span>
            <span class="demo-card__live"><span class="live-dot"></span>LIVE</span>
          </div>
          <div class="demo-card__body">
            <div class="demo-bracket">
              <div class="demo-pair">
                <div class="demo-slot demo-slot--win">
                  <span class="demo-slot__name">Петров</span>
                  <span class="demo-slot__score">6 · 6</span>
                </div>
                <div class="demo-slot">
                  <span class="demo-slot__name">Волкова</span>
                  <span class="demo-slot__score demo-slot__score--muted">3 · 4</span>
                </div>
              </div>
              <div class="demo-pair demo-pair--live">
                <div class="demo-slot">
                  <span class="demo-slot__name">Орлов</span>
                  <span class="demo-slot__score">7 · 2</span>
                </div>
                <div class="demo-slot">
                  <span class="demo-slot__name">Лебедева</span>
                  <span class="demo-slot__score">5 · 3</span>
                </div>
              </div>
            </div>
            <div class="demo-connector" aria-hidden="true"></div>
            <div class="demo-final">
              <div class="demo-slot demo-slot--win">
                <span class="demo-slot__name">Петров</span>
              </div>
              <div class="demo-slot demo-slot--empty">
                <span class="demo-slot__name">Ждём финалиста</span>
              </div>
              <span class="demo-final__meta">Финал · сб 16:00</span>
            </div>
          </div>
          <div class="demo-card__bar">
            <span class="demo-card__match"><span class="live-dot"></span>Орлов — Лебедева</span>
            <span class="demo-card__points">40 <span>—</span> 30</span>
          </div>
        </div>
      </div>
    </section>

    <!-- Sports -->
    <section class="landing-section landing-sports" id="sports">
      <div class="landing-section__header reveal">
        <p class="landing-eyebrow">{{ t('home.sports.eyebrow') }}</p>
        <h2 class="landing-section__title">{{ t('home.sports.title') }}</h2>
        <p class="landing-section__subtitle">{{ t('home.sports.subtitle') }}</p>
      </div>
      <div class="sport-tiles">
        <article
          v-for="(sport, i) in sports"
          :key="sport"
          class="sport-tile reveal"
          :style="{ '--i': i }"
        >
          <div class="sport-tile__stage" :data-stage="`sport-${sport}`" aria-hidden="true"></div>
          <p class="sport-tile__tagline">{{ t(`sportTagline.${sport}`) }}</p>
          <h3 class="sport-tile__title">{{ t(`sport.${sport}`) }}</h3>
          <p class="sport-tile__text">{{ t(`home.sports.${sport}`) }}</p>
        </article>
      </div>
    </section>

    <!-- Features -->
    <section class="landing-section landing-section--alt" id="features">
      <div class="landing-section__header reveal">
        <p class="landing-eyebrow">{{ t('home.features.eyebrow') }}</p>
        <h2 class="landing-section__title">{{ t('home.features.title') }}</h2>
        <p class="landing-section__subtitle">{{ t('home.features.subtitle') }}</p>
      </div>
      <div class="landing-features">
        <div v-for="(feature, i) in features" :key="feature.key" class="reveal" :style="{ '--i': i }">
          <div v-tilt="5" class="feature-card">
            <div class="feature-card__icon" :class="feature.tone">
              <svg v-if="feature.icon === 'bracket'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="3" y="3" width="18" height="18" rx="2" />
                <path d="M3 9h18" />
                <path d="M9 3v18" />
              </svg>
              <svg v-else-if="feature.icon === 'bolt'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
              </svg>
              <svg v-else-if="feature.icon === 'eye'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
              <svg v-else-if="feature.icon === 'users'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
                <path d="M16 3.13a4 4 0 0 1 0 7.75" />
              </svg>
              <svg v-else-if="feature.icon === 'user-plus'" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                <circle cx="9" cy="7" r="4" />
                <line x1="19" y1="8" x2="19" y2="14" />
                <line x1="22" y1="11" x2="16" y2="11" />
              </svg>
              <svg v-else width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M12 2L2 7l10 5 10-5-10-5z" />
                <path d="M2 17l10 5 10-5" />
                <path d="M2 12l10 5 10-5" />
              </svg>
            </div>
            <h3 class="feature-card__title">{{ t(`home.features.${feature.key}.title`) }}</h3>
            <p class="feature-card__text">{{ t(`home.features.${feature.key}.description`) }}</p>
          </div>
        </div>
      </div>
    </section>

    <!-- How It Works: steps scroll, the 3D stage sticks -->
    <section class="landing-section landing-how" id="how-it-works">
      <div class="landing-section__header reveal">
        <p class="landing-eyebrow">{{ t('home.howItWorks.eyebrow') }}</p>
        <h2 class="landing-section__title">{{ t('home.howItWorks.title') }}</h2>
        <p class="landing-section__subtitle">{{ t('home.howItWorks.subtitle') }}</p>
      </div>
      <div class="how">
        <div class="how__steps">
          <article
            v-for="(step, i) in steps"
            :key="step"
            class="how-step reveal"
            :data-step-block="i + 1"
          >
            <div class="how-step__stage" :data-stage="`step-${i + 1}`" aria-hidden="true"></div>
            <span class="how-step__number">0{{ i + 1 }}</span>
            <h3 class="how-step__title">{{ t(`home.howItWorks.${step}.title`) }}</h3>
            <p class="how-step__text">{{ t(`home.howItWorks.${step}.description`) }}</p>
          </article>
        </div>
        <div class="how__stage-col">
          <div class="how__stage" data-stage="steps" aria-hidden="true"></div>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="landing-section landing-cta">
      <div class="landing-cta__inner reveal">
        <h2 class="landing-cta__title">{{ t('home.cta.title') }}</h2>
        <p class="landing-cta__subtitle">{{ t('home.cta.subtitle') }}</p>

        <button class="btn btn--primary btn--lg landing-cta__btn" type="button" @click="goRegister">
          {{ t('home.cta.button') }}
        </button>
        <p class="landing-hero__note">{{ t('home.hero.note') }}</p>
      </div>
    </section>

    <!-- Footer -->
    <footer class="landing-footer">
      <span class="landing-footer__copy">&copy; {{ new Date().getFullYear() }} {{ t('app.title') }}</span>
    </footer>
  </div>
</template>
