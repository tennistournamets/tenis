import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { beforeUnload, confirmLeaveForms } from '../lib/unsavedChanges'
import i18n, { setAppLocale } from '../i18n'
import { authCallbackCleanupLocation, scrubAuthCallbackFromLocation } from '../lib/authCallbackUrl'
import { trackPageview } from '../lib/analytics'
import { LANDING_ROUTE_PATH, landingLocaleDecision, readStoredLocale, storeLocale } from '../lib/localeRoute'

const HomeView = () => import('../views/HomeView.vue')
const PublicTournamentView = () => import('../views/PublicTournamentView.vue')
const AdminLayout = () => import('../views/AdminLayout.vue')
const AdminTournamentListView = () => import('../views/AdminTournamentListView.vue')
const AdminTournamentCreateView = () => import('../views/AdminTournamentCreateView.vue')
const AdminTournamentView = () => import('../views/AdminTournamentView.vue')
const AdminSettingsView = () => import('../views/AdminSettingsView.vue')
const AdminPlatformView = () => import('../views/AdminPlatformView.vue')
const NotFoundView = () => import('../views/NotFoundView.vue')
const TournamentPosterView = () => import('../views/TournamentPosterView.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      // /, /en, /lt: one landing per language for search engines (hreflang).
      path: LANDING_ROUTE_PATH,
      name: 'home',
      component: HomeView,
      async beforeEnter() {
        const auth = useAuthStore()
        if (!auth.ready) {
          await auth.init()
        }
        if (auth.user) {
          return { name: 'admin-tournaments' }
        }
        return true
      },
    },
    {
      path: '/tournaments/:slug',
      name: 'public-tournament',
      component: PublicTournamentView,
      props: true,
    },
    {
      // A4 poster with the QR code, for printing.
      path: '/tournaments/:slug/poster',
      name: 'tournament-poster',
      component: TournamentPosterView,
      props: true,
    },
    {
      // Widget for club websites (public/embed.js puts it in an iframe).
      path: '/embed/:slug',
      name: 'embed-tournament',
      component: PublicTournamentView,
      props: route => ({ slug: route.params.slug, embed: true }),
    },
    {
      path: '/admin',
      component: AdminLayout,
      meta: { requiresAuth: true },
      redirect: { name: 'admin-tournaments' },
      children: [
        {
          path: 'tournaments',
          name: 'admin-tournaments',
          component: AdminTournamentListView,
        },
        {
          path: 'tournaments/new',
          name: 'admin-tournament-new',
          component: AdminTournamentCreateView,
        },
        {
          path: 'tournaments/:id',
          name: 'admin-tournament',
          component: AdminTournamentView,
          props: true,
        },
        {
          path: 'settings',
          name: 'admin-settings',
          component: AdminSettingsView,
        },
        {
          path: 'platform',
          name: 'admin-platform',
          component: AdminPlatformView,
          meta: { requiresPlatformAdmin: true },
        },
      ],
    },
    { path: '/:pathMatch(.*)*', name: 'not-found', component: NotFoundView },
  ],
})

window.addEventListener('beforeunload', beforeUnload)

router.beforeEach(async (to, from) => {
  if (to.path !== from.path && !(await confirmLeaveForms(i18n.global.t))) return false
  const auth = useAuthStore()

  if (!auth.ready) {
    await auth.init()
  }

  // supabase-js has read the OAuth callback by now (init awaits it). vue-router keeps the
  // landing hash through `redirect` records, so drop the tokens before the URL is committed.
  const cleaned = authCallbackCleanupLocation(to)
  if (cleaned) return cleaned

  if (to.name === 'home') {
    const decision = landingLocaleDecision(to, from, readStoredLocale())
    if (decision.redirect) return { path: decision.redirect, query: to.query, hash: to.hash, replace: true }
    await setAppLocale(decision.locale)
    storeLocale(decision.locale)
  }

  const requiresAuth = to.matched.some((record) => record.meta.requiresAuth)
  if (requiresAuth && !auth.user) {
    return { name: 'home' }
  }

  // Super-admin only pages (feature flags). Non-admins land on the tournament list.
  if (to.matched.some((record) => record.meta.requiresPlatformAdmin)) {
    if (auth.platformRole === null) {
      try { await auth.checkPlatformRole() } catch { /* treated as non-admin */ }
    }
    if (auth.platformRole !== 'superadmin') {
      return { name: 'admin-tournaments' }
    }
  }

  return true
})

// Covers navigations that end without committing a cleaned URL (aborted or failed).
router.afterEach((to, from, failure) => {
  scrubAuthCallbackFromLocation()
  // START_LOCATION has no matched records: the first page counts even when its path is '/'.
  if (!failure && (to.path !== from.path || !from.matched.length)) trackPageview(to)
})

export default router
