import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scoringAccess, matchScoringAction } from '../src/lib/scoringAccess.js'
import { normalizeTournamentSlug } from '../src/lib/tournamentSlug.js'
import { SPORTS, TOURNAMENT_FORMATS } from '../src/lib/sportConfig.js'

const ready = { side_a_entry_id: 'a', side_b_entry_id: 'b', status: 'ready' }

test('every supported sport/format respects manager and counter scoring permissions', () => {
  for (const sport of SPORTS) for (const format of TOURNAMENT_FORMATS) {
    const tournament = { sport, format, status: 'in_progress' }
    for (const role of ['owner', 'editor']) {
      assert.equal(scoringAccess(tournament, role).scores, true)
      assert.equal(matchScoringAction(tournament, role, ready), sport === 'football' ? 'result' : 'live')
      assert.equal(matchScoringAction(tournament, role, { ...ready, status: 'finished' }), 'result')
    }
    const counter = scoringAccess(tournament, 'counter')
    assert.equal(counter.final, false)
    assert.equal(counter.scores, sport !== 'football')
    assert.equal(matchScoringAction(tournament, 'counter', ready), sport === 'football' ? null : 'live')
    assert.equal(matchScoringAction(tournament, 'counter', { ...ready, status: 'finished' }), null)
    for (const role of [null, 'viewer', 'outsider', 'platform_admin']) {
      assert.equal(scoringAccess(tournament, role).scores, false)
      assert.equal(matchScoringAction(tournament, role, ready), null)
    }
  }
})

test('no scoring action for non-active tournaments, missing sides or unsupported sports', () => {
  for (const sport of [...SPORTS, 'unknown']) for (const role of ['owner', 'editor', 'counter']) {
    for (const status of ['draft', 'registration_open', 'registration_closed', 'completed']) {
      assert.equal(matchScoringAction({ sport, status }, role, ready), null)
    }
    for (const match of [null, {}, { ...ready, side_a_entry_id: null }, { ...ready, side_b_entry_id: null }]) {
      assert.equal(matchScoringAction({ sport, status: 'in_progress' }, role, match), null)
    }
  }
  assert.equal(scoringAccess({ sport: 'unknown', status: 'in_progress' }, 'owner').scores, false)
})

test('Russian and Lithuanian tournament names create readable stable URLs', () => {
  for (const [name, slug] of [
    ['Кубок города', 'kubok-goroda'], ['Ёлки и йога', 'yolki-i-yoga'],
    ['Žalgirio taurė — Šiauliai 2026', 'zalgirio-taure-siauliai-2026'],
    ['ĄČĘĖĮŠŲŪŽ', 'aceeisuuz'], ['  -- Summer___Cup -- ', 'summer-cup'],
    ['🎾 Кубок / города? #2026', 'kubok-goroda-2026'],
    ['123', '123'], ['', ''], ['---', ''], ['🏆', ''],
  ]) assert.equal(normalizeTournamentSlug(name), slug, name)
  const long = normalizeTournamentSlug('a'.repeat(79) + ' --- extra')
  assert.equal(long.length, 79)
  assert.equal(normalizeTournamentSlug('a'.repeat(200)).length, 80)
  assert.equal(normalizeTournamentSlug('E\u0307'), 'e')
})
