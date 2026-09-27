import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { getSportConfig, isDynamicFormat, isIndividualFormat, isPointsFormat, pointsTarget, pointsTargetOptions, scoringFamily } from '../src/lib/sportConfig.js'
import { complementScore, currentRound, kotcDefaultRounds, pointsPlan, pointsRoster, pointsRounds, restPoints, roundMinutes } from '../src/lib/pointsFormat.js'
import { matchSideLabel, matchSidesReady, sideEntryIds } from '../src/lib/entryDisplay.js'
import { rosterMismatch } from '../src/lib/groupsFlow.js'
import { tournamentChampion, finishConfirmation } from '../src/lib/tournamentChampion.js'
import { knockoutTotals, matchRoundName } from '../src/lib/roundLabels.js'
import { errorKey } from '../src/lib/errorMessages.js'
import { pointsFormatMessages } from '../src/i18n/pointsFormat.js'

const t = (key, params = {}) => `${key}${Object.keys(params).length ? JSON.stringify(params) : ''}`
const entry = (id, name) => ({ id, display_name: name, entry_type: 'doubles', entry_members: [{ member_name: name, member_order: 1 }] })
const entriesMap = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, entry(id, id.toUpperCase())]))
const match = (round, court, [a, a2, b, b2], extra = {}) => ({
  id: `${round}-${court}`, round_number: round, match_number: court, stage: 'main', status: 'ready',
  side_a_entry_id: a, side_a2_entry_id: a2, side_b_entry_id: b, side_b2_entry_id: b2, ...extra,
})

test('points formats belong to padel only; other sports keep the classic four', () => {
  assert.deepEqual(getSportConfig('padel').allowedFormats.slice(-4), ['americano', 'mexicano', 'team_americano', 'king_of_court'])
  for (const sport of ['tennis', 'football']) assert.ok(!getSportConfig(sport).allowedFormats.some(isPointsFormat), sport)
  assert.deepEqual(['americano', 'mexicano', 'king_of_court'].map(isIndividualFormat), [true, true, true])
  assert.equal(isIndividualFormat('team_americano'), false)
  assert.deepEqual(['mexicano', 'king_of_court', 'americano'].map(isDynamicFormat), [true, true, false])
  assert.equal(scoringFamily('padel', 'americano'), 'points')
  assert.equal(scoringFamily('padel', 'round_robin'), 'sets')
  assert.equal(scoringFamily('padel'), 'sets')
})

test('points per match: stored value, defaults 24 and 21, King of the Court offers only odd totals', () => {
  assert.equal(pointsTarget({ format: 'americano', scoring_config: { points_per_match: 32 } }), 32)
  assert.equal(pointsTarget({ format: 'americano', scoring_config: {} }), 24)
  assert.equal(pointsTarget({ format: 'king_of_court' }), 21)
  assert.ok(pointsTargetOptions('king_of_court').every(n => n % 2 === 1))
  assert.equal(complementScore('13', 24), '11')
  assert.equal(complementScore('', 24), '')
  assert.equal(complementScore('30', 24), '')
  assert.equal(roundMinutes(24), 18)
})

test('plans mirror the generators: cycle, courts, rests and the King of the Court field', () => {
  assert.deepEqual(
    (({ valid, courts, rounds, matches, resting }) => ({ valid, courts, rounds, matches, resting }))(pointsPlan('americano', 8)),
    { valid: true, courts: 2, rounds: 7, matches: 14, resting: 0 })
  // The full partner cycle: floor(n(n-1)/2 / (2 * courts)) rounds.
  const ten = pointsPlan('americano', 10)
  assert.deepEqual([ten.rounds, ten.courts, ten.resting, ten.cycle, ten.full], [11, 2, 2, 9, 11])
  assert.deepEqual([pointsPlan('americano', 6).rounds, pointsPlan('americano', 13).rounds, pointsPlan('americano', 13, { courts: 2 }).rounds, pointsPlan('americano', 10, { courts: 1 }).rounds], [7, 13, 19, 22])
  assert.deepEqual([pointsPlan('americano', 8, { courts: 1, rounds: 14 }).matches, pointsPlan('americano', 8, { courts: 1 }).resting], [14, 4])
  assert.equal(pointsPlan('americano', 3).reason, 'minPlayers')
  assert.equal(pointsPlan('king_of_court', 10).reason, 'kotcPlayers')
  assert.equal(pointsPlan('king_of_court', 12).courts, 3)
  assert.deepEqual([pointsPlan('king_of_court', 8).rounds, pointsPlan('king_of_court', 16).rounds, pointsPlan('king_of_court', 8, { rounds: 9 }).rounds], [5, 7, 9])
  assert.deepEqual([kotcDefaultRounds(2), kotcDefaultRounds(4), restPoints(24), restPoints(21), restPoints(16)], [5, 7, 12, 10, 8])
  assert.equal(pointsPlan('mexicano', 9).resting, 1)
  assert.equal(pointsPlan('mexicano', 9).dynamic, true)
  const team = pointsPlan('team_americano', 5)
  assert.deepEqual([team.valid, team.rounds, team.matches, team.resting], [true, 5, 10, 1])
  assert.equal(pointsPlan('team_americano', 2).reason, 'minPairs')
})

test('rounds group matches by court, list who rests and find the round in play', () => {
  const ms = [match(1, 2, ['a', 'b', 'c', 'd']), match(1, 1, ['a', 'c', 'b', 'd'], { status: 'finished' }), match(2, 1, ['a', 'd', 'b', 'c'])]
  ms[0].status = 'finished'
  const rounds = pointsRounds(ms, ['a', 'b', 'c', 'd', 'e'])
  assert.deepEqual(rounds.map(r => [r.round, r.matches.map(m => m.match_number), r.resting, r.finished]), [[1, [1, 2], ['e'], true], [2, [1], ['e'], false]])
  assert.equal(currentRound(rounds).round, 2)
  assert.deepEqual(pointsRoster({ format_config: { roster: ['x'] } }, [{ id: 'y' }]), ['x'])
  assert.deepEqual(pointsRoster({ format_config: {} }, [{ id: 'y' }]), ['y'])
})

test('a side of a points match names both players; a pair entry is still one name', () => {
  const m = match(1, 1, ['a', 'b', 'c', 'd'])
  assert.deepEqual(sideEntryIds(m, 'a'), ['a', 'b'])
  assert.equal(matchSideLabel(m, 'a', entriesMap), 'A / B')
  assert.equal(matchSideLabel({ side_a_entry_id: 'c' }, 'a', entriesMap), 'C')
  assert.equal(matchSideLabel({}, 'b', entriesMap, 'TBD'), 'TBD')
  assert.equal(matchSidesReady(m), true)
  assert.equal(matchSidesReady({ ...m, side_b2_entry_id: null }), false)
  assert.equal(matchSidesReady({ side_a_entry_id: 'a', side_b_entry_id: 'b' }), true)
})

test('the roster check uses the stored roster: resting players are not missing', () => {
  const ms = [match(1, 1, ['a', 'b', 'c', 'd'])]
  const approved = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id }))
  assert.equal(rosterMismatch(approved, ms).stale, true)
  assert.equal(rosterMismatch(approved, ms, ['a', 'b', 'c', 'd', 'e']).stale, false)
  assert.deepEqual(rosterMismatch(approved, ms, ['a', 'b', 'c', 'd']).missing, ['e'])
  // Partners count as playing without a roster too.
  assert.equal(rosterMismatch(approved.slice(0, 4), ms).stale, false)
})

test('champion: the points leader once Americano is played out; Mexicano and KotC only when finished', () => {
  const standings = [{ entry_id: 'a', rank: 1 }, { entry_id: 'b', rank: 2 }]
  const played = [match(1, 1, ['a', 'b', 'c', 'd'], { status: 'finished' })]
  assert.deepEqual(tournamentChampion({ format: 'americano', status: 'in_progress', matches: played, standings }), { entryId: 'a', source: 'standings' })
  assert.equal(tournamentChampion({ format: 'americano', status: 'in_progress', matches: [...played, match(2, 1, ['a', 'c', 'b', 'd'])], standings }), null)
  assert.equal(tournamentChampion({ format: 'mexicano', status: 'in_progress', matches: played, standings }), null)
  assert.equal(tournamentChampion({ format: 'king_of_court', status: 'completed', matches: played, standings }).entryId, 'a')
  const finish = finishConfirmation({ format: 'americano', matches: [match(2, 1, ['a', 'c', 'b', 'd'])], sideLabel: (m, side) => matchSideLabel(m, side, entriesMap), t })
  assert.equal(finish.options.details.items[0].teams, 'A / C — B / D')
})

test('points rounds are named "Round N", not by distance to a final', () => {
  const totals = knockoutTotals([match(3, 1, [])], 'americano')
  assert.deepEqual(totals, { pointsRounds: true })
  assert.equal(matchRoundName(match(3, 1, []), totals, t), 'bracket.roundN{"n":3}')
})

test('server codes pointsFormat.* are translated in every locale', async () => {
  const sql = await readFile(new URL('../supabase/migrations/20260926203853_padel_points_formats.sql', import.meta.url), 'utf8')
  const codes = [...new Set([...sql.matchAll(/'pointsFormat\.([A-Za-z]+)'/g)].map(m => m[1]))]
  assert.ok(codes.length >= 15)
  for (const code of codes) {
    assert.equal(errorKey(`pointsFormat.${code}`), `pointsFormat.errors.${code}`)
    for (const locale of ['ru', 'en', 'lt']) assert.ok(pointsFormatMessages[locale].errors[code], `${locale}: ${code}`)
  }
  const keys = locale => Object.keys(pointsFormatMessages[locale]).sort()
  assert.deepEqual(keys('en'), keys('ru'))
  assert.deepEqual(keys('lt'), keys('ru'))
})
