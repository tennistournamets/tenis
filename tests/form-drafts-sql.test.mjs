import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createDatabase, fixture, asActor, matches, snapshot, assertDeniedUnchanged, winningSets } from './helpers/database.mjs'
let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })
const row = async id => (await ctx.db.query('select * from tournaments where id=$1', [id])).rows[0]
const state = async (id, actor='owner') => (await asActor(ctx, actor, 'select get_tournament_entry_state($1) s', [id])).rows[0].s
const drop = t => ctx.db.query('delete from tournaments where id=$1', [t.id])
const update = async (t, patch, revision, expected=null, actor='owner') => asActor(ctx, actor, 'select update_tournament_settings($1,$2,$3,$4)', [t.id, JSON.stringify(patch), revision, JSON.stringify(expected)])
const layout = (t, payload, expected) => asActor(ctx,'editor','select save_bracket_layout($1,$2,$3)',[t.id,JSON.stringify(payload),JSON.stringify(expected)])
const pairSave = (t, pairs, replace, s, actor='owner') => asActor(ctx,actor,'select save_tournament_pairs($1,$2,$3,$4,$5,$6)',[t.id,JSON.stringify(pairs),replace,JSON.stringify(s.entries),JSON.stringify(s.matches),s.settings_revision])
const mids = s => s.entries.flatMap(e => e.entry_members.map(m => m.id))
async function draw() { const t=await fixture(ctx,{status:'registration_closed'}); await asActor(ctx,'owner','select generate_bracket($1)',[t.id]);return t }

test('settings CAS prevents a second editor overwriting the first and trigger defeats submitted versions', async () => {
  const t=await fixture(ctx,{status:'registration_closed'}), base=await row(t.id)
  await update(t,{name:'First editor'},base.settings_revision,null,'editor')
  const saved=await row(t.id); assert.equal(saved.name,'First editor');assert.equal(saved.settings_revision,base.settings_revision+1)
  const before=await snapshot(ctx)
  await assert.rejects(update(t,{name:'Stale editor'},base.settings_revision),/drafts.conflict/)
  assert.deepEqual(await snapshot(ctx),before)
  await ctx.db.query('update tournaments set settings_revision=-999 where id=$1',[t.id])
  assert.equal((await row(t.id)).settings_revision,saved.settings_revision+1)
  await drop(t)
})
test('settings whitelist, validation and missing revision reject the entire write', async () => {
  const t=await fixture(ctx,{status:'registration_closed'}), rev=(await row(t.id)).settings_revision
  for(const patch of [{name:''},{created_by:ctx.actors.outsider},{settings_revision:100},{id:ctx.actors.owner},[],null,{scoring_config:null},{is_public:null}]) {
    const before=await snapshot(ctx);await assert.rejects(update(t,patch,rev));assert.deepEqual(await snapshot(ctx),before)
  }
  await assert.rejects(update(t,{name:'Missing revision'},null),/drafts.conflict/);await drop(t)
})
test('category changes and bracket reset are atomic; stale layouts cannot authorize deletion', async () => {
  const t=await draw(), s=await state(t.id), ms=await matches(ctx,t.id)
  await ctx.db.query('update matches set side_a_score=0 where id=$1',[ms[0].id])
  const before=await snapshot(ctx)
  await assert.rejects(update(t,{category:'doubles',doubles_pairing_mode:'pre_agreed'},s.settings_revision,s.matches),/structureConflict/)
  assert.deepEqual(await snapshot(ctx),before)
  const current=await state(t.id)
  await update(t,{category:'doubles',doubles_pairing_mode:'pre_agreed'},current.settings_revision,current.matches)
  assert.equal((await row(t.id)).category,'doubles');assert.equal((await matches(ctx,t.id)).length,0)
  await drop(t)
})
test('started or scored tournaments cannot change category even with an exact current version', async () => {
  const t=await draw(), ms=await matches(ctx,t.id)
  await update(t,{status:'in_progress'},(await row(t.id)).settings_revision)
  await asActor(ctx,'owner','select update_match_sets($1,$2,$3)',[ms[0].id,winningSets,ms[0].score_revision])
  const s=await state(t.id), before=await snapshot(ctx)
  await assert.rejects(update(t,{category:'doubles'},s.settings_revision,s.matches),/rulesLocked/)
  assert.deepEqual(await snapshot(ctx),before);await drop(t)
})
test('layout edits reject stale revisions and removed matches; valid edits preserve participants', async () => {
  const t=await draw(), s=await state(t.id), ms=(await matches(ctx,t.id)).filter(m=>m.round_number===1)
  const payload=ms.map((m,i)=>({match_id:m.id,side_a_entry_id:ms[1-i].side_a_entry_id,side_b_entry_id:m.side_b_entry_id}))
  await layout(t,payload,s.matches)
  const before=await snapshot(ctx);await assert.rejects(layout(t,payload,s.matches),/structureConflict/);assert.deepEqual(await snapshot(ctx),before)
  assert.deepEqual((await matches(ctx,t.id)).filter(m=>m.round_number===1).flatMap(m=>[m.side_a_entry_id,m.side_b_entry_id]).sort(),t.entries.sort())
  const fresh=await state(t.id)
  await ctx.db.query('delete from matches where tournament_id=$1',[t.id])
  await assert.rejects(layout(t,payload,fresh.matches),/structureConflict/);await drop(t)
})
test('entry state exposes safe member IDs, and counters see only approved entries', async () => {
  const t=await fixture(ctx)
  await ctx.db.query("update entries set status='pending' where id=$1",[t.entries[0]])
  const owner=await state(t.id), counter=await state(t.id,'counter')
  assert.equal(owner.entries.length,4);assert.equal(counter.entries.length,3)
  assert.ok(owner.entries.every(e=>e.entry_members[0].id))
  assert.ok(!/phone_or_email|player_id|contact|user_id/.test(JSON.stringify(owner)))
  for(const actor of ['anon','outsider','platform_admin'])await assertDeniedUnchanged(ctx,actor,'select get_tournament_entry_state($1)',[t.id])
  await drop(t)
})
test('pair creation and regrouping use member UUIDs with duplicate names and preserve player identity', async () => {
  const t=await fixture(ctx,{category:'doubles',pairing:'pick_random',status:'registration_closed',count:8})
  await ctx.db.query("update entry_members set member_name='Same Name' where entry_id=any($1::uuid[])",[t.entries])
  const player=(await ctx.db.query("insert into players(display_name) values ('Same Name') returning id")).rows[0].id
  let s=await state(t.id);const ids=mids(s)
  await ctx.db.query('update entry_members set player_id=$2 where id=$1',[ids[1],player])
  await pairSave(t,[[ids[0],ids[1]],[ids[2],ids[3]],[ids[4],ids[5]],[ids[6],ids[7]]],false,s)
  assert.equal((await state(t.id)).entries.length,4)
  await asActor(ctx,'owner','select generate_bracket($1)',[t.id]);s=await state(t.id)
  await pairSave(t,[[ids[1],ids[3]],[ids[0],ids[2]],[ids[4],ids[6]],[ids[5],ids[7]]],true,s,'editor')
  const after=await state(t.id);assert.equal(after.entries.length,4);assert.equal(after.matches.length,0)
  assert.deepEqual(mids(after).sort(),[...ids].sort())
  assert.equal((await ctx.db.query('select player_id from entry_members where id=$1',[ids[1]])).rows[0].player_id,player)
  const grouped=after.entries.find(e=>e.entry_members.some(m=>m.id===ids[1]))
  assert.deepEqual(grouped.entry_members.map(m=>m.id).sort(),[ids[1],ids[3]].sort());assert.ok(after.entries.every(e=>new Set(e.entry_members.map(m=>m.id)).size===2))
  await drop(t);await ctx.db.query('delete from players where id=$1',[player])
})
test('pair drafts detect entry, settings and bracket changes without partially splitting a pair', async () => {
  const t=await fixture(ctx,{category:'doubles',pairing:'pick_random',status:'registration_closed'})
  let s=await state(t.id),ids=mids(s)
  await pairSave(t,[[ids[0],ids[1]],[ids[2],ids[3]]],false,s)
  s=await state(t.id)
  await ctx.db.query("update entries set display_name='Changed' where id=$1",[s.entries[0].id])
  let before=await snapshot(ctx);await assert.rejects(pairSave(t,[[ids[0],ids[2]]],true,s),/structureConflict/);assert.deepEqual(await snapshot(ctx),before)
  s=await state(t.id);await update(t,{name:'Changed settings'},s.settings_revision)
  before=await snapshot(ctx);await assert.rejects(pairSave(t,[[ids[0],ids[2]]],true,s),/structureConflict/);assert.deepEqual(await snapshot(ctx),before)
  s=await state(t.id);await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
  before=await snapshot(ctx);await assert.rejects(pairSave(t,[[ids[0],ids[2]]],true,s),/structureConflict/);assert.deepEqual(await snapshot(ctx),before)
  await drop(t)
})
test('malformed, repeated, foreign or unavailable pair members cause no mutations', async () => {
  const t=await fixture(ctx,{category:'doubles',pairing:'pick_random',status:'registration_closed'}), other=await fixture(ctx)
  const s=await state(t.id), ids=mids(s), foreign=mids(await state(other.id))[0]
  for(const pairs of [[],null,{},[1],[[ids[0]]],[[null,ids[1]]],[[ids[0],ids[0]]],[[ids[0],ids[1]],[ids[0],ids[2]]],[[ids[0],foreign]],[[ids[0],'bad-uuid']]]) {
    const before=await snapshot(ctx);await assert.rejects(pairSave(t,pairs,true,s));assert.deepEqual(await snapshot(ctx),before)
  }
  await drop(t);await drop(other)
})
test('new write RPCs and internal snapshots enforce role boundaries', async () => {
  const t=await fixture(ctx,{category:'doubles',pairing:'pick_random',status:'registration_closed',isPublic:true}), s=await state(t.id), ids=mids(s)
  for(const actor of ['anon','outsider','counter','platform_admin']) {
    await assertDeniedUnchanged(ctx,actor,'select update_tournament_settings($1,$2,$3)',[t.id,'{"name":"Unauthorized"}',s.settings_revision])
    await assertDeniedUnchanged(ctx,actor,'select save_bracket_layout($1,$2,$3)',[t.id,'[]','[]'])
    const before=await snapshot(ctx);await assert.rejects(pairSave(t,[[ids[0],ids[1]]],false,s,actor));assert.deepEqual(await snapshot(ctx),before)
  }
  for(const actor of ['anon','owner','editor','counter'])for(const fn of ['tournament_match_versions','tournament_entry_snapshot']) {
    await assertDeniedUnchanged(ctx,actor,`select ${fn}($1)`,[t.id],/permission denied/)
  }
  await drop(t)
})
test('form draft migration is repeatable and preserves data and revisions', async () => {
  const t=await draw(), before=await snapshot(ctx)
  await ctx.db.exec(await readFile(new URL('../supabase/upgrades/20260906142758_protect_form_drafts.sql',import.meta.url),'utf8'))
  assert.deepEqual(await snapshot(ctx),before);await drop(t)
})
