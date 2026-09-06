import assert from 'node:assert/strict'
import { after,before,test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createDatabase,fixture,asActor,matches,snapshot,assertDeniedUnchanged,winningSets } from './helpers/database.mjs'
let ctx
before(async()=>{ctx=await createDatabase()})
after(async()=>{await ctx?.db.close()})
const sets=JSON.parse(winningSets), reversed=sets.map(r=>({...r,side_a_games:0,side_b_games:6}))
const row=async id=>(await ctx.db.query('select * from matches where id=$1',[id])).rows[0]
const live=async id=>(await ctx.db.query('select * from live_scores where match_id=$1',[id])).rows[0]
const save=async(id,result=sets)=>asActor(ctx,'owner','select update_match_sets($1,$2,$3)',[id,JSON.stringify(result),(await row(id)).score_revision])
const start=async id=>asActor(ctx,'counter','select start_live_match($1,$2)',[id,(await row(id)).score_revision])
const point=async id=>asActor(ctx,'counter',"select record_point($1,'a',$2)",[id,(await live(id)).revision])
const stop=async id=>asActor(ctx,'editor','select stop_live_match($1,$2)',[id,(await live(id)).revision])
async function draw(options={}) {
 const t=await fixture(ctx,options)
 await asActor(ctx,'owner',options.format==='round_robin'?'select generate_round_robin($1)':'select generate_bracket($1)',[t.id])
 return t
}
async function finish(t) {
 for(let i=0;i<80;i++) {
  const m=(await matches(ctx,t.id)).find(m=>m.status==='ready')
  if(!m)return
  await save(m.id)
 }
 throw Error('bracket failed to finish')
}
async function preview(id,result={sets:reversed},actor='owner') {
 const revision=(await row(id)).score_revision
 const p=(await asActor(ctx,actor,'select get_match_correction_preview($1,$2,$3) p',[id,JSON.stringify(result),revision])).rows[0].p
 return {...p,id,result,revision}
}
const apply=async(p,actor='owner')=>asActor(ctx,actor,'select apply_match_correction($1,$2,$3,$4)',[p.id,JSON.stringify(p.result),p.revision,p.token])
const drop=t=>ctx.db.query('delete from tournaments where id=$1',[t.id])

test('preview and cancellation leave all persisted data untouched; confirmation repairs a finished final',async()=>{
 const t=await draw();await finish(t)
 const [source,other,final]=(await matches(ctx,t.id))
 const before=await snapshot(ctx),p=await preview(source.id)
 assert.deepEqual(await snapshot(ctx),before)
 assert.equal(p.matches.length,1);assert.equal(p.matches[0].id,final.id);assert.equal(p.matches[0].has_result,true)
 const preserved=await row(other.id)
 await apply(p,'editor')
 assert.equal((await row(source.id)).winner_entry_id,source.side_b_entry_id)
 const f=await row(final.id)
 assert.equal(f.winner_entry_id,null);assert.equal(f.side_a_score,null);assert.equal(f.status,'ready')
 assert.ok([f.side_a_entry_id,f.side_b_entry_id].includes(source.side_b_entry_id))
 assert.deepEqual(await row(other.id),preserved)
 assert.equal((await ctx.db.query('select count(*) n from match_sets where match_id=$1',[final.id])).rows[0].n,0)
 await finish(t);assert.equal((await row(final.id)).status,'finished');await drop(t)
})

test('same-winner edits preserve scored descendants; unconfirmed winner changes still fail',async()=>{
 const t=await draw();await finish(t)
 const ms=await matches(ctx,t.id),source=ms[0],final=ms.at(-1),saved=await row(final.id)
 await save(source.id,sets.map(s=>({...s,side_b_games:4})))
 assert.deepEqual(await row(final.id),saved)
 await assertDeniedUnchanged(ctx,'owner','select update_match_sets($1,$2,$3)',[source.id,JSON.stringify(reversed),(await row(source.id)).score_revision],/downstreamStarted/)
 await drop(t)
})

test('double elimination resets winner AND loser branches, including their common grand final, once',async()=>{
 for(const count of [2,4,8,16]) {
  const t=await draw({format:'double_elimination',count});await finish(t)
  const source=(await matches(ctx,t.id)).find(m=>m.stage==='winners'&&m.round_number===1)
  const p=await preview(source.id)
  assert.equal(new Set(p.matches.map(m=>m.id)).size,p.matches.length)
  assert.ok(p.matches.some(m=>m.id===source.next_match_id));assert.ok(p.matches.some(m=>m.id===source.loser_next_match_id))
  assert.ok(p.matches.some(m=>m.stage==='grand_final'))
  const all=await matches(ctx,t.id),affected=new Set(p.matches.map(m=>m.id))
  const independent=all.filter(m=>m.id!==source.id&&!affected.has(m.id))
  await apply(p)
  for(const m of independent)assert.deepEqual(await row(m.id),m)
  for(const d of p.matches){const m=await row(d.id);assert.equal(m.winner_entry_id,null);assert.equal(m.side_a_score,null);assert.notEqual(m.status,'finished')}
  await finish(t)
  const final=(await matches(ctx,t.id)).find(m=>m.stage==='grand_final')
  assert.equal(final.status,'finished')
  await drop(t)
 }
})

test('active downstream LIVE blocks even a confirmed correction; stopping preserves data until confirmation',async()=>{
 const t=await draw();for(const m of (await matches(ctx,t.id)).filter(m=>m.round_number===1))await save(m.id)
 const source=(await matches(ctx,t.id))[0],final=(await matches(ctx,t.id)).at(-1)
 await start(final.id);await point(final.id)
 const active=await preview(source.id),before=await snapshot(ctx)
 assert.equal(active.blocked_live,true)
 await assert.rejects(apply(active),/correctionLive/);assert.deepEqual(await snapshot(ctx),before)
 await stop(final.id)
 const old=await live(final.id),p=await preview(source.id)
 await apply(p)
 const l=await live(final.id);assert.equal(l.status,'stopped');assert.deepEqual(l.history,[]);assert.equal(l.state.points.a,0);assert.ok(l.revision>old.revision)
 await start(final.id)
 await assertDeniedUnchanged(ctx,'counter',"select record_point($1,'a',$2)",[final.id,old.revision],/liveConflict/)
 await assertDeniedUnchanged(ctx,'owner','select stop_live_match($1,$2)',[final.id,old.revision],/liveConflict/)
 await drop(t)
})

test('a changed descendant invalidates confirmation without changing the source',async()=>{
 const t=await draw();await finish(t);const ms=await matches(ctx,t.id),p=await preview(ms[0].id)
 await save(ms.at(-1).id,sets.map(s=>({...s,side_b_games:1})))
 const before=await snapshot(ctx);await assert.rejects(apply(p),/correctionConflict/);assert.deepEqual(await snapshot(ctx),before)
 await apply(await preview(ms[0].id));await drop(t)
})

test('source version, payload substitution, missing token and replay all fail atomically',async()=>{
 const t=await draw();await finish(t);const m=(await matches(ctx,t.id))[0],p=await preview(m.id)
 for(const altered of [{...p,token:null},{...p,token:'made-up'},{...p,result:{sets}},{...p,revision:p.revision-1}]) {
  const before=await snapshot(ctx);await assert.rejects(apply(altered),/conflict|correctionConflict/);assert.deepEqual(await snapshot(ctx),before)
 }
 await apply(p);const before=await snapshot(ctx);await assert.rejects(apply(p),/conflict/);assert.deepEqual(await snapshot(ctx),before);await drop(t)
})

test('correction RPC revalidates malformed results and rolls back all proposed resets',async()=>{
 const t=await draw();await finish(t);const m=(await matches(ctx,t.id))[0]
 for(const result of [{sets:[]},{sets:[{set_index:1,side_a_games:7,side_b_games:0}]},{sets:null},{sets:[{set_index:1,side_a_games:1,side_b_games:0}]}]) {
  const p=await preview(m.id,result),before=await snapshot(ctx)
  await assert.rejects(apply(p));assert.deepEqual(await snapshot(ctx),before)
 }
 await drop(t)
})

test('private/public previews and correction writes are restricted to owner/editor; helpers are closed',async()=>{
 const t=await draw({isPublic:true});await finish(t);const m=(await matches(ctx,t.id))[0],p=await preview(m.id)
 for(const actor of ['anon','outsider','counter','platform_admin']) {
  await assertDeniedUnchanged(ctx,actor,'select get_match_correction_preview($1,$2,$3)',[m.id,JSON.stringify(p.result),p.revision])
  await assertDeniedUnchanged(ctx,actor,'select apply_match_correction($1,$2,$3,$4)',[m.id,JSON.stringify(p.result),p.revision,p.token])
 }
 for(const sql of ['select correction_descendants($1)','select reset_correction_descendants($1)','select write_match_sets_result($1,$2,$3,true)']) {
  for(const actor of ['anon','owner','editor'])await assertDeniedUnchanged(ctx,actor,sql,sql.includes('$2')?[m.id,winningSets,p.revision]:[m.id],/permission denied/)
 }
 await drop(t)
})

test('foreign and cyclic graph links fail before changing any score',async()=>{
 const t=await draw(),other=await draw();await finish(t)
 const m=(await matches(ctx,t.id))[0],final=(await matches(ctx,t.id)).at(-1)
 await ctx.db.query('update matches set next_match_id=$2 where id=$1',[final.id,m.id])
 const before=await snapshot(ctx);await assert.rejects(preview(m.id),/invalidGraph/);assert.deepEqual(await snapshot(ctx),before)
 await ctx.db.query('update matches set next_match_id=$2 where id=$1',[final.id,(await matches(ctx,other.id))[0].id])
 await assert.rejects(preview(m.id),/invalidGraph/)
 await drop(t);await drop(other)
})

test('football correction clears dependent goals AND penalties, and preserves an independent opponent',async()=>{
 const t=await draw({sport:'football'}),first=(await matches(ctx,t.id)).filter(m=>m.round_number===1)
 async function goals(id,a,b,pa=null,pb=null){await asActor(ctx,'owner','select update_football_result($1,$2,$3,$4,$5,$6)',[id,a,b,pa,pb,(await row(id)).score_revision])}
 for(const m of first)await goals(m.id,1,0)
 const final=(await matches(ctx,t.id)).at(-1);await goals(final.id,1,1,5,4)
 const result={a_goals:0,b_goals:1,a_pens:null,b_pens:null}
 await apply(await preview(first[0].id,result))
 const f=await row(final.id)
 for(const key of ['side_a_score','side_b_score','side_a_pens','side_b_pens','winner_entry_id'])assert.equal(f[key],null)
 assert.equal(f.status,'ready');await goals(f.id,2,0);await drop(t)
})

test('round robin correction changes standings and leaves every other match alone',async()=>{
 const t=await draw({format:'round_robin'});await finish(t)
 const ms=await matches(ctx,t.id),m=ms[0]
 const before=(await asActor(ctx,'owner','select * from get_standings($1)',[t.id])).rows
 await save(m.id,reversed)
 for(const other of ms.slice(1))assert.deepEqual(await row(other.id),other)
 const after=(await asActor(ctx,'owner','select * from get_standings($1)',[t.id])).rows
 assert.equal(after.find(x=>x.entry_id===m.side_b_entry_id).won,before.find(x=>x.entry_id===m.side_b_entry_id).won+1)
 await drop(t)
})

async function groupsFixture(){
 const t=await fixture(ctx,{format:'groups_playoff',count:8})
 await asActor(ctx,'owner','select generate_groups($1,2)',[t.id]);await finish(t)
 await asActor(ctx,'owner','select generate_group_playoff($1)',[t.id]);await finish(t)
 return t
}
test('group correction requires confirmation even with the same winner and rebuilds the full playoff',async()=>{
 const t=await groupsFixture(),ms=await matches(ctx,t.id),m=ms.find(m=>m.stage==='group'),result={sets:sets.map(s=>({...s,side_b_games:4}))}
 await assertDeniedUnchanged(ctx,'owner','select update_match_sets($1,$2,$3)',[m.id,JSON.stringify(result.sets),m.score_revision],/downstreamStarted/)
 const p=await preview(m.id,result);assert.equal(p.reseed_playoff,true)
 assert.equal(p.matches.length,ms.filter(m=>m.stage==='winners').length)
 await apply(p)
 for(const old of ms.filter(x=>x.stage==='group'&&x.id!==m.id))assert.deepEqual(await row(old.id),old)
 for(const old of ms.filter(x=>x.stage==='winners'))assert.equal(await row(old.id),undefined)
 assert.ok((await matches(ctx,t.id)).filter(x=>x.stage==='winners').every(x=>x.status!=='finished'))
 await finish(t);await drop(t)
})

test('another group correction invalidates the qualification preview; active playoff also blocks reseeding',async()=>{
 const t=await groupsFixture(),ms=await matches(ctx,t.id),m=ms.find(m=>m.stage==='group'),p=await preview(m.id)
 const other=ms.find(x=>x.stage==='group'&&x.id!==m.id)
 await apply(await preview(other.id))
 const before=await snapshot(ctx);await assert.rejects(apply(p),/correctionConflict/);assert.deepEqual(await snapshot(ctx),before)
 const active=(await matches(ctx,t.id)).find(x=>x.stage==='winners'&&x.status==='ready');await start(active.id)
 const newer=await preview(m.id);assert.equal(newer.blocked_live,true);await assert.rejects(apply(newer),/correctionLive/)
 await drop(t)
})

test('migration is repeatable without changing tournament data',async()=>{
 const t=await draw();await finish(t);const before=await snapshot(ctx)
 const sql=await readFile(new URL('../supabase/upgrades/20260906130008_safe_result_corrections.sql',import.meta.url),'utf8')
 const defs=async()=>(await ctx.db.query("select oid::regprocedure::text signature,pg_get_functiondef(oid) body,proacl::text from pg_proc where pronamespace='public'::regnamespace order by signature")).rows
 const previous=await defs()
 for(let i=0;i<2;i++){await ctx.db.exec(sql);assert.deepEqual(await snapshot(ctx),before);assert.deepEqual(await defs(),previous)}
 await drop(t)
})

test('a first result cannot overwrite a manually assigned, already scored descendant',async()=>{
 const t=await draw(),ms=await matches(ctx,t.id),m=ms[0],final=ms.at(-1)
 await ctx.db.query("update matches set side_a_entry_id=$2,side_b_entry_id=$3,status='ready' where id=$1",[final.id,m.side_a_entry_id,ms[1].side_a_entry_id])
 await save(final.id)
 await assertDeniedUnchanged(ctx,'owner','select update_match_sets($1,$2,$3)',[m.id,JSON.stringify(reversed),m.score_revision],/downstreamStarted/)
 await apply(await preview(m.id))
 const f=await row(final.id);assert.equal(f.winner_entry_id,null);assert.ok([f.side_a_entry_id,f.side_b_entry_id].includes(m.side_b_entry_id))
 await drop(t)
})

test('group winner correction replaces the actual qualifier in the new playoff',async()=>{
 const t=await fixture(ctx,{format:'groups_playoff',count:4})
 await ctx.db.query('update tournaments set format_config=$2 where id=$1',[t.id,JSON.stringify({advance_per_group:1})])
 await asActor(ctx,'owner','select generate_groups($1,2)',[t.id]);await finish(t)
 const m=(await matches(ctx,t.id))[0]
 await asActor(ctx,'owner','select generate_group_playoff($1)',[t.id]);await finish(t)
 const old=(await matches(ctx,t.id)).find(x=>x.stage==='winners')
 assert.ok([old.side_a_entry_id,old.side_b_entry_id].includes(m.side_a_entry_id))
 await apply(await preview(m.id))
 const next=(await matches(ctx,t.id)).find(x=>x.stage==='winners')
 assert.notEqual(next.id,old.id)
 assert.ok([next.side_a_entry_id,next.side_b_entry_id].includes(m.side_b_entry_id))
 assert.ok(![next.side_a_entry_id,next.side_b_entry_id].includes(m.side_a_entry_id))
 assert.equal(next.status,'ready');await finish(t);await drop(t)
})
