import { createRouter, createWebHistory } from 'vue-router'
import { useAuthStore } from '../stores/auth'
import { beforeUnload, confirmLeaveForms } from '../lib/unsavedChanges'
import i18n from '../i18n'
import { authCallbackCleanupLocation, scrubAuthCallbackFromLocation } from '../lib/authCallbackUrl'

const HomeView = () => import('../views/HomeView.vue')
const PublicTournamentView = () => import('../views/PublicTournamentView.vue')
const AdminLayout = () => import('../views/AdminLayout.vue')
const AdminTournamentListView = () => import('../views/AdminTournamentListView.vue')
const AdminTournamentCreateView = () => import('../views/AdminTournamentCreateView.vue')
const AdminTournamentView = () => import('../views/AdminTournamentView.vue')
const AdminSettingsView = () => import('../views/AdminSettingsView.vue')
const AdminPlatformView = () => import('../views/AdminPlatformView.vue')

const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
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
router.afterEach(() => { scrubAuthCallbackFromLocation() })

export default router
