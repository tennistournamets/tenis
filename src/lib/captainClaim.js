// Captain invitation links (/tournaments/<slug>?captain=<token>). A signed-in visitor
// claims the team at once; otherwise the token waits in localStorage while Google
// sign-in runs (it returns to /admin), and the admin shell claims it and comes back.
const KEY = 'bracketa:captain-claim'
const MAX_AGE_MS = 60 * 60 * 1000

export function savePendingClaim(slug, token) {
  try { localStorage.setItem(KEY, JSON.stringify({ slug, token, at: Date.now() })) } catch { /* private mode */ }
}

/** The pending claim (and forget it), or null when none or older than an hour. */
export function takePendingClaim() {
  let raw = null
  try {
    raw = localStorage.getItem(KEY)
    localStorage.removeItem(KEY)
  } catch { return null }
  try {
    const claim = JSON.parse(raw)
    if (!claim?.token || !claim?.slug || Date.now() - Number(claim.at) > MAX_AGE_MS) return null
    return claim
  } catch { return null }
}

/** claim_team_captain: { entry_id, tournament_id, slug, team_name }. Throws the RPC error. */
export async function claimCaptain(supabase, token) {
  const { data, error } = await supabase.rpc('claim_team_captain', { p_token: token })
  if (error) throw error
  return data
}
