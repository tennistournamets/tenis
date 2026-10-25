import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkScore } from '../src/lib/aiSchemas.js'
import { scoreContextMatches, scoreDraft, scoreMatchList } from '../src/lib/aiScore.js'
import { TASKS, scorePrompt } from '../api/_ai-tasks.js'
import { AiError } from '../api/_ai-errors.js'

const t = (key, params = {}) => `${key}${params.n != null ? ` ${params.n}` : ''}`
const entry = (id, ...names) => ({ id, entry_members: names.map((member_name, i) => ({ member_name, member_order: i + 1 })) })
const tennis = { id: 't1', sport: 'tennis', format: 'single_elimination', status: 'in_progress', set_format: 'best_of_3', scoring_config: {} }
const match = (id, a, b, extra = {}) => ({ id, side_a_entry_id: a, side_b_entry_id: b, status: 'ready', stage: 'main', round_number: 1, match_number: 1, score_revision: 3, ...extra })

test('the model answer keeps known matches, candidates and numbers only', () => {
  const result = checkScore({
    results: [
      { match: 'm1', sets: [[6, 4], { a: 7, b: 6, tb: { a: 7, b: 5 } }, { a: null, b: 2 }], winner: 'a', heard: ' Petraitis  6:4 ' },
      { match: 'm9', sets: [[6, 0]], heard: 'unknown one' },
      { match: null, candidates: ['m1', 'm2', 'm2', 'zz'], sets: [[6, 1]] },
      { match: null, candidates: ['m2'], heard: 'single candidate' },
      { match: 'm2', sets: 'six four', winner: 'x' },
    ],
    unmatched: ['said something'],
    warnings: ['W'],
  }, { refs: { m1: 1, m2: 1 }, family: 'sets' })
  assert.deepEqual(result.results[0], { match: 'm1', candidates: [], heard: 'Petraitis 6:4', winner: 'a', sets: [{ a: 6, b: 4 }, { a: 7, b: 6, tb: { a: 7, b: 5 } }] })
  assert.deepEqual(result.results[1].candidates, ['m1', 'm2'])
  assert.equal(result.results[1].match, null)
  assert.deepEqual(result.results[2], { match: 'm2', candidates: [], heard: null, winner: null, sets: null })
  assert.deepEqual(result.unmatched, ['said something', 'unknown one', 'single candidate'])
  assert.deepEqual(result.remarks, ['W'])
  assert.throws(() => checkScore({}, {}), /ai.badResponse/)
})

test('points and football answers keep a score and penalties', () => {
  const points = checkScore({ results: [{ match: 'm1', score: { a: 21, b: '15' } }] }, { refs: { m1: 1 }, family: 'points' })
  assert.deepEqual(points.results[0].score, { a: 21, b: 15 })
  const goals = checkScore({ results: [{ match: 'm1', score: [1, 1], pens: { a: 4, b: 3 } }] }, { refs: { m1: 1 }, family: 'goals' })
  assert.deepEqual([goals.results[0].score, goals.results[0].pens], [{ a: 1, b: 1 }, { a: 4, b: 3 }])
})

test('open matches only, with short references and readable sides', () => {
  const entriesMap = { e1: entry('e1', 'Jonas Petraitis'), e2: entry('e2', 'Tomas Kazlauskas'), e3: entry('e3', 'Ona'), e4: entry('e4', 'Rūta') }
  const list = scoreMatchList({
    tournament: tennis,
    matches: [
      match('x1', 'e1', 'e2', { match_number: 2 }),
      match('x2', 'e3', 'e4', { status: 'finished' }),
      match('x3', 'e3', null),
      match('x4', 'e3', 'e4', { match_number: 1 }),
      match('x5', 'e1', 'e3', { match_number: 3 }),
    ],
    entriesMap,
    liveScoresByMatch: { x5: { status: 'active' } },
    scheduleByMatch: { x1: { court_id: 'c1' } },
    courtsById: { c1: { name: 'Centrinis' } },
  }, t)
  assert.deepEqual(list.map(item => [item.ref, item.match.id]), [['m1', 'x4'], ['m2', 'x1']])
  assert.equal(list[1].a, 'Jonas Petraitis')
  assert.match(list[1].heading, /Centrinis$/)
  assert.deepEqual(Object.keys(scoreContextMatches(list)[0]), ['ref', 'heading', 'a', 'b'])
})

test('Americano matches are named by round and court, both partners on each side', () => {
  const entriesMap = Object.fromEntries(['a', 'b', 'c', 'd'].map(id => [id, entry(id, id.toUpperCase())]))
  const americano = { ...tennis, sport: 'padel', format: 'americano' }
  const list = scoreMatchList({
    tournament: americano,
    matches: [match('p1', 'a', 'c', { side_a2_entry_id: 'b', side_b2_entry_id: 'd', round_number: 2, match_number: 1 })],
    entriesMap,
  }, t)
  assert.equal(list[0].heading, 'bracket.roundN 2 · pointsFormat.court 1')
  assert.equal(list[0].a, 'A / B')
})

test('a set score becomes the editors payload; a decided match has a winner', () => {
  const draft = scoreDraft({ sets: [{ a: 6, b: 4 }, { a: 6, b: 7, tb: { a: 5, b: 7 } }, { a: 6, b: 2 }], winner: 'a' }, match('x1', 'e1', 'e2'), tennis)
  assert.equal(draft.rpc, 'update_match_sets')
  assert.equal(draft.winner, 'a')
  assert.equal(draft.problem, null)
  assert.equal(draft.payload.p_expected_revision, 3)
  assert.equal(draft.payload.p_sets.length, 3)
  assert.equal(draft.text, '6:4 6:7 (5:7) 6:2')
})

test('a deciding match tie-break is read as its points', () => {
  const config = { tennis: { final_set_rule: 'match_tiebreak_10' } }
  const draft = scoreDraft({ sets: [{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 10, b: 8 }] }, match('x1', 'e1', 'e2'), { ...tennis, scoring_config: config })
  assert.equal(draft.problem, null)
  assert.equal(draft.payload.p_sets[2].score_kind, 'match_tiebreak')
  assert.deepEqual([draft.payload.p_sets[2].side_a_tiebreak, draft.payload.p_sets[2].side_b_tiebreak], [10, 8])
  assert.equal(draft.text, '6:4 3:6 [10:8]')
})

test('an unfinished or impossible set score, or a winner the text contradicts, is not saved', () => {
  const m = match('x1', 'e1', 'e2')
  assert.equal(scoreDraft({ sets: [{ a: 6, b: 4 }] }, m, tennis).problem, 'ai.score.problems.needWinner')
  assert.equal(scoreDraft({ sets: [{ a: 9, b: 4 }, { a: 6, b: 1 }] }, m, tennis).problem, 'ai.score.problems.invalidScore')
  const flipped = scoreDraft({ sets: [{ a: 4, b: 6 }, { a: 3, b: 6 }], winner: 'a' }, m, tennis)
  assert.equal(flipped.problem, 'ai.score.problems.winnerMismatch')
  assert.equal(flipped.rpc, null)
  assert.equal(scoreDraft({ sets: null }, m, tennis).problem, 'ai.score.problems.noScore')
})

test('points must add up to the target', () => {
  const americano = { ...tennis, sport: 'padel', format: 'americano', scoring_config: { points_per_match: 21 } }
  const m = match('p1', 'a', 'c')
  const ok = scoreDraft({ score: { a: 13, b: 8 } }, m, americano)
  assert.deepEqual([ok.rpc, ok.payload.p_a, ok.payload.p_b, ok.winner], ['update_match_points', 13, 8, 'a'])
  assert.equal(scoreDraft({ score: { a: 13, b: 9 } }, m, americano).problem, 'ai.score.problems.pointsSum')
})

test('a knockout football draw needs a penalty winner; a league draw stands', () => {
  const cup = { ...tennis, sport: 'football', format: 'single_elimination' }
  const m = match('f1', 'a', 'b')
  assert.equal(scoreDraft({ score: { a: 1, b: 1 } }, m, cup).problem, 'ai.score.problems.needPens')
  const pens = scoreDraft({ score: { a: 1, b: 1 }, pens: { a: 4, b: 3 } }, m, cup)
  assert.deepEqual([pens.problem, pens.winner, pens.payload.p_a_pens, pens.text], [null, 'a', 4, '1:1 (4:3)'])
  const league = scoreDraft({ score: { a: 2, b: 2 }, pens: { a: 5, b: 4 } }, m, { ...cup, format: 'round_robin' })
  assert.deepEqual([league.problem, league.winner, league.payload.p_a_pens, league.text], [null, null, null, '2:2'])
})

test('the score prompt lists the open matches and the family rules', () => {
  const { system, user } = scorePrompt('Petraitis Kazlauskas 6 4 6 3', {
    family: 'sets',
    setFormat: 'best_of_3',
    finalSet: 'match_tiebreak_10',
    locale: 'lt',
    matches: [{ ref: 'm1', heading: 'Pusfinalis', a: 'Jonas Petraitis', b: 'Tomas Kazlauskas' }, { ref: 'bad', heading: 'x', a: 'y', b: 'z' }],
  })
  assert.match(user, /^m1 \| Pusfinalis \| a: Jonas Petraitis \| b: Tomas Kazlauskas$/m)
  assert.doesNotMatch(user, /bad/)
  assert.match(system, /match tie-break to 10 points/)
  assert.match(system, /first number belongs to "a"/)
  assert.match(user, /Lithuanian/)
  const points = scorePrompt('x', { family: 'points', target: 21, matches: [] })
  assert.match(points.system, /add up to 21/)
  assert.match(points.user, /\(none\)/)
})

test('the score task is tournament-bound and checks references against the sent list', () => {
  assert.equal(TASKS.score.tournament, true)
  const context = { family: 'points', matches: [{ ref: 'm1', heading: 'R1', a: 'A', b: 'B' }] }
  const result = TASKS.score.check({ results: [{ match: 'm1', score: { a: 20, b: 4 } }, { match: 'm2', score: { a: 1, b: 2 }, heard: 'm2?' }] }, { context })
  assert.equal(result.results.length, 1)
  assert.deepEqual(result.unmatched, ['m2?'])
  assert.throws(() => TASKS.score.check({ results: 'no' }, { context }), error => error instanceof AiError && error.code === 'ai.badResponse')
})
