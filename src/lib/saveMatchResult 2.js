import { supabase } from './supabase'
import { confirmDialog } from './confirmDialog'

// All score editors use the same correction flow. The original payload and
// revision stay frozen while the organiser reviews the consequences.
export async function saveMatchResult(rpcName, payload, t) {
  const frozen = JSON.parse(JSON.stringify(payload))
  const first = await supabase.rpc(rpcName, frozen)
  if (!first.error?.message?.includes('scoringFlow.downstreamStarted')) return first
  const result = rpcName === 'update_match_sets' ? { sets: frozen.p_sets } : {
    a_goals: frozen.p_a_goals, b_goals: frozen.p_b_goals,
    a_pens: frozen.p_a_pens, b_pens: frozen.p_b_pens,
  }
  const args = { p_match_id: frozen.p_match_id, p_result: result, p_expected_revision: frozen.p_expected_revision }
  const { data: preview, error } = await supabase.rpc('get_match_correction_preview', args)
  if (error) return { error }
  const confirmed = await confirmDialog(t('scoringFlow.correctionTitle'), {
    danger: true,
    confirmLabel: t('scoringFlow.correctionApply'),
    disabled: preview.blocked_live,
    details: {
      intro: t(preview.reseed_playoff ? 'scoringFlow.correctionGroups' : 'scoringFlow.correctionIntro'),
      warning: preview.blocked_live ? t('scoringFlow.correctionLive') : t('scoringFlow.correctionWarning'),
      items: preview.matches.map(m => ({
        id: m.id,
        title: `${t(`scoringFlow.stage_${m.stage}`)} · ${t('bracket.roundN', { n: m.round_number > 1000 ? m.round_number % 1000 : m.round_number })} · №${m.match_number}`,
        teams: `${m.side_a_name || t('bracket.tbd')} — ${m.side_b_name || t('bracket.tbd')}`,
        effect: t(m.live_status === 'active' ? 'scoringFlow.correctionActive' : m.has_result ? 'scoringFlow.correctionReset' : 'scoringFlow.correctionEntrants'),
      })),
    },
  })
  if (!confirmed) return { cancelled: true }
  return supabase.rpc('apply_match_correction', { ...args, p_confirmation_token: preview.token })
}
