import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { asActor, createDatabase, reapplyForwardMigrations } from './helpers/database.mjs'

let ctx
before(async () => {
  ctx = await createDatabase()
  await ctx.db.query("update feature_flags set enabled=true where key='feature.teams'")
  // A fifth signed-in person who becomes a captain in the invitation tests.
  ctx.actors.captain = randomUUID()
  await ctx.db.query('insert into auth.users(id,email) values ($1,$2)', [ctx.actors.captain, 'captain@example.test'])
})
after(async () => { await ctx?.db.close() })

const A_WINS = JSON.stringify([{ set_index: 1, side_a_games: 6, side_b_games: 2 }, { set_index: 2, side_a_games: 6, side_b_games: 3 }])
const B_WINS = JSON.stringify([{ set_index: 1, side_a_games: 1, side_b_games: 6 }, { set_index: 2, side_a_games: 4, side_b_games: 6 }])

const ROSTER = [
  { name: 'Man One', gender: 'male' },
  { name: 'Man Two', gender: 'male' },
  { name: 'Woman One', gender: 'female' },
  { name: 'Woman Two', gender: 'female' },
]

async function teamTournament({ format = 'round_robin', tie = {}, teams = 4, isPublic = true, scoring = {} } = {}) {
  const id = randomUUID()
  await ctx.db.query(`insert into tournaments(id,name,slug,sport,format,category,set_format,status,is_public,created_by,format_config,scoring_config)
    values ($1,'Team test',$1::uuid::text,'tennis',$2,'team','best_of_3','registration_open',$3,$4,$5,$6)`,
  [id, format, isPublic, ctx.actors.owner, JSON.stringify({ tie }), JSON.stringify(scoring)])
  for (const role of ['owner', 'editor', 'counter']) {
    await ctx.db.query('insert into tournament_admins(tournament_id,user_id,role) values ($1,$2,$3)', [id, ctx.actors[role], role])
  }
  const entries = []
  for (let i = 0; i < teams; i++) {
    const r = await asActor(ctx, 'owner', 'select add_team_entry($1,$2,$3) r', [id, `Team ${i + 1}`, JSON.stringify(ROSTER)])
    entries.push(r.rows[0].r.id)
    await ctx.db.query('update entries set seed_order=$2 where id=$1', [r.rows[0].r.id, i + 1])
  }
  return { id, entries }
}

const start = id => ctx.db.query("update tournaments set status='in_progress' where id=$1", [id])
const ties = async id => (await ctx.db.query(
  `select * from matches where tournament_id=$1 and parent_match_id is null order by stage, round_number, match_number`, [id])).rows
const lines = async tieId => (await ctx.db.query('select * from matches where parent_match_id=$1 order by line_no', [tieId])).rows
const tieRow = async tieId => (await ctx.db.query('select * from matches where id=$1', [tieId])).rows[0]
const members = async entryId => (await ctx.db.query('select * from entry_members where entry_id=$1 order by member_order', [entryId])).rows
const lineType = async (tournamentId, lineNo) => (await ctx.db.query(
  "select tie_line_type(team_tie_config(format_config->'tie'), $2) t from tournaments where id=$1", [tournamentId, lineNo])).rows[0].t

// Players for one side of a line type, rotating so nobody exceeds one singles and one doubles line.
function pick(roster, type, used) {
  const men = roster.filter(m => m.gender === 'male')
  const women = roster.filter(m => m.gender === 'female')
  const take = (list, kind) => {
    const p = list.find(m => !used.has(`${kind}:${m.id}`))
    used.add(`${kind}:${p.id}`)
    return p.id
  }
  switch (type) {
    case 'MS': return [take(men, 's')]
    case 'WS': return [take(women, 's')]
    case 'XS': return [take(roster, 's')]
    case 'MD': return [take(men, 'd'), take(men, 'd')]
    case 'WD': return [take(women, 'd'), take(women, 'd')]
    case 'XD': return [take(men, 'd'), take(women, 'd')]
    default: return [take(roster, 'd'), take(roster, 'd')]
  }
}

async function fullLineup(t, tie, side, { actor = 'owner', submit = true } = {}) {
  const entry = side === 'A' ? tie.side_a_entry_id : tie.side_b_entry_id
  const roster = await members(entry)
  const used = new Set()
  const payload = []
  for (const line of await lines(tie.id)) {
    payload.push({ line_no: line.line_no, members: pick(roster, await lineType(t.id, line.line_no), used) })
  }
  return asActor(ctx, actor, 'select save_tie_lineup($1,$2,$3,$4) r', [tie.id, side, JSON.stringify(payload), submit])
}

async function score(lineId, sets, actor = 'owner') {
  const rev = (await ctx.db.query('select score_revision from matches where id=$1', [lineId])).rows[0].score_revision
  return asActor(ctx, actor, 'select update_match_sets($1,$2,$3)', [lineId, sets, rev])
}

test('team tournaments are tennis only, behind the flag, with a normalized template and 2/1/0 points', async () => {
  const t = await teamTournament({ tie: { lines: ['MS', 'WS', 'XD'] }, teams: 0 })
  const row = (await ctx.db.query('select format_config, scoring_config from tournaments where id=$1', [t.id])).rows[0]
  assert.deepEqual(row.format_config.tie.lines, [{ type: 'MS' }, { type: 'WS' }, { type: 'XD' }])
  assert.equal(row.format_config.tie.win_rule, 'rubbers')
  assert.equal(row.format_config.tie.roster_max, 16)
  assert.equal(row.scoring_config.points_win, 2)
  assert.equal(row.scoring_config.points_draw, 1)

  const insert = (sport, format, tie) => ctx.db.query(`insert into tournaments(name,slug,sport,format,category,status,created_by,format_config)
    values ('x',$1,$2,$3,'team','registration_open',$4,$5)`, [randomUUID(), sport, format, ctx.actors.owner, JSON.stringify({ tie })])
  await assert.rejects(insert('padel', 'round_robin', {}), /team.sportNotSupported/)
  await assert.rejects(insert('tennis', 'double_elimination', {}), /team.formatNotSupported/)
  await assert.rejects(insert('tennis', 'round_robin', { lines: ['ZZ'] }), /team.invalidTemplate/)
  await assert.rejects(insert('tennis', 'round_robin', { lines: [] }), /team.invalidTemplate/)
  await ctx.db.query("update feature_flags set enabled=false where key='feature.teams'")
  try {
    await assert.rejects(insert('tennis', 'round_robin', {}), /team.disabled/)
  } finally {
    await ctx.db.query("update feature_flags set enabled=true where key='feature.teams'")
  }
})

test('the template changes only before the ties exist', async () => {
  const t = await teamTournament({ tie: { lines: ['XS', 'AD'] }, teams: 2 })
  const tie = (await asActor(ctx, 'owner', 'select update_tie_template($1,$2) r', [t.id, JSON.stringify({ lines: ['MS', 'WS', 'XD'], win_rule: 'games' })])).rows[0].r
  assert.deepEqual(tie.lines.map(l => l.type), ['MS', 'WS', 'XD'])
  assert.equal(tie.win_rule, 'games')
  await assert.rejects(asActor(ctx, 'editor', 'select update_tie_template($1,$2)', [t.id, JSON.stringify({ lines: ['Q'] })]), /team.invalidTemplate/)
  await assert.rejects(asActor(ctx, 'counter', 'select update_tie_template($1,$2)', [t.id, '{}']), /Not allowed/)
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  await assert.rejects(asActor(ctx, 'owner', 'select update_tie_template($1,$2)', [t.id, JSON.stringify({ lines: ['XS'] })]), /team.templateLocked/)
  await assert.rejects(ctx.db.query("update tournaments set category='singles' where id=$1", [t.id]), /team.categoryLocked/)
})

test('teams enter only through the team RPCs; other entries keep at most two players', async () => {
  const t = await teamTournament({ teams: 1 })
  await assert.rejects(asActor(ctx, 'owner', 'select add_manual_entry($1,$2)', [t.id, 'Somebody']), /team.useTeamForm/)
  await assert.rejects(asActor(ctx, 'anon', "select register_entry($1,'team',null,'X',null,null,null,'+37060000000','x@example.test')", [t.id]), /team.useTeamForm/)
  const roster = await members(t.entries[0])
  assert.deepEqual(roster.map(m => [m.member_name, m.gender, m.member_order]),
    [['Man One', 'male', 1], ['Man Two', 'male', 2], ['Woman One', 'female', 3], ['Woman Two', 'female', 4]])

  const singles = await ctx.db.query(`insert into tournaments(name,slug,sport,format,category,status,created_by)
    values ('s',$1,'tennis','round_robin','singles','registration_open',$2) returning id`, [randomUUID(), ctx.actors.owner])
  await ctx.db.query("insert into tournament_admins(tournament_id,user_id,role) values ($1,$2,'owner')", [singles.rows[0].id, ctx.actors.owner])
  const e = await asActor(ctx, 'owner', 'select add_manual_entry($1,$2) r', [singles.rows[0].id, 'Solo'])
  await assert.rejects(ctx.db.query("insert into entry_members(entry_id,member_name,member_order) values ($1,'Third',3)", [e.rows[0].r.id]), /Invalid member order/)

  // Roster edit keeps ids, renames, reorders and refuses duplicates.
  const keep = roster.map(m => ({ id: m.id, name: m.member_name, gender: m.gender })).reverse()
  await asActor(ctx, 'owner', 'select save_team_roster($1,$2,$3)', [t.entries[0], JSON.stringify([...keep, { name: 'New Guy', gender: 'male' }]), 'Renamed'])
  const after = await members(t.entries[0])
  assert.deepEqual(after.map(m => m.member_name), ['Woman Two', 'Woman One', 'Man Two', 'Man One', 'New Guy'])
  assert.equal(after[0].id, roster[3].id)
  assert.equal((await ctx.db.query('select display_name from entries where id=$1', [t.entries[0]])).rows[0].display_name, 'Renamed')
  await assert.rejects(asActor(ctx, 'owner', 'select save_team_roster($1,$2)', [t.entries[0], JSON.stringify([{ name: 'A' }, { name: ' a ' }])]), /team.duplicateMember/)
  await assert.rejects(asActor(ctx, 'outsider', 'select save_team_roster($1,$2)', [t.entries[0], JSON.stringify([{ name: 'A' }])]), /Not allowed/)
})

test('round robin: ties get their lines, need lineups, and are decided by a majority of lines', async () => {
  const t = await teamTournament({ tie: { lines: ['XS', 'XS', 'AD'] } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  const all = await ties(t.id)
  assert.equal(all.length, 6)
  for (const tie of all) {
    const ls = await lines(tie.id)
    assert.deepEqual(ls.map(l => [l.line_no, l.stage, l.status]), [[1, 'rubber', 'pending'], [2, 'rubber', 'pending'], [3, 'rubber', 'pending']])
    for (const l of ls) assert.deepEqual([l.side_a_entry_id, l.side_b_entry_id], [tie.side_a_entry_id, tie.side_b_entry_id])
  }
  await start(t.id)
  const [tie] = all
  const [l1, l2, l3] = await lines(tie.id)
  await assert.rejects(score(l1.id, A_WINS), /team.lineupMissing/)
  await assert.rejects(asActor(ctx, 'owner', 'select update_match_sets($1,$2,$3)', [tie.id, A_WINS, tie.score_revision]), /team.tieComputed/)

  await fullLineup(t, tie, 'A')
  await fullLineup(t, tie, 'B')
  assert.deepEqual((await lines(tie.id)).map(l => l.status), ['ready', 'ready', 'ready'])

  await score(l1.id, A_WINS)
  let row = await tieRow(tie.id)
  assert.deepEqual([row.side_a_score, row.side_b_score, row.status, row.winner_entry_id], [1, 0, 'ready', null])
  await score(l2.id, B_WINS, 'counter')
  await score(l3.id, A_WINS)
  row = await tieRow(tie.id)
  assert.deepEqual([row.side_a_score, row.side_b_score, row.status, row.winner_entry_id], [2, 1, 'finished', tie.side_a_entry_id])

  const standings = (await asActor(ctx, 'anon', 'select * from get_standings($1)', [t.id])).rows
  const winner = standings.find(s => s.entry_id === tie.side_a_entry_id)
  const loser = standings.find(s => s.entry_id === tie.side_b_entry_id)
  assert.deepEqual([winner.played, winner.won, winner.points, winner.score_for, winner.score_against], [1, 1, 2, 2, 1])
  assert.deepEqual([loser.played, loser.lost, loser.points], [1, 1, 0])
  assert.equal(standings[0].entry_id, tie.side_a_entry_id)
  assert.equal(standings.reduce((n, s) => n + s.played, 0), 2, 'lines are not counted as matches')

  const games = (await ctx.db.query('select * from standings_rows($1)', [t.id])).rows.find(s => s.entry_id === tie.side_a_entry_id)
  assert.equal(games.games_for, 6 + 6 + 1 + 4 + 6 + 6)
})

test('a round robin tie can end level; a knockout tie adds a decider line', async () => {
  const rr = await teamTournament({ tie: { lines: ['XS', 'AD'] } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [rr.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [rr.id])
  await start(rr.id)
  const [tie] = await ties(rr.id)
  await fullLineup(rr, tie, 'A')
  await fullLineup(rr, tie, 'B')
  const [l1, l2] = await lines(tie.id)
  await score(l1.id, A_WINS)
  await score(l2.id, B_WINS)
  const level = await tieRow(tie.id)
  assert.deepEqual([level.side_a_score, level.side_b_score, level.status, level.winner_entry_id], [1, 1, 'finished', null])
  const st = (await ctx.db.query('select * from standings_rows($1)', [rr.id])).rows.filter(s => s.played)
  assert.deepEqual(st.map(s => [s.drawn, s.points]), [[1, 1], [1, 1]])

  const ko = await teamTournament({ format: 'single_elimination', tie: { lines: ['XS', 'AD'], decider: { type: 'XS' } } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [ko.id])
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [ko.id])
  await start(ko.id)
  const first = (await ties(ko.id)).filter(m => m.round_number === 1)
  assert.equal(first.length, 2)
  const semi = first[0]
  await fullLineup(ko, semi, 'A')
  await fullLineup(ko, semi, 'B')
  const [s1, s2] = await lines(semi.id)
  await score(s1.id, A_WINS)
  await score(s2.id, B_WINS)
  let ls = await lines(semi.id)
  assert.equal(ls.length, 3, 'a decider line appears')
  assert.equal(ls[2].line_no, 3)
  assert.equal((await tieRow(semi.id)).status, 'ready')
  // The decider takes its own lineup from the organizer.
  const ra = await members(semi.side_a_entry_id)
  const rb = await members(semi.side_b_entry_id)
  await asActor(ctx, 'owner', 'select save_tie_lineup($1,$2,$3)', [semi.id, 'A', JSON.stringify([
    { line_no: 1, members: (await ctx.db.query("select member_id from tie_lineups where line_id=$1 and side='A' order by slot", [s1.id])).rows.map(r => r.member_id) },
    { line_no: 2, members: (await ctx.db.query("select member_id from tie_lineups where line_id=$1 and side='A' order by slot", [s2.id])).rows.map(r => r.member_id) },
    { line_no: 3, members: [ra[0].id] }])])
  await asActor(ctx, 'owner', 'select save_tie_lineup($1,$2,$3,false)', [semi.id, 'B', JSON.stringify([
    { line_no: 1, members: (await ctx.db.query("select member_id from tie_lineups where line_id=$1 and side='B' order by slot", [s1.id])).rows.map(r => r.member_id) },
    { line_no: 2, members: (await ctx.db.query("select member_id from tie_lineups where line_id=$1 and side='B' order by slot", [s2.id])).rows.map(r => r.member_id) },
    { line_no: 3, members: [rb[0].id] }])])
  await score(ls[2].id, B_WINS)
  const decided = await tieRow(semi.id)
  assert.deepEqual([decided.side_a_score, decided.side_b_score, decided.status, decided.winner_entry_id], [1, 2, 'finished', semi.side_b_entry_id])
  const final = (await ties(ko.id)).find(m => m.round_number === 2)
  assert.ok([final.side_a_entry_id, final.side_b_entry_id].includes(semi.side_b_entry_id), 'the winner moves on')

  // Correcting a line before the final starts re-feeds the final.
  ls = await lines(semi.id)
  const rev = ls[2].score_revision
  const preview = (await asActor(ctx, 'owner', 'select get_match_correction_preview($1,$2,$3) p', [ls[2].id, JSON.stringify({ sets: JSON.parse(A_WINS) }), rev])).rows[0].p
  await asActor(ctx, 'owner', 'select apply_match_correction($1,$2,$3,$4)', [ls[2].id, JSON.stringify({ sets: JSON.parse(A_WINS) }), rev, preview.token])
  const corrected = await tieRow(semi.id)
  assert.equal(corrected.winner_entry_id, semi.side_a_entry_id)
  const final2 = (await ties(ko.id)).find(m => m.round_number === 2)
  assert.ok([final2.side_a_entry_id, final2.side_b_entry_id].includes(semi.side_a_entry_id))
  assert.ok(![final2.side_a_entry_id, final2.side_b_entry_id].includes(semi.side_b_entry_id))
})

test('games rule: the tie waits for every line and goes to the team with more games', async () => {
  const t = await teamTournament({ tie: { lines: ['XS', 'XS', 'AD'], win_rule: 'games' } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  await start(t.id)
  const [tie] = await ties(t.id)
  await fullLineup(t, tie, 'A')
  await fullLineup(t, tie, 'B')
  const [l1, l2, l3] = await lines(tie.id)
  await score(l1.id, B_WINS) // 5:12
  await score(l2.id, B_WINS) // 10:24
  let row = await tieRow(tie.id)
  assert.deepEqual([row.side_a_score, row.side_b_score, row.status], [5 + 5, 12 + 12, 'ready'], 'two lines lost is not yet a decision')
  await score(l3.id, JSON.stringify([{ set_index: 1, side_a_games: 6, side_b_games: 0 }, { set_index: 2, side_a_games: 6, side_b_games: 0 }]))
  row = await tieRow(tie.id)
  assert.deepEqual([row.side_a_score, row.side_b_score, row.status, row.winner_entry_id], [22, 24, 'finished', tie.side_b_entry_id])
})

test('lineup rules: roster, gender, lines per player, locked lines', async () => {
  const t = await teamTournament({ tie: { lines: ['MS', 'WS', 'XD'] } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  await start(t.id)
  const [tie] = await ties(t.id)
  const a = await members(tie.side_a_entry_id)
  const b = await members(tie.side_b_entry_id)
  const [man1, man2, woman1] = a
  const save = (lineup, submit = false) => asActor(ctx, 'owner', 'select save_tie_lineup($1,$2,$3,$4)', [tie.id, 'A', JSON.stringify(lineup), submit])
  await assert.rejects(save([{ line_no: 1, members: [woman1.id] }]), /team.genderMismatch/)
  await assert.rejects(save([{ line_no: 3, members: [man1.id, man2.id] }]), /team.genderMismatch/)
  await assert.rejects(save([{ line_no: 1, members: [b[0].id] }]), /team.notInRoster/)
  await assert.rejects(save([{ line_no: 9, members: [man1.id] }]), /team.invalidLineup/)
  await assert.rejects(save([{ line_no: 1, members: [man1.id, man2.id] }]), /team.invalidLineup/)
  await assert.rejects(save([{ line_no: 1, members: [man1.id] }], true), /team.lineupIncomplete/)
  // A partial lineup is a draft; a complete one can be submitted.
  await save([{ line_no: 1, members: [man1.id] }])
  await save([{ line_no: 1, members: [man1.id] }, { line_no: 2, members: [woman1.id] }, { line_no: 3, members: [man1.id, woman1.id] }], true)

  const two = await teamTournament({ tie: { lines: ['XS', 'XS'] } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [two.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [two.id])
  const [tie2] = await ties(two.id)
  const r2 = await members(tie2.side_a_entry_id)
  await assert.rejects(asActor(ctx, 'owner', 'select save_tie_lineup($1,$2,$3,false)', [tie2.id, 'A',
    JSON.stringify([{ line_no: 1, members: [r2[0].id] }, { line_no: 2, members: [r2[0].id] }])]), /team.playerLineLimit/)

  // Once a line has a result its players are fixed.
  await fullLineup(t, tie, 'B')
  const [l1] = await lines(tie.id)
  await score(l1.id, A_WINS)
  await assert.rejects(save([{ line_no: 1, members: [man2.id] }, { line_no: 2, members: [woman1.id] }, { line_no: 3, members: [man1.id, woman1.id] }]), /team.lineLocked/)
  await assert.rejects(asActor(ctx, 'owner', 'select save_team_roster($1,$2)', [tie.side_a_entry_id,
    JSON.stringify(a.filter(m => m.id !== man1.id).map(m => ({ id: m.id, name: m.member_name, gender: m.gender })))]), /team.memberPlayed/)
})

test('captains: invitation link, own roster and lineup, hidden lineups until both are in', async () => {
  const t = await teamTournament({ tie: { lines: ['XS', 'AD'] } })
  const [teamA] = t.entries
  const token = (await asActor(ctx, 'owner', 'select create_captain_invite($1) r', [teamA])).rows[0].r.token
  await assert.rejects(asActor(ctx, 'anon', 'select claim_team_captain($1)', [token]), /Authentication required|permission denied/)
  const claimed = (await asActor(ctx, 'captain', 'select claim_team_captain($1) r', [token])).rows[0].r
  assert.equal(claimed.entry_id, teamA)
  await assert.rejects(asActor(ctx, 'outsider', 'select claim_team_captain($1)', [token]), /team.inviteInvalid/)
  assert.equal((await asActor(ctx, 'captain', 'select is_team_captain($1) r', [teamA])).rows[0].r, true)

  // The captain edits the roster before the start.
  const roster = await members(teamA)
  await asActor(ctx, 'captain', 'select save_team_roster($1,$2)', [teamA,
    JSON.stringify([...roster.map(m => ({ id: m.id, name: m.member_name, gender: m.gender })), { name: 'Late Signing', gender: 'female' }])])
  await assert.rejects(asActor(ctx, 'captain', 'select save_team_roster($1,$2)', [t.entries[1], JSON.stringify([{ name: 'X' }])]), /Not allowed/)

  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  await start(t.id)
  await assert.rejects(asActor(ctx, 'captain', 'select save_team_roster($1,$2)', [teamA, JSON.stringify([{ name: 'X' }])]), /team.rosterLocked/)

  const tie = (await ties(t.id)).find(m => m.side_a_entry_id === teamA || m.side_b_entry_id === teamA)
  const mySide = tie.side_a_entry_id === teamA ? 'A' : 'B'
  const otherSide = mySide === 'A' ? 'B' : 'A'
  await assert.rejects(fullLineup(t, tie, otherSide, { actor: 'captain' }), /Not allowed/)
  await fullLineup(t, tie, mySide, { actor: 'captain' })
  await assert.rejects(fullLineup(t, tie, mySide, { actor: 'captain' }), /team.lineupSubmitted/)

  const visibleTo = async actor => (await asActor(ctx, actor, 'select side from tie_lineups where tie_id=$1', [tie.id])).rows.map(r => r.side)
  assert.ok((await visibleTo('captain')).every(s => s === mySide) && (await visibleTo('captain')).length > 0)
  assert.equal((await visibleTo('anon')).length, 0, 'the public waits for both lineups')
  assert.ok((await visibleTo('counter')).length > 0, 'organizers see a submitted lineup')
  const snapAnon = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.deepEqual(snapAnon.tie_lineups, [])
  assert.deepEqual(snapAnon.tie_submissions.map(s => s.side), [mySide])
  assert.deepEqual(snapAnon.team_captains, [teamA])
  assert.deepEqual(snapAnon.my_captain_entries, [])
  const snapCaptain = (await asActor(ctx, 'captain', 'select get_tournament_sync_state($1) s', [t.id])).rows[0].s
  assert.deepEqual(snapCaptain.my_captain_entries, [teamA])
  assert.ok(snapCaptain.tie_lineups.length > 0)
  assert.ok(snapCaptain.entries[0].entry_members.every(m => 'gender' in m))

  await fullLineup(t, tie, otherSide)
  assert.equal(new Set(await visibleTo('anon')).size, 2, 'both lineups are public once both are in')

  // The organizer reopens the captain's side.
  await asActor(ctx, 'owner', 'select reopen_tie_lineup($1,$2)', [tie.id, mySide])
  await fullLineup(t, tie, mySide, { actor: 'captain', submit: false })
  assert.equal((await asActor(ctx, 'owner', 'select remove_team_captain($1) n', [teamA])).rows[0].n, 1)
  assert.equal((await asActor(ctx, 'captain', 'select is_team_captain($1) r', [teamA])).rows[0].r, false)
})

test('public team registration follows the intake rules and makes a signed-in registrant captain', async () => {
  const t = await teamTournament({ tie: { lines: ['XS', 'AD'], roster_min: 3 }, teams: 0 })
  let phone = 37060000100
  const reg = (actor, name, roster, email) => asActor(ctx, actor, 'select register_team($1,$2,$3,$4,$5) r',
    [t.id, name, JSON.stringify(roster), `+${phone++}`, email])
  await assert.rejects(reg('anon', 'Too Small', ROSTER.slice(0, 2), 'small@example.test'), /team.rosterTooSmall/)
  const r1 = (await reg('anon', 'Anon Team', ROSTER, 'anon@example.test')).rows[0].r
  assert.equal(r1.status, 'pending')
  await assert.rejects(reg('anon', 'Again', ROSTER, 'anon@example.test'), /Registration already exists/)
  const r2 = (await reg('captain', 'Captain Team', ROSTER, 'cap@example.test')).rows[0].r
  assert.equal((await asActor(ctx, 'captain', 'select is_team_captain($1) r', [r2.id])).rows[0].r, true)
  assert.equal((await asActor(ctx, 'captain', 'select is_team_captain($1) r', [r1.id])).rows[0].r, false)
})

test('groups and playoff: group ties seed the playoff, whose ties get lines', async () => {
  const t = await teamTournament({ format: 'groups_playoff', tie: { lines: ['XS', 'XS', 'AD'] } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_groups($1,2,1)', [t.id])
  await start(t.id)
  const groupTies = (await ties(t.id)).filter(m => m.stage === 'group')
  assert.equal(groupTies.length, 2)
  for (const tie of groupTies) {
    await fullLineup(t, tie, 'A')
    await fullLineup(t, tie, 'B')
    const ls = await lines(tie.id)
    await score(ls[0].id, A_WINS)
    await score(ls[1].id, A_WINS)
  }
  assert.ok((await ties(t.id)).filter(m => m.stage === 'group').every(m => m.status === 'finished'))
  await asActor(ctx, 'owner', 'select generate_group_playoff($1)', [t.id])
  const playoff = (await ties(t.id)).filter(m => m.stage === 'winners')
  assert.equal(playoff.length, 1)
  assert.deepEqual(new Set([playoff[0].side_a_entry_id, playoff[0].side_b_entry_id]), new Set(groupTies.map(g => g.side_a_entry_id)))
  assert.equal((await lines(playoff[0].id)).length, 3)
  // A dead line in a group after the playoff exists is refused like any group change.
  const ls = await lines(groupTies[0].id)
  await assert.rejects(score(ls[2].id, B_WINS), /downstreamStarted/)
})

test('lists count ties, not lines; a changed tie side replaces unplayed lines', async () => {
  const t = await teamTournament({ format: 'single_elimination', tie: { lines: ['XS', 'XS', 'AD'] } })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', "select generate_bracket($1,'manual')", [t.id])
  const list = (await asActor(ctx, 'owner', 'select list_my_tournaments() l')).rows[0].l.find(x => x.id === t.id)
  assert.equal(list.progress.matches, 3)
  const [tie] = (await ties(t.id)).filter(m => m.round_number === 1)
  await fullLineup(t, tie, 'A', { submit: true })
  const before = (await lines(tie.id)).map(l => l.id)
  await ctx.db.query('update matches set side_a_entry_id=$2 where id=$1', [tie.id, t.entries[3] === tie.side_b_entry_id ? t.entries[2] : t.entries[3]])
  const afterIds = (await lines(tie.id)).map(l => l.id)
  assert.equal(afterIds.length, 3)
  assert.ok(afterIds.every(id => !before.includes(id)))
  assert.equal((await ctx.db.query('select count(*)::int n from tie_lineups where tie_id=$1', [tie.id])).rows[0].n, 0)
  assert.equal((await ctx.db.query('select count(*)::int n from tie_lineup_submissions where tie_id=$1', [tie.id])).rows[0].n, 0)
})

test('the team migration replays cleanly', async () => {
  await reapplyForwardMigrations(ctx)
  const t = await teamTournament({ tie: { lines: ['MS', 'WS', 'XD'] }, teams: 2 })
  await ctx.db.query("update tournaments set status='registration_closed' where id=$1", [t.id])
  await asActor(ctx, 'owner', 'select generate_round_robin($1)', [t.id])
  assert.equal((await lines((await ties(t.id))[0].id)).length, 3)
})
