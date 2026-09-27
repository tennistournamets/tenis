// Sponsorship is a paid feature: the owner asks, a platform admin approves.
// Until payments exist, this is the whole gate (table sponsorship_requests + RPCs).
import { reactive } from 'vue'
import { supabase } from './supabase'
import { errorKey } from './errorMessages'
import { useFeatureFlagsStore } from '../stores/featureFlags'

// Platform switch for the whole feature (feature_flags, super-admin managed).
// No row = off: sponsorship stays hidden until it is switched on in /admin/platform.
export const SPONSORSHIP_FLAG = 'feature.sponsorship'

/** Reactive "is the feature on?"; call in setup (loads the flags once). */
export function useSponsorshipFeature() {
  const flags = useFeatureFlagsStore()
  flags.load().catch(() => {})
  return () => flags.isEnabled(SPONSORSHIP_FLAG)
}

// tournament id -> approved?; filled lazily for public pages and the poster.
const approvals = reactive({})
const inFlight = new Set()

async function loadApproval(tournamentId) {
  inFlight.add(tournamentId)
  try {
    const { data, error } = await supabase.rpc('is_sponsorship_approved', { p_tournament_id: tournamentId })
    approvals[tournamentId] = !error && data === true
  } catch {
    approvals[tournamentId] = false
  } finally {
    inFlight.delete(tournamentId)
  }
}

/** Reactive; false until the answer arrives, and whenever the database cannot say. */
export function sponsorshipApproved(tournamentId) {
  if (!tournamentId) return false
  if (!(tournamentId in approvals) && !inFlight.has(tournamentId)) void loadApproval(tournamentId)
  return approvals[tournamentId] === true
}

function remember(row) {
  if (row?.tournament_id) approvals[row.tournament_id] = row.status === 'approved'
  return row
}

// A database without the release yet answers "unknown function/table".
const isOutdated = (error) => errorKey(error) === 'serverErrors.outdated'

/** The tournament's request: `{ row }` (null = never asked) or `{ unavailable: true }`. */
export async function fetchSponsorshipRequest(tournamentId) {
  const { data, error } = await supabase
    .from('sponsorship_requests')
    .select('id, tournament_id, status, message, created_at, updated_at, decided_at')
    .eq('tournament_id', tournamentId)
    .maybeSingle()
  if (error) {
    if (isOutdated(error)) return { unavailable: true }
    throw error
  }
  return { row: remember(data) }
}

export async function requestSponsorship(tournamentId, message) {
  const { data, error } = await supabase.rpc('request_sponsorship', { p_tournament_id: tournamentId, p_message: message || null })
  if (error) throw error
  return remember(data)
}

/** Platform admin: `{ rows }` or `{ unavailable: true }`. */
export async function listSponsorshipRequests() {
  const { data, error } = await supabase.rpc('list_sponsorship_requests')
  if (error) {
    if (isOutdated(error)) return { unavailable: true }
    throw error
  }
  return { rows: data || [] }
}

export async function decideSponsorshipRequest(requestId, status) {
  const { data, error } = await supabase.rpc('decide_sponsorship_request', { p_request_id: requestId, p_status: status })
  if (error) throw error
  return remember(data)
}
