// AI switches (feature_flags, super-admin managed in /admin/platform): `ai` turns every AI
// feature on or off, `ai.<feature>` each one. A feature is on only while both are on; the
// database checks the same in is_ai_feature_enabled(). No row = off.
import { useFeatureFlagsStore } from '../stores/featureFlags'

export const AI_FLAG = 'ai'
export const AI_FEATURES = ['import', 'create', 'score', 'posts']

export const aiFlagKey = (feature) => `${AI_FLAG}.${feature}`

/** `flags` is the featureFlags store (or anything with isEnabled(key)). */
export function isAiFeatureOn(flags, feature) {
  return AI_FEATURES.includes(feature) && flags.isEnabled(AI_FLAG) && flags.isEnabled(aiFlagKey(feature))
}

/** Reactive "is this AI feature on?"; call in setup (loads the flags once). */
export function useAiFeature(feature) {
  const flags = useFeatureFlagsStore()
  flags.load().catch(() => {})
  return () => isAiFeatureOn(flags, feature)
}
