// Creating a tournament from a create form: the manual wizard and the "Quick with AI" screen
// share the form shape, the create_tournament payload and the follow-up writes (registration
// rules, participants from a list, courts).
import { getSportConfig, isPointsFormat, isIndividualFormat, resolveCategory } from './sportConfig.js'
import { hasRegistrationRules, pickRegistrationDraft, registrationDraftFields, registrationPatch } from './registrationRules.js'
import { DEFAULT_TENNIS_RULES } from './tennisRules.js'
import { importRow } from './aiSchemas.js'

/** A new, empty create form (the wizard's initial state). */
export function defaultCreateForm() {
  return {
    name: '',
    slug: '',
    description: '',
    sport: 'tennis',
    format: 'single_elimination',
    category: 'singles',
    set_format: 'best_of_3',
    tiebreak_to: 7,
    scoring_config: { tennis: { ...DEFAULT_TENNIS_RULES } },
    gender: 'men',
    contact_phone: '',
    contact_email: '',
    venue_address: '',
    venue_lat: null,
    venue_lng: null,
    is_public: true,
    visibility: 'link',
    generate_qr: false,
    doubles_pairing_random: false,
    // Groups + playoff: how many leave each group; checked against the group sizes when groups are drawn.
    advance_per_group: 2,
    // Padel points formats: the two scores of a match add up to this total.
    points_per_match: 24,
    ...registrationDraftFields({}),
  }
}

/** Effective values the payload is built from (forced categories, pairing, valid gender). */
export function createChoices(form) {
  const cfg = getSportConfig(form.sport)
  const category = resolveCategory(form.sport, form.category)
  const points = isPointsFormat(form.format)
  const individual = isIndividualFormat(form.format)
  const pairingMode = individual || form.doubles_pairing_random ? 'pick_random' : 'pre_agreed'
  // Mixed (man + woman) needs fixed pairs: individual formats rotate partners every round.
  const gender = form.gender === 'mixed' && !(category === 'doubles' && !individual) ? 'men' : form.gender
  return { cfg, category, points, individual, pairingMode, gender }
}

/** Arguments of create_tournament for a form and its address (slug). */
export function createPayload(form, slug) {
  const { cfg, category, points, pairingMode, gender } = createChoices(form)
  return {
    p_name: form.name,
    p_slug: slug,
    p_description: form.description || null,
    p_sport: form.sport,
    p_format: form.format,
    p_category: category,
    p_set_format: cfg.supportsSetFormat && !points ? form.set_format : null,
    p_is_public: form.visibility !== 'private',
    p_doubles_pairing_mode: category === 'doubles' && cfg.supportsDoublesPairing ? pairingMode : null,
    p_format_config: form.format === 'groups_playoff' ? { advance_per_group: Number(form.advance_per_group) || 2 } : {},
    p_scoring_config: points
      ? { points_per_match: Number(form.points_per_match), gender }
      : form.sport === 'tennis'
      ? { ...form.scoring_config, gender }
      : cfg.supportsSetFormat ? { tiebreak_to: Number(form.tiebreak_to), gender } : { gender },
    p_contact_phone: String(form.contact_phone ?? '').trim() || null,
    p_contact_email: String(form.contact_email ?? '').trim() || null,
    p_venue_address: String(form.venue_address ?? '').trim() || null,
    p_venue_lat: form.venue_lat ?? null,
    p_venue_lng: form.venue_lng ?? null,
  }
}

/**
 * Creates the tournament, then its registration rules, participants (pending, emails only on
 * request) and courts. Throws the create_tournament error (code 23505: address taken); the
 * follow-up writes report failures instead of throwing, the tournament exists by then.
 * Returns { id, rulesFailed, participantsFailed, courtsFailed }.
 */
export async function createTournamentFromForm(supabase, form, { slug, participants = [], notify = false, courtNames = [] } = {}) {
  const { category } = createChoices(form)
  const { data: id, error } = await supabase.rpc('create_tournament', createPayload(form, slug))
  if (error) throw error
  if (!id) throw new Error('Missing tournament ID')

  // Conditions are a settings patch on the fresh row (revision 0).
  const regForm = pickRegistrationDraft(form)
  const patch = {
    ...(hasRegistrationRules(regForm) ? registrationPatch(regForm, { sport: form.sport, category }) : {}),
    ...(form.visibility === 'public' ? { visibility: 'public' } : {}),
  }
  let rulesFailed = false
  if (Object.keys(patch).length) {
    const { error: rulesError } = await supabase.rpc('update_tournament_settings', { p_tournament_id: id, p_patch: patch, p_expected_revision: 0 })
    rulesFailed = Boolean(rulesError)
  }

  let participantsFailed = 0
  if (participants.length) {
    const { data: added, error: addError } = await supabase.rpc('add_manual_entries', {
      p_tournament_id: id,
      p_entries: participants.map(importRow),
      p_status: 'pending',
      p_notify: notify,
    })
    participantsFailed = addError ? participants.length : (Array.isArray(added) ? added.filter(row => !row.ok).length : 0)
  }

  let courtsFailed = false
  if (courtNames.length) {
    const { data: row } = await supabase.from('tournaments').select('settings_revision').eq('id', id).maybeSingle()
    const { error: courtsError } = await supabase.rpc('save_courts', {
      p_tournament_id: id,
      p_courts: courtNames.map(name => ({ name })),
      p_expected_revision: row?.settings_revision ?? 0,
    })
    courtsFailed = Boolean(courtsError)
  }
  return { id, rulesFailed, participantsFailed, courtsFailed }
}
