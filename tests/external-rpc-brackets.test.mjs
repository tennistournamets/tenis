import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { createDatabase, asActor, fixture, matches, snapshot, assertDeniedUnchanged } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })
const denied = ['anon', 'outsider', 'counter', 'platform_admin']
const managers = ['owner', 'editor']
async function bracket(options = {}) {
  const t = await fixture(ctx, options)
  await asActor(ctx, options.owner || 'owner', 'select generate_bracket($1)', [t.id])
  return { ...t, rows: await matches(ctx, t.id) }
}
const item = (m, a = m.side_a_entry_id, b = m.side_b_entry_id) => ({ match_id: m.id, side_a_entry_id: a, side_b_entry_id: b })
const layout = (actor, id, data) => asActor(ctx, actor, 'select apply_bracket_layout($1,$2::jsonb)', [id, JSON.stringify(data)])

test('management RPCs reject all non-manager roles before altering brackets, groups or versions', async () => {
  const t = await bracket()
  const [a,b] = t.rows.filter(m => m.round_number === 1)
  for (const actor of denied) {
    for (const [sql, params] of [
      ['select generate_bracket($1)', [t.id]],
      ['select rebuild_bracket($1)', [t.id]],
      ['select generate_round_robin($1)', [t.id]],
      ['select generate_groups($1,2)', [t.id]],
      ['select generate_group_playoff($1)', [t.id]],
      ['select apply_bracket_layout($1,$2::jsonb)', [t.id, JSON.stringify([item(a)])]],
      ["select swap_bracket_slots($1,$2,'A',$3,'B')", [t.id,a.id,b.id]],
    ]) await assertDeniedUnchanged(ctx, actor, sql, params)
  }
})

test('managers cannot use a tournament they own to target matches from another tournament', async () => {
  const own = await bracket()
  const foreign = await bracket({owner:'outsider'})
  for (const actor of managers) {
    await assertDeniedUnchanged(ctx,actor,'select rebuild_bracket($1)',[foreign.id])
    await assertDeniedUnchanged(ctx,actor,'select apply_bracket_layout($1,$2::jsonb)',[own.id,JSON.stringify([item(foreign.rows[0])])],/tournament/)
    await assertDeniedUnchanged(ctx,actor,"select swap_bracket_slots($1,$2,'A',$3,'B')",[own.id,own.rows[0].id,foreign.rows[0].id],/tournament/)
  }
})

test('manual generation and rebuild preserve the UI null-order contract and explicit partial order', async () => {
  for (const actor of managers) {
    const t = await fixture(ctx)
    await asActor(ctx,actor,"select generate_bracket($1,'manual',null)",[t.id])
    assert.equal((await matches(ctx,t.id)).length,3)
    const order = [t.entries[3],t.entries[1]]
    await asActor(ctx,actor,"select rebuild_bracket($1,'manual',$2::uuid[])",[t.id,order])
    const first = (await matches(ctx,t.id)).find(m => m.round_number===1 && m.match_number===1)
    assert.deepEqual([first.side_a_entry_id,first.side_b_entry_id],order)
    await asActor(ctx,actor,"select rebuild_bracket($1,'manual',null)",[t.id])
    assert.equal((await matches(ctx,t.id)).length,3)
  }
})

test('foreign, null, duplicate and unapproved manual-order entries fail without deleting existing results or snapshots', async () => {
  const t = await bracket()
  const foreign = await fixture(ctx,{owner:'outsider'})
  const pending = await fixture(ctx)
  await ctx.db.query("update entries set status='pending' where id=$1",[pending.entries[0]])
  for (const order of [[foreign.entries[0]],[null],[t.entries[0],t.entries[0]],[pending.entries[0]],[[t.entries[0],t.entries[1]]]]) {
    await assertDeniedUnchanged(ctx,'owner',"select rebuild_bracket($1,'manual',$2::uuid[])",[t.id,order],/Manual order/)
  }
  await assertDeniedUnchanged(ctx,'owner','select rebuild_bracket($1,null,null)',[t.id],/Draw mode/)
})

test('layout validates every participant and item before changing any match', async () => {
  const t = await bracket()
  const foreign = await fixture(ctx,{owner:'outsider'})
  const [a,b] = t.rows.filter(m => m.round_number===1)
  const good = item(a,a.side_b_entry_id,a.side_a_entry_id)
  const badLayouts = [null,{},[null],[{}],[{match_id:a.id}],
    [item({...a,id:null})],[item({...a,id:randomUUID()})],
    [good,item(b,foreign.entries[0])],[good,item(b,randomUUID())],
    [good,good],[item(a,a.side_a_entry_id,a.side_a_entry_id)]]
  for (const data of badLayouts) {
    await assertDeniedUnchanged(ctx,'editor','select apply_bracket_layout($1,$2::jsonb)',[t.id,JSON.stringify(data)],/Layout|layout|Participant|participant|Match|match/)
  }
  await ctx.db.query("update entries set status='pending' where id=$1",[a.side_a_entry_id])
  await assertDeniedUnchanged(ctx,'owner','select apply_bracket_layout($1,$2::jsonb)',[t.id,JSON.stringify([good])],/approved/)
})

test('owner/editor can save layout swaps and explicit empty slots and use valid slot swaps', async () => {
  for (const actor of managers) {
    const t = await bracket()
    const [a,b] = t.rows.filter(m => m.round_number===1)
    await layout(actor,t.id,[item(a,b.side_a_entry_id,a.side_b_entry_id),item(b,a.side_a_entry_id,b.side_b_entry_id)])
    assert.equal((await matches(ctx,t.id)).find(m=>m.id===a.id).side_a_entry_id,b.side_a_entry_id)
    await asActor(ctx,actor,"select swap_bracket_slots($1,$2,' a ',$3,'b')",[t.id,a.id,b.id])
    await asActor(ctx,actor,"select swap_bracket_slots($1,$2,'A',$2,'B')",[t.id,a.id])
    await layout(actor,t.id,[item(a,null,null)])
    const empty = (await matches(ctx,t.id)).find(m=>m.id===a.id)
    assert.equal(empty.status,'pending')
    assert.equal(empty.side_a_entry_id,null)
  }
})

test('null, invalid, missing and foreign slot-swap inputs leave matches unchanged', async () => {
  const t = await bracket()
  const [a,b] = t.rows.filter(m=>m.round_number===1)
  for (const slots of [[null,'A'],['A',null],['C','A'],['','B']]) {
    await assertDeniedUnchanged(ctx,'owner','select swap_bracket_slots($1,$2,$3,$4,$5)',[t.id,a.id,slots[0],b.id,slots[1]],/Invalid slot/)
  }
  for (const id of [null,randomUUID()]) {
    await assertDeniedUnchanged(ctx,'owner',"select swap_bracket_slots($1,$2,'A',$3,'B')",[t.id,a.id,id],/Match not found/)
  }
})

test('direct graph/group/live writes stay closed even with administrator membership', async () => {
  const t = await bracket()
  const id = t.rows[0].id
  for (const actor of ['anon','owner','editor','counter','outsider','platform_admin']) {
    for (const [sql,params] of [
      ["insert into groups(tournament_id,name,group_index) values ($1,'Extra',0)",[t.id]],
      ['insert into group_entries(group_id,entry_id) values ($1,$2)',[randomUUID(),t.entries[0]]],
      ["update groups set tournament_id=$1",[t.id]],
      ['update group_entries set entry_id=$1',[t.entries[0]]],
      ['delete from groups',[]],['delete from group_entries',[]],
      ['update live_scores set match_id=$1',[id]],['delete from live_scores',[]],
      ['insert into match_sets(match_id,set_index,side_a_games,side_b_games) values($1,1,6,0)',[id]],
      ['update match_sets set match_id=$1',[id]],
      ['update entries set tournament_id=$1 where id=$2',[t.id,t.entries[0]]],
      ['update entries set id=$1 where id=$2',[randomUUID(),t.entries[0]]],
    ]) await assertDeniedUnchanged(ctx,actor,sql,params)
  }
})

test('direct entry approval, admin insertion and bracket deletion used by the UI remain available', async () => {
  for (const actor of managers) {
    const t = await bracket()
    await asActor(ctx,actor,"update entries set status='pending' where id=$1",[t.entries[0]])
    await asActor(ctx,actor,"update entries set status='approved' where id=$1",[t.entries[0]])
    const {rows} = await asActor(ctx,actor,`insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
      values ($1,'singles','Extra','extra@example.test','approved') returning id`,[t.id])
    await asActor(ctx,actor,"insert into entry_members(entry_id,member_name,member_order) values($1,'Extra',1)",[rows[0].id])
    await assertDeniedUnchanged(ctx,actor,'delete from match_sets where match_id=$1',[t.rows[0].id],/permission denied/)
    await asActor(ctx,actor,'delete from matches where tournament_id=$1',[t.id])
    assert.equal((await matches(ctx,t.id)).length,0)
  }
  const t = await bracket()
  for (const actor of denied) {
    const original=await snapshot(ctx)
    await asActor(ctx,actor,"update entries set status='pending' where id=$1",[t.entries[0]]).catch(error=>assert.equal(error.code,'42501'))
    await asActor(ctx,actor,'delete from matches where tournament_id=$1',[t.id])
    assert.deepEqual(await snapshot(ctx),original)
  }
})

test('layout handles pre-existing reset data with one participant in different rounds', async () => {
  const t=await bracket()
  const semis=t.rows.filter(m=>m.round_number===1)
  const sets=JSON.stringify([1,2].map(set_index=>({set_index,side_a_games:6,side_b_games:0})))
  for (const m of semis) await asActor(ctx,'owner','select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))',[m.id,sets])
  // Privileged fixture models old reset data; this direct client path is now closed.
  for (const m of semis) await ctx.db.query('delete from match_sets where match_id=$1',[m.id])
  await ctx.db.query("update matches set winner_entry_id=null,status='ready' where tournament_id=$1 and status<>'pending'",[t.id])
  const current=await matches(ctx,t.id)
  const final=current.find(m=>m.round_number===2)
  const semi=current.find(m=>m.id===semis[0].id)
  await layout('editor',t.id,[item(semi,semi.side_b_entry_id,semi.side_a_entry_id),item(final,final.side_b_entry_id,final.side_a_entry_id)])
  assert.equal((await matches(ctx,t.id)).find(m=>m.id===final.id).side_b_entry_id,final.side_a_entry_id)
})
