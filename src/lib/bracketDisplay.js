export function isByeMatch(match) {
  const a = match.side_a_entry_id
  const b = match.side_b_entry_id
  return match.status === 'finished'
    && Boolean(a) !== Boolean(b)
    && match.winner_entry_id === (a || b)
}
