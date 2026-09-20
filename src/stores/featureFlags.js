import { defineStore } from 'pinia'
import { supabase } from '../lib/supabase'
import { SPORTS, sportFlagKey } from '../lib/sportConfig'

let realtimeChannel = null

// Platform-wide feature flags (table `feature_flags`, super-admin managed).
// Unknown keys are treated as disabled, so every new sport must be switched on explicitly.
export const useFeatureFlagsStore = defineStore('featureFlags', {
  state: () => ({
    flags: {},          // { [key]: { key, enabled, description, updated_at } }
    loaded: false,
    loading: false,
    error: null,
  }),
  getters: {
    isEnabled: (state) => (key) => Boolean(state.flags[key]?.enabled),
    enabledSports(state) {
      return SPORTS.filter((s) => Boolean(state.flags[sportFlagKey(s)]?.enabled))
    },
  },
  actions: {
    applyRows(rows) {
      const next = {}
      for (const row of rows ?? []) next[row.key] = row
      this.flags = next
    },
    applyRow(row) {
      if (!row?.key) return
      this.flags = { ...this.flags, [row.key]: row }
    },
    removeRow(key) {
      if (!key || !(key in this.flags)) return
      const { [key]: _removed, ...rest } = this.flags
      this.flags = rest
    },

    async load({ force = false } = {}) {
      if (this.loaded && !force) return
      if (this.loading) return
      this.loading = true
      this.error = null
      try {
        const { data, error } = await supabase.from('feature_flags').select('*').order('key')
        if (error) throw error
        this.applyRows(data)
        this.loaded = true
        this.subscribe()
      } catch (err) {
        this.error = err
        throw err
      } finally {
        this.loading = false
      }
    },

    subscribe() {
      if (realtimeChannel) return
      realtimeChannel = supabase
        .channel('feature_flags')
        .on('postgres_changes', { event: '*', schema: 'public', table: 'feature_flags' }, (payload) => {
          if (payload.eventType === 'DELETE') this.removeRow(payload.old?.key)
          else this.applyRow(payload.new)
        })
        .subscribe()
    },

    // Super-admin only (enforced server-side by set_feature_flag()).
    async setFlag(key, enabled, description = null) {
      const { data, error } = await supabase.rpc('set_feature_flag', {
        p_key: key,
        p_enabled: Boolean(enabled),
        p_description: description,
      })
      if (error) throw error
      this.applyRow(data)
      return data
    },
  },
})
