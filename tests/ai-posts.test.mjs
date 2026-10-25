import assert from 'node:assert/strict'
import { test } from 'node:test'
import { checkPosts } from '../src/lib/aiSchemas.js'
import { buildPostFacts, finalMatch, postMoments, restorePost } from '../src/lib/aiPostFacts.js'
import { TASKS, postsPrompt } from '../api/_ai-tasks.js'
import { AiError } from '../api/_ai-errors.js'

const t = (key, params = {}) => (params.n != null ? `${key} ${params.n}` : key)
const entry = (id, name) => ({ id, entry_members: [{ member_name: name, member_order: 1 }] })
const names = ['Jonas Petraitis', 'Tomas Kazlauskas', 'Mantas Jankauskas', 'Lukas Butkus']
const entriesMap = Object.fromEntries(names.map((name, i) => [`e${i + 1}`, entry(`e${i + 1}`, name)]))
const tennis = { id: 't1', slug: 'rudens', name: 'Rudens taurė', sport: 'tennis', format: 'single_elimination', category: 'singles', status: 'in_progress', venue_address: 'Vilnius, SEB arena' }
const m = (id, round, number, a, b, extra = {}) => ({ id, stage: 'main', round_number: round, match_number: number, side_a_entry_id: a, side_b_entry_id: b, status: 'ready', ...extra })
const done = (match, winner, a, b) => ({ ...match, status: 'finished', winner_entry_id: winner, side_a_score: a, side_b_score: b })
const set = (match_id, set_index, a, b, tb) => ({ match_id, set_index, score_kind: 'set', side_a_games: a, side_b_games: b, side_a_tiebreak: tb?.[0] ?? null, side_b_tiebreak: tb?.[1] ?? null })

const semis = [done(m('s1', 1, 1, 'e1', 'e2'), 'e1', 2, 0), done(m('s2', 1, 2, 'e3', 'e4'), 'e4', 2, 1)]
const sets = [
  set('s1', 1, 6, 1), set('s1', 2, 6, 0),
  set('s2', 1, 6, 4), set('s2', 2, 6, 7, [5, 7]), set('s2', 3, 4, 6),
  set('f1', 1, 7, 5), set('f1', 2, 6, 4),
]

test('a finished round and a played final are things to post about', () => {
  const open = [...semis, m('f1', 2, 1, 'e1', 'e4')]
  assert.deepEqual(postMoments({ tournament: tennis, matches: open }, t).map(item => item.key), ['round:main:1'])
  const played = [...semis, done(m('f1', 2, 1, 'e1', 'e4'), 'e1', 2, 0)]
  assert.deepEqual(postMoments({ tournament: tennis, matches: played }, t).map(item => item.key), ['results', 'round:main:1'])
  assert.equal(finalMatch(tennis, played).id, 'f1')
  assert.deepEqual(postMoments({ tournament: tennis, matches: [m('x', 1, 1, 'e1', 'e2')] }, t), [])
})

test('results facts name the champion and carry tokens, never names', () => {
  const matches = [...semis, done(m('f1', 2, 1, 'e1', 'e4'), 'e1', 2, 0)]
  const { facts, names: map } = buildPostFacts({ tournament: { ...tennis, status: 'completed' }, matches, entriesMap, sets, moment: 'results' }, t)
  const json = JSON.stringify(facts)
  for (const name of names) assert.ok(!json.includes(name), `${name} leaked`)
  assert.equal(map[facts.champion], 'Jonas Petraitis')
  assert.equal(map[facts.runnerUp], 'Lukas Butkus')
  assert.equal(facts.results.length, 3)
  assert.deepEqual(facts.results[0], { round: 'bracket.final', winner: facts.champion, loser: facts.runnerUp, score: '7:5 6:4' })
  // Lukas won the semifinal from side B: the score reads from his side.
  assert.equal(facts.closest.score, '4:6 7:6 (7:5) 6:4')
  assert.equal(map[facts.closest.winner], 'Lukas Butkus')
  assert.equal(facts.biggestWin.score, '6:1 6:0')
  assert.equal(facts.tournament.entries, 4)
  assert.equal(facts.tournament.venue, 'Vilnius, SEB arena')
  assert.equal(facts.next, undefined)
})

test('round facts hold that round and what comes next', () => {
  const matches = [...semis, m('f1', 2, 1, 'e1', 'e4')]
  const { facts, names: map } = buildPostFacts({ tournament: tennis, matches, entriesMap, sets, moment: 'round:main:1' }, t)
  assert.equal(facts.moment, 'round')
  assert.equal(facts.results.length, 2)
  assert.deepEqual(facts.next.map(item => [map[item.a], map[item.b]]), [['Jonas Petraitis', 'Lukas Butkus']])
  assert.deepEqual(facts.results.map(item => map[item.winner]), ['Jonas Petraitis', 'Lukas Butkus'])
  assert.equal(facts.champion, undefined)
})

test('a points format posts its table; partners are both on a side', () => {
  const americano = { ...tennis, sport: 'padel', format: 'americano', status: 'completed', category: 'doubles' }
  const round = [done(m('p1', 1, 1, 'e1', 'e3', { side_a2_entry_id: 'e2', side_b2_entry_id: 'e4' }), 'e1', 15, 9)]
  const table = [{ rank: 1, entry_id: 'e2', total: 40, won: 3, lost: 0 }, { rank: 2, entry_id: 'e1', total: 35, won: 2, lost: 1 }]
  const { facts, names: map } = buildPostFacts({ tournament: americano, matches: round, entriesMap, pointsStandings: table, moment: 'results' }, t)
  assert.equal(facts.results[0].score, '15:9')
  assert.match(facts.results[0].winner, /^P\d+ \/ P\d+$/)
  assert.equal(map[facts.table[0].who], 'Tomas Kazlauskas')
  assert.equal(facts.table[0].points, 40)
  assert.equal(map[facts.champion], 'Tomas Kazlauskas')
})

test('names and the link go back into the text', () => {
  const text = 'Čempionas — P1!\nFinale P1 / P2 prieš P9.\n{link}'
  assert.equal(restorePost(text, { names: { P1: 'Jonas', P2: 'Tomas' }, link: 'https://x/t?utm_source=facebook' }), 'Čempionas — Jonas!\nFinale Jonas / Tomas prieš P9.\nhttps://x/t?utm_source=facebook')
  assert.equal(restorePost('Sveikinam P1\n{link}', { names: { P1: 'Ona' } }), 'Sveikinam Ona')
  assert.equal(restorePost('P10 ir P1', { names: { P1: 'A', P10: 'B' } }), 'B ir A')
})

test('the answer keeps three trimmed texts and flags unknown participants', () => {
  const result = checkPosts({ instagram: '  Hi P1  ', facebook: 'P1 won\n\n\n\nyes {link}', whatsapp: 7 }, { tokens: ['P1'] })
  assert.deepEqual(result.posts, { instagram: 'Hi P1', facebook: 'P1 won\n\nyes {link}', whatsapp: '7' })
  assert.equal(result.unknownNames, false)
  assert.equal(checkPosts({ instagram: 'P2 wins' }, { tokens: ['P1'] }).unknownNames, true)
  assert.equal(checkPosts({ instagram: 'x'.repeat(3000) }).posts.instagram.length, 2200)
  assert.throws(() => checkPosts({ instagram: ' ' }), /ai.badResponse/)
  assert.equal(result.checkNames, false)
  assert.equal(checkPosts({ facebook: 'Finale įveikęs P2 rezultatu 6:2' }, { tokens: ['P2'] }).checkNames, true)
  assert.equal(checkPosts({ facebook: 'Финал выиграл P1, обыграв P2' }, { tokens: ['P1', 'P2'] }).checkNames, true)
  assert.equal(checkPosts({ facebook: 'Pusfinalis prieš\nP3' }, { tokens: ['P3'] }).checkNames, true)
  assert.equal(checkPosts({ facebook: 'Čempionas — P1\nFinalas: P1 — P2 6:2 6:4\nP1 laimėjo finalą' }, { tokens: ['P1', 'P2'] }).checkNames, false)
})

test('the posts prompt carries the facts, the language and the token rule', () => {
  const facts = { moment: 'results', champion: 'P1', results: [] }
  const { system, user } = postsPrompt('', { facts, postLanguage: 'ru', locale: 'lt' })
  assert.match(user, /"champion":"P1"/)
  assert.match(user, /Write the posts in Russian/)
  assert.doesNotMatch(user, /Organizer's note/)
  assert.match(system, /never as an object or after a preposition/)
  assert.match(system, /Wrong: "įveikęs P2"/)
  assert.match(system, /do not promise future events/)
  assert.equal(TASKS.posts.temperature, 0.3)
  assert.match(system, /\{link\}/)
  assert.match(postsPrompt('Ačiū klubui', { facts }).user, /Organizer's note:\n<<<\nAčiū klubui\n>>>/)
})

test('the posts task allows an empty note and checks tokens against the facts', () => {
  assert.equal(TASKS.posts.allowEmptyInput, true)
  assert.equal(TASKS.posts.tournament, true)
  const context = { facts: { champion: 'P1', results: [{ a: 'P1', b: 'P2' }] } }
  assert.equal(TASKS.posts.check({ instagram: 'P1 P2', facebook: 'P1', whatsapp: 'P2' }, { context }).unknownNames, false)
  assert.equal(TASKS.posts.check({ instagram: 'P3' }, { context }).unknownNames, true)
  assert.throws(() => TASKS.posts.check(null, { context }), error => error instanceof AiError && error.code === 'ai.badResponse')
})
