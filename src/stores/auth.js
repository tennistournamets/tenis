import { defineStore } from 'pinia'
import { supabase } from '../lib/supabase'

let authSubscription = null

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    session: null,
    ready: false,
    platformRole: null,
    currentPlayer: null,       // { id, display_name, avatar_url, ... }
    playerContextLoaded: false,
    tournamentRoles: [],        // 'owner'|'editor'|'counter' for all assigned tournaments
    tournamentRolesLoaded: false,
  }),
  getters: {
    isCounterOnly(state) {
      if (!state.tournamentRolesLoaded) return false
      if (state.tournamentRoles.length === 0) return false
      return state.tournamentRoles.every((role) => role === 'counter')
    },
  },
  actions: {
    applySession(session) {
      const previousUserId = this.user?.id
      this.session = session
      this.user = session?.user ?? null
      if (previousUserId !== this.user?.id || !session) {
        this.currentPlayer = null
        this.playerContextLoaded = false
        this.platformRole = null
        this.tournamentRoles = []
        this.tournamentRolesLoaded = false
      }
    },
    async init() {
      if (this.ready) {
        return
      }

      const { data, error } = await supabase.auth.getSession()
      if (error) {
        throw error
      }

      this.applySession(data.session)
      this.ready = true

      if (!authSubscription) {
        const { data: subscriptionData } = supabase.auth.onAuthStateChange((_event, session) => {
          this.applySession(session)
          this.ready = true
        })
        authSubscription = subscriptionData.subscription
      }
    },

    async loadPlayerContext({ force = false } = {}) {
      if (!this.user) {
        this.currentPlayer = null
        this.playerContextLoaded = true
        return
      }
      if (this.playerContextLoaded && !force) return

      const userId = this.user.id
      const { data: player, error } = await supabase
        .from('players')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      // A response from the previous account must not populate the new session.
      if (this.user?.id !== userId) return
      if (error) throw error
      this.currentPlayer = player ?? null
      this.playerContextLoaded = true
    },

    async signInWithGoogle() {
      const redirectTo = `${window.location.origin}/admin`
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo },
      })

      if (error) {
        throw error
      }
    },

    async signUpWithEmail(email, password) {
      const { data, error } = await supabase.auth.signUp({ email, password })
      if (error) throw error
      this.applySession(data.session)
      return data
    },

    async loadTournamentRoles({ force = false } = {}) {
      if (!this.user) { this.tournamentRoles = []; this.tournamentRolesLoaded = true; return }
      if (this.tournamentRolesLoaded && !force) return
      const { data } = await supabase.from('tournament_admins').select('role').eq('user_id', this.user.id)
      this.tournamentRoles = (data ?? []).map((r) => r.role)
      this.tournamentRolesLoaded = true
    },

    async checkPlatformRole() {
      if (!this.user) {
        this.platformRole = null
        return
      }
      const { data } = await supabase
        .from('platform_admins')
        .select('id')
        .eq('user_id', this.user.id)
        .maybeSingle()
      this.platformRole = data ? 'superadmin' : null
    },

    async signOut() {
      const { error } = await supabase.auth.signOut()
      if (error) {
        throw error
      }
      this.applySession(null)
    },
  },
})
