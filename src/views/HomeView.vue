<script setup>
import { useI18n } from 'vue-i18n'

import LanguageSwitcher from '../components/LanguageSwitcher.vue'
import { useAuthStore } from '../stores/auth'

const { t } = useI18n()
const auth = useAuthStore()

async function goRegister() {
  await auth.signInWithGoogle()
}

function scrollTo(id) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth' })
}
</script>

<template>
  <div class="landing">
    <!-- Navbar -->
    <nav class="landing-nav">
      <div class="landing-nav__inner">
        <span class="landing-nav__brand">
          <svg class="landing-nav__logo" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <path d="M18.5 5.5c-3 3-6 5-10 7" />
            <path d="M5.5 18.5c3-3 6-5 10-7" />
            <path d="M2 12h20" />
          </svg>
          {{ t('app.title') }}
        </span>
        <div class="landing-nav__actions">
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
        <span class="landing-hero__badge">{{ t('home.hero.badge') }}</span>
        <h1 class="landing-hero__title">
          {{ t('home.hero.title') }}<br>
          <span class="landing-hero__title-accent">{{ t('home.hero.titleAccent') }}</span>
        </h1>
        <p class="landing-hero__subtitle">{{ t('home.hero.subtitle') }}</p>
        <div class="landing-hero__actions">
          <button class="btn btn--primary btn--lg" @click="goRegister">
            {{ t('home.hero.cta') }}
          </button>
          <button class="btn btn--ghost btn--lg" @click="scrollTo('how-it-works')">
            {{ t('home.hero.ctaSecondary') }}
          </button>
        </div>
      </div>
      <div class="landing-hero__visual">
        <div class="landing-bracket-demo" aria-hidden="true">
          <div class="bracket-col">
            <div class="bracket-slot bracket-slot--active">
              <span class="bracket-name">A. Djokovic</span>
              <span class="bracket-score">6</span>
            </div>
            <div class="bracket-slot">
              <span class="bracket-name">R. Nadal</span>
              <span class="bracket-score">3</span>
            </div>
          </div>
          <div class="bracket-connector"></div>
          <div class="bracket-col">
            <div class="bracket-slot bracket-slot--active bracket-slot--final">
              <span class="bracket-name">A. Djokovic</span>
              <span class="bracket-score bracket-score--live">
                <span class="live-dot"></span>
                LIVE
              </span>
            </div>
            <div class="bracket-slot bracket-slot--final">
              <span class="bracket-name">C. Alcaraz</span>
              <span class="bracket-score">—</span>
            </div>
          </div>
          <div class="bracket-connector"></div>
          <div class="bracket-col">
            <div class="bracket-slot bracket-slot--active">
              <span class="bracket-name">C. Alcaraz</span>
              <span class="bracket-score">7</span>
            </div>
            <div class="bracket-slot">
              <span class="bracket-name">J. Sinner</span>
              <span class="bracket-score">5</span>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- Features -->
    <section class="landing-section" id="features">
      <div class="landing-section__header">
        <h2 class="landing-section__title">{{ t('home.features.title') }}</h2>
        <p class="landing-section__subtitle">{{ t('home.features.subtitle') }}</p>
      </div>
      <div class="landing-features">
        <div class="feature-card">
          <div class="feature-card__icon">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <path d="M3 9h18" />
              <path d="M9 3v18" />
            </svg>
          </div>
          <h3 class="feature-card__title">{{ t('home.features.bracket.title') }}</h3>
          <p class="feature-card__text">{{ t('home.features.bracket.description') }}</p>
        </div>

        <div class="feature-card">
          <div class="feature-card__icon feature-card__icon--accent">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
          </div>
          <h3 class="feature-card__title">{{ t('home.features.liveScore.title') }}</h3>
          <p class="feature-card__text">{{ t('home.features.liveScore.description') }}</p>
        </div>

        <div class="feature-card">
          <div class="feature-card__icon feature-card__icon--success">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </div>
          <h3 class="feature-card__title">{{ t('home.features.spectator.title') }}</h3>
          <p class="feature-card__text">{{ t('home.features.spectator.description') }}</p>
        </div>

        <div class="feature-card">
          <div class="feature-card__icon feature-card__icon--warning">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          </div>
          <h3 class="feature-card__title">{{ t('home.features.doubles.title') }}</h3>
          <p class="feature-card__text">{{ t('home.features.doubles.description') }}</p>
        </div>

        <div class="feature-card">
          <div class="feature-card__icon feature-card__icon--info">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <line x1="19" y1="8" x2="19" y2="14" />
              <line x1="22" y1="11" x2="16" y2="11" />
            </svg>
          </div>
          <h3 class="feature-card__title">{{ t('home.features.registration.title') }}</h3>
          <p class="feature-card__text">{{ t('home.features.registration.description') }}</p>
        </div>

        <div class="feature-card">
          <div class="feature-card__icon feature-card__icon--purple">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 2L2 7l10 5 10-5-10-5z" />
              <path d="M2 17l10 5 10-5" />
              <path d="M2 12l10 5 10-5" />
            </svg>
          </div>
          <h3 class="feature-card__title">{{ t('home.features.collaboration.title') }}</h3>
          <p class="feature-card__text">{{ t('home.features.collaboration.description') }}</p>
        </div>
      </div>
    </section>

    <!-- How It Works -->
    <section class="landing-section landing-section--alt" id="how-it-works">
      <div class="landing-section__header">
        <h2 class="landing-section__title">{{ t('home.howItWorks.title') }}</h2>
        <p class="landing-section__subtitle">{{ t('home.howItWorks.subtitle') }}</p>
      </div>
      <div class="landing-steps">
        <div class="step-card">
          <div class="step-card__number">1</div>
          <h3 class="step-card__title">{{ t('home.howItWorks.step1.title') }}</h3>
          <p class="step-card__text">{{ t('home.howItWorks.step1.description') }}</p>
        </div>
        <div class="step-divider" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
        </div>
        <div class="step-card">
          <div class="step-card__number">2</div>
          <h3 class="step-card__title">{{ t('home.howItWorks.step2.title') }}</h3>
          <p class="step-card__text">{{ t('home.howItWorks.step2.description') }}</p>
        </div>
        <div class="step-divider" aria-hidden="true">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M5 12h14" />
            <path d="M12 5l7 7-7 7" />
          </svg>
        </div>
        <div class="step-card">
          <div class="step-card__number">3</div>
          <h3 class="step-card__title">{{ t('home.howItWorks.step3.title') }}</h3>
          <p class="step-card__text">{{ t('home.howItWorks.step3.description') }}</p>
        </div>
      </div>
    </section>

    <!-- CTA -->
    <section class="landing-section landing-cta">
      <div class="landing-cta__inner">
        <h2 class="landing-cta__title">{{ t('home.cta.title') }}</h2>
        <p class="landing-cta__subtitle">{{ t('home.cta.subtitle') }}</p>

        <div class="portal-cards">
          <div class="portal-card">
            <div class="portal-card__icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
                <rect x="9" y="3" width="6" height="4" rx="1" />
                <path d="M9 12h6" />
                <path d="M9 16h6" />
              </svg>
            </div>
            <h2 class="portal-card__title">{{ t('home.admin.title') }}</h2>
            <p class="portal-card__text">{{ t('home.admin.description') }}</p>
            <button
              class="btn btn--primary portal-card__btn"
              type="button"
              @click="goRegister"
            >
              {{ t('home.admin.button') }}
            </button>
          </div>

          <div class="portal-card">
            <div class="portal-card__icon portal-card__icon--player">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="8" r="4" />
                <path d="M6 21v-2a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v2" />
              </svg>
            </div>
            <h2 class="portal-card__title">{{ t('home.player.title') }}</h2>
            <p class="portal-card__text">{{ t('home.player.description') }}</p>
            <button
              class="btn btn--outline portal-card__btn"
              type="button"
              @click="goRegister"
            >
              {{ t('home.player.button') }}
            </button>
          </div>
        </div>

      </div>
    </section>

    <!-- Footer -->
    <footer class="landing-footer">
      <span class="landing-footer__copy">&copy; {{ new Date().getFullYear() }} {{ t('app.title') }}</span>
    </footer>
  </div>
</template>
