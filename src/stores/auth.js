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
    playerContextRequest: 0,
    tournamentRoles: [],        // 'owner'|'editor'|'counter' for all assigned tournaments
    tournamentRolesLoaded: false,
    tournamentRolesRequest: 0,
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
        this.playerContextRequest += 1
        this.currentPlayer = null
        this.playerContextLoaded = false
        this.platformRole = null
        this.tournamentRolesRequest += 1
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
      const request = ++this.playerContextRequest
      const { data: player, error } = await supabase
        .from('players')
        .select('*')
        .eq('user_id', userId)
        .maybeSingle()

      // A response from the previous account must not populate the new session.
      if (this.user?.id !== userId || request !== this.playerContextRequest) return
      if (error) throw error
      this.currentPlayer = player ?? null
      this.playerContextLoaded = true
    },

    async savePlayerProfile(displayName) {
      const normalizedName = String(displayName ?? '').trim().replace(/\s+/g, ' ')
      if (!this.user || !normalizedName) {
        throw new Error('A signed-in user and display name are required')
      }

      const userId = this.user.id
      // A profile load already in flight must not overwrite this newer edit.
      this.playerContextRequest += 1
      const updateProfile = () => supabase
        .from('players')
        .update({ display_name: normalizedName })
        .eq('user_id', userId)
        .select('*')
        .single()

      let result
      if (this.currentPlayer) {
        result = await updateProfile()
      } else {
        const metadata = this.user.user_metadata ?? {}
        result = await supabase
          .from('players')
          .insert({
            user_id: userId,
            display_name: normalizedName,
            avatar_url: metadata.avatar_url || metadata.picture || null,
          })
          .select('*')
          .single()

        // Another tab may have created the same user's profile first.
        if (result.error?.code === '23505') {
          result = await updateProfile()
        }
      }

      if (this.user?.id !== userId) {
        throw new Error('The authentication session changed while saving the profile')
      }
      if (result.error) throw result.error
      if (!result.data) throw new Error('The profile save returned no row')

      this.currentPlayer = result.data
      this.playerContextLoaded = true
      return result.data
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
      const userId = this.user.id
      const request = ++this.tournamentRolesRequest
      const { data, error } = await supabase.from('tournament_admins').select('role').eq('user_id', userId)
      if (this.user?.id !== userId || request !== this.tournamentRolesRequest) return
      if (error) throw error
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
