function indexBy(rows, key) {
  const indexed = {}
  for (const row of rows) indexed[row[key]] = row
  return indexed
}

export function indexEntries(entries) {
  return indexBy(entries, 'id')
}

export function indexLiveScores(liveScores) {
  return indexBy(liveScores, 'match_id')
}

export function groupSetsByMatch(sets) {
  const grouped = {}
  for (const set of sets) {
    if (!grouped[set.match_id]) grouped[set.match_id] = []
    grouped[set.match_id].push(set)
  }
  return grouped
}

export function buildGroupsView(groups, matches, groupStandings) {
  const matchesByGroup = new Map()
  for (const match of matches) {
    if (match.stage !== 'group') continue
    if (!matchesByGroup.has(match.group_id)) matchesByGroup.set(match.group_id, [])
    matchesByGroup.get(match.group_id).push(match)
  }

  return [...groups].sort((a, b) => a.group_index - b.group_index).map(group => {
    const orderedMatches = (matchesByGroup.get(group.id) || [])
      .sort((a, b) => a.round_number - b.round_number || a.match_number - b.match_number)
    const rounds = new Map()
    for (const match of orderedMatches) {
      if (!rounds.has(match.round_number)) rounds.set(match.round_number, [])
      rounds.get(match.round_number).push(match)
    }
    return {
      id: group.id,
      name: group.name,
      standings: groupStandings[group.id] || [],
      rounds: [...rounds].map(([round, list]) => ({ round, list })),
    }
  })
}
