import assert from 'node:assert/strict'
import { after,before,test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createDatabase,fixture,asActor,matches,snapshot,assertDeniedUnchanged,winningSets,seedPartialScore } from './helpers/database.mjs'
let ctx
before(async()=>{ctx=await createDatabase()})
after(async()=>{await ctx?.db.close()})
const rows=JSON.parse(winningSets)
const reverse=rows.map(r=>({...r,side_a_games:0,side_b_games:6}))
const match=async id=>(await ctx.db.query('select * from matches where id=$1',[id])).rows[0]
const live=async id=>(await ctx.db.query('select * from live_scores where match_id=$1',[id])).rows[0]
async function draw(options={}){const t=await fixture(ctx,options);await asActor(ctx,'owner','select generate_bracket($1)',[t.id]);return {...t,m:(await matches(ctx,t.id)).find(m=>m.status==='ready')}}
const drop=t=>ctx.db.query('delete from tournaments where id=$1',[t.id])
async function save(id,sets=rows,revision,actor='owner'){return asActor(ctx,actor,'select update_match_sets($1,$2,$3)',[id,JSON.stringify(sets),revision??(await match(id)).score_revision])}
async function start(id,revision){return asActor(ctx,'counter','select start_live_match($1,$2)',[id,revision??(await match(id)).score_revision])}
async function stop(id,revision,actor='owner'){return asActor(ctx,actor,'select stop_live_match($1,$2)',[id,revision??(await live(id)).revision])}
async function point(id,side='a',revision){return asActor(ctx,'counter','select record_point($1,$2,$3)',[id,side,revision??(await live(id)).revision])}

test('manual completion is atomic and a second editor cannot overwrite its version',async()=>{
 const t=await draw(),version=t.m.score_revision
 await save(t.m.id,rows,version)
 const m=await match(t.m.id);assert.equal(m.status,'finished');assert.equal(m.side_a_score,2);assert.equal(m.winner_entry_id,t.m.side_a_entry_id)
 await assertDeniedUnchanged(ctx,'editor','select update_match_sets($1,$2,$3)',[m.id,JSON.stringify(reverse),version],/conflict/)
 await save(m.id,reverse,m.score_revision,'editor');assert.equal((await match(m.id)).side_b_score,2)
 await drop(t)
})
test('active LIVE rejects manual completion and does not lose even an in-game point',async()=>{
 const t=await draw(),old=t.m.score_revision
 await start(t.m.id);await point(t.m.id)
 for(const actor of ['owner','editor'])await assertDeniedUnchanged(ctx,actor,'select update_match_sets($1,$2,$3)',[t.m.id,winningSets,old],/liveBlocked/)
 assert.equal((await live(t.m.id)).state.points.a,1)
 assert.ok((await match(t.m.id)).score_revision>old)
 await drop(t)
})
test('missing/null versions fail closed for every scoring mutation',async()=>{
 const t=await draw();await start(t.m.id)
 const calls=[['select record_point($1,\'a\')','liveConflict'],['select stop_live_match($1)','liveConflict'],['select start_live_match($1)','conflict']]
 for(const [sql,message]of calls)await assertDeniedUnchanged(ctx,'owner',sql,[t.m.id],new RegExp(message))
 await stop(t.m.id)
 await assertDeniedUnchanged(ctx,'owner','select update_match_sets($1,$2)',[t.m.id,winningSets],/conflict/)
 await drop(t)
})
test('only organiser/editor can stop LIVE; stop preserves points, winner and sets',async()=>{
 const t=await draw();await start(t.m.id);await point(t.m.id)
 const prev=await live(t.m.id)
 await assertDeniedUnchanged(ctx,'counter','select stop_live_match($1,$2)',[t.m.id,prev.revision],/Not allowed/)
 await stop(t.m.id,prev.revision,'editor')
 const stopped=await live(t.m.id);assert.equal(stopped.status,'stopped');assert.deepEqual(stopped.state,prev.state);assert.deepEqual(stopped.history,prev.history)
 assert.equal((await match(t.m.id)).winner_entry_id,null)
 await assertDeniedUnchanged(ctx,'counter','select record_point($1,$2,$3)',[t.m.id,'a',stopped.revision],/resumeRequired/)
 await drop(t)
})
test('stop/resume fences delayed points, delayed stops and delayed resume requests',async()=>{
 const t=await draw();await start(t.m.id);await point(t.m.id)
 const oldLive=await live(t.m.id),oldMatch=await match(t.m.id)
 await stop(t.m.id);const stoppedMatch=await match(t.m.id);await start(t.m.id,stoppedMatch.score_revision)
 assert.deepEqual((await live(t.m.id)).state,oldLive.state)
 await assertDeniedUnchanged(ctx,'counter','select record_point($1,$2,$3)',[t.m.id,'a',oldLive.revision],/liveConflict/)
 await assertDeniedUnchanged(ctx,'owner','select stop_live_match($1,$2)',[t.m.id,oldLive.revision],/liveConflict/)
 await assertDeniedUnchanged(ctx,'counter','select start_live_match($1,$2)',[t.m.id,oldMatch.score_revision],/conflict/)
 await drop(t)
})
test('point RPC cannot implicitly create or resume a session',async()=>{
 const t=await draw()
 await assertDeniedUnchanged(ctx,'counter','select record_point($1,$2,$3)',[t.m.id,'a',0],/resumeRequired/)
 assert.equal(await live(t.m.id),undefined)
 await drop(t)
})
test('manual final after stopping LIVE replaces its baseline and closes history',async()=>{
 const t=await draw();await start(t.m.id);await point(t.m.id);await stop(t.m.id)
 const old=(await live(t.m.id)).revision;await save(t.m.id)
 const l=await live(t.m.id);assert.equal(l.status,'finished');assert.deepEqual(l.history,[]);assert.equal(l.state.winner,'a')
 await assertDeniedUnchanged(ctx,'counter','select record_point($1,$2,$3)',[t.m.id,'a',old],/liveConflict/)
 await assert.rejects(start(t.m.id),/finished/)
 await drop(t)
})
test('manual empty and partial results never mark a match finished',async()=>{
 const t=await draw()
 for(const sets of [[],rows.slice(0,1),[{set_index:1,side_a_games:3,side_b_games:2}]]){
  await assertDeniedUnchanged(ctx,'owner','select update_match_sets($1,$2,$3)',[t.m.id,JSON.stringify(sets),t.m.score_revision],/finalRequired/)
 }
 await drop(t)
})
test('LIVE and manual finishing produce identical scores, winner and standings',async()=>{
 for(const mode of ['live','manual']){
  const t=await draw({count:2,format:'round_robin'})
  if(mode==='manual')await save(t.m.id)
  else {await start(t.m.id);for(let i=0;i<48;i++)await point(t.m.id)}
  const m=await match(t.m.id)
  assert.equal(m.status,'finished');assert.equal(m.side_a_score,2);assert.equal(m.side_b_score,0);assert.equal(m.winner_entry_id,m.side_a_entry_id)
  const standings=(await asActor(ctx,'owner','select * from get_standings($1)',[t.id])).rows
  assert.equal(standings.find(r=>r.entry_id===m.side_a_entry_id).score_for,2)
  await drop(t)
 }
})
test('same winner correction leaves a downstream LIVE untouched; winner changes are blocked',async()=>{
 const t=await draw();for(const m of (await matches(ctx,t.id)).filter(m=>m.round_number===1))await save(m.id)
 const final=(await matches(ctx,t.id)).find(m=>m.round_number===2)
 await start(final.id);await point(final.id)
 const downstream={m:await match(final.id),l:await live(final.id)}
 await save(t.m.id,rows.map(r=>({...r,side_b_games:4})))
 assert.deepEqual({m:await match(final.id),l:await live(final.id)},downstream)
 await assert.rejects(save(t.m.id,reverse),/downstreamStarted/)
 await drop(t)
})
test('loser branch activity also blocks correcting an upstream winner',async()=>{
 const t=await draw({format:'double_elimination'})
 const initial=(await matches(ctx,t.id)).filter(m=>m.stage==='winners'&&m.round_number===1)
 for(const m of initial)await save(m.id)
 const lower=await match(t.m.loser_next_match_id);await start(lower.id);await point(lower.id,'b')
 const before=await snapshot(ctx)
 await assert.rejects(save(t.m.id,reverse),/downstreamStarted/)
 assert.deepEqual(await snapshot(ctx),before)
 await drop(t)
})
test('direct resets and deletion of individual sets cannot bypass LIVE priority',async()=>{
 const t=await draw();await start(t.m.id);await point(t.m.id)
 for(const sql of ["update matches set status='ready',winner_entry_id=null where id=$1","delete from match_sets where match_id=$1"]){
  await assertDeniedUnchanged(ctx,'owner',sql,[t.m.id],/permission denied/)
 }
 await drop(t)
})
test('snapshot is accessible to counters but not foreign users and includes coherent versions',async()=>{
 const t=await draw();await start(t.m.id);await point(t.m.id)
 const data=(await asActor(ctx,'counter','select get_tournament_score_state($1) state',[t.id])).rows[0].state
 assert.equal(data.matches.find(m=>m.id===t.m.id).score_revision,(await match(t.m.id)).score_revision)
 assert.equal(data.live[0].state.points.a,1)
 for(const who of ['outsider','platform_admin','anon'])await assertDeniedUnchanged(ctx,who,'select get_tournament_score_state($1)',[t.id])
 await drop(t)
})
test('football final results also reject stale edits',async()=>{
 const t=await draw({sport:'football'}),v=t.m.score_revision
 await asActor(ctx,'owner','select update_football_result($1,2,0,null,null,$2)',[t.m.id,v])
 await assertDeniedUnchanged(ctx,'editor','select update_football_result($1,0,2,null,null,$2)',[t.m.id,v],/conflict/)
 await drop(t)
})
test('new migration can be applied twice without changing data or effective definitions/ACLs',async()=>{
 const t=await draw();await start(t.m.id);await point(t.m.id)
 const before=await snapshot(ctx)
 const defs=async()=>(await ctx.db.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proowner,proacl::text from pg_proc where pronamespace='public'::regnamespace order by signature")).rows
 const sql=await readFile(new URL('../supabase/upgrades/20260906114558_prioritize_live_scoring.sql',import.meta.url),'utf8')
 // A historical migration is compared with its own first application. Later
 // migrations intentionally supersede some of these function definitions.
 await ctx.db.exec(sql);assert.deepEqual(await snapshot(ctx),before)
 const original=await defs()
 await ctx.db.exec(sql);assert.deepEqual(await snapshot(ctx),before);assert.deepEqual(await defs(),original)
 await drop(t)
})

test('legacy repair updates only derived totals confirmed by sets and LIVE and is repeatable',async()=>{
 const t=await draw();await start(t.m.id)
 for(let i=0;i<24;i++)await point(t.m.id)
 const l=await live(t.m.id),sets=(await ctx.db.query('select * from match_sets where match_id=$1',[t.m.id])).rows
 await ctx.db.query('update matches set side_a_score=0,side_b_score=null where id=$1',[t.m.id])
 const sql=await readFile(new URL('../supabase/maintenance/repair_live_aggregates.sql',import.meta.url),'utf8')
 await ctx.db.exec(sql)
 assert.equal((await match(t.m.id)).side_a_score,1);assert.equal((await match(t.m.id)).side_b_score,0)
 assert.deepEqual(await live(t.m.id),l)
 assert.deepEqual((await ctx.db.query('select * from match_sets where match_id=$1',[t.m.id])).rows,sets)
 const repaired=await snapshot(ctx);await ctx.db.exec(sql);assert.deepEqual(await snapshot(ctx),repaired)
 // Ambiguous stored winner is never silently changed or used to repair totals.
 await ctx.db.query('update matches set side_a_score=0,winner_entry_id=side_b_entry_id where id=$1',[t.m.id])
 const ambiguous=await snapshot(ctx);await ctx.db.exec(sql);assert.deepEqual(await snapshot(ctx),ambiguous)
 await drop(t)
})
