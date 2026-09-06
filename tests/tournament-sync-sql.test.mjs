import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createDatabase, fixture, asActor, matches, snapshot, winningSets } from './helpers/database.mjs'
let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })
const state = async (id, actor = 'owner') => (await asActor(ctx, actor, 'select get_tournament_sync_state($1) s', [id])).rows[0].s
const drop = t => ctx.db.query('delete from tournaments where id=$1', [t.id])

test('snapshot preserves RLS: private roles, public readers, hidden/missing tournaments', async () => {
 const t = await fixture(ctx)
 for (const actor of ['owner','editor','counter']) assert.equal((await state(t.id,actor)).tournament.id,t.id)
 for (const actor of ['anon','outsider','platform_admin']) assert.equal(await state(t.id,actor),null)
 await ctx.db.query('update tournaments set is_public=true where id=$1',[t.id])
 for (const actor of ['anon','outsider','platform_admin']) assert.equal((await state(t.id,actor)).entries.length,4)
 await drop(t);assert.equal(await state(t.id),null)
})
test('safe entry projection excludes contacts/player IDs and respects approval; matches step 7 CAS shape', async () => {
 const t = await fixture(ctx,{isPublic:true})
 await ctx.db.query("update entries set status='pending' where id=$1",[t.entries[0]])
 const admin=await state(t.id), anon=await state(t.id,'anon'), counter=await state(t.id,'counter')
 assert.equal(admin.entries.length,4);assert.equal(anon.entries.length,3);assert.equal(counter.entries.length,3)
 for(const s of [admin,anon,counter]) assert.ok(!/phone_or_email|player_id|@example.test/.test(JSON.stringify(s)))
 const previous=(await asActor(ctx,'owner','select get_tournament_entry_state($1) s',[t.id])).rows[0].s
 assert.deepEqual([...admin.entries].sort((a,b)=>a.id.localeCompare(b.id)),previous.entries)
 await drop(t)
})
test('RR snapshot includes the completed match, its sets and updated ranking after save and correction', async () => {
 const t=await fixture(ctx,{format:'round_robin',isPublic:true})
 await asActor(ctx,'owner','select generate_round_robin($1)',[t.id])
 let m=(await matches(ctx,t.id))[0]
 await asActor(ctx,'editor','select update_match_sets($1,$2,$3)',[m.id,winningSets,m.score_revision])
 let s=await state(t.id,'anon')
 assert.equal(s.matches.find(x=>x.id===m.id).status,'finished');assert.equal(s.sets.length,2)
 assert.equal(s.standings.find(x=>x.entry_id===m.side_a_entry_id).points,1)
 m=(await matches(ctx,t.id)).find(x=>x.id===m.id)
 await asActor(ctx,'owner','select update_match_sets($1,$2,$3)',[m.id,JSON.stringify([{set_index:1,side_a_games:0,side_b_games:6},{set_index:2,side_a_games:0,side_b_games:6}]),m.score_revision])
 s=await state(t.id,'anon');assert.equal(s.standings.find(x=>x.entry_id===m.side_b_entry_id).points,1)
 assert.equal(s.standings.find(x=>x.entry_id===m.side_a_entry_id).points,0)
 await drop(t)
})
test('groups and their tables are replaced together on rebuild, with no orphan scores', async () => {
 const t=await fixture(ctx,{format:'groups_playoff',count:8,isPublic:true})
 await asActor(ctx,'owner','select generate_groups($1,$2)',[t.id,2])
 const s1=await state(t.id,'anon'),m=s1.matches[0]
 await asActor(ctx,'owner','select update_match_sets($1,$2,$3)',[m.id,winningSets,m.score_revision])
 const s2=await state(t.id,'anon')
 assert.equal(s2.group_standings[m.group_id].reduce((n,r)=>n+r.played,0),2)
 await asActor(ctx,'owner','select generate_groups($1,$2)',[t.id,2])
 const s3=await state(t.id,'anon')
 assert.ok(s3.groups.every(g=>!s1.groups.some(old=>old.id===g.id)))
 assert.deepEqual(Object.keys(s3.group_standings).sort(),s3.groups.map(g=>g.id).sort())
 assert.equal(s3.sets.length,0);assert.equal(s3.live.length,0)
 assert.ok(s3.matches.every(m=>s3.groups.some(g=>g.id===m.group_id)))
 await drop(t)
})
test('LIVE and match versions share the snapshot; delete/recreate leaves no former IDs', async () => {
 const t=await fixture(ctx,{isPublic:true})
 await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
 const m=(await matches(ctx,t.id))[0]
 await asActor(ctx,'counter','select start_live_match($1,$2)',[m.id,m.score_revision])
 let s=await state(t.id,'anon'),live=s.live[0]
 await asActor(ctx,'counter','select record_point($1,$2,$3)',[m.id,'a',live.revision])
 s=await state(t.id,'anon');assert.equal(s.live[0].state.points.a,1);assert.equal(s.live[0].revision,live.revision+1)
 await ctx.db.query('delete from matches where tournament_id=$1',[t.id])
 const empty=await state(t.id,'anon');assert.deepEqual([empty.matches,empty.sets,empty.live],[[],[],[]])
 await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
 assert.ok((await state(t.id,'anon')).matches.every(x=>!s.matches.some(y=>y.id===x.id)))
 await drop(t)
})
test('snapshot cannot include another tournament or foreign group and performs no writes', async () => {
 const a=await fixture(ctx,{format:'groups_playoff',isPublic:true}),b=await fixture(ctx,{isPublic:true})
 await asActor(ctx,'owner','select generate_groups($1,$2)',[a.id,2])
 await asActor(ctx,'owner','select generate_bracket($1)',[b.id])
 const before=await snapshot(ctx),s=await state(a.id,'anon')
 assert.ok(s.matches.every(m=>m.tournament_id===a.id));assert.ok(s.entries.every(e=>a.entries.includes(e.id)))
 assert.deepEqual(await snapshot(ctx),before);await drop(a);await drop(b)
})
test('saved LIVE sides survive points, stop/resume and public/admin snapshot reloads', async () => {
 const t=await fixture(ctx,{isPublic:true})
 await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
 const m=(await matches(ctx,t.id))[0]
 const rpc=async(sql,args)=>(await asActor(ctx,'counter',sql,args)).rows[0].s
 let live=await rpc('select to_jsonb(start_live_match($1,$2)) s',[m.id,m.score_revision])
 const revision=live.revision
 live=await rpc('select to_jsonb(set_live_sides($1,$2,$3)) s',[m.id,true,false])
 assert.equal(live.revision,revision)
 live=await rpc('select to_jsonb(record_point($1,$2,$3)) s',[m.id,'a',live.revision])
 await asActor(ctx,'owner','select stop_live_match($1,$2)',[m.id,live.revision])
 const stopped=(await matches(ctx,t.id)).find(row=>row.id===m.id)
 live=await rpc('select to_jsonb(start_live_match($1,$2)) s',[m.id,stopped.score_revision])
 for(const row of [live,(await state(t.id)).live[0],(await state(t.id,'anon')).live[0]]) {
   assert.equal(row.sides_swapped,true);assert.equal(row.sides_auto,false)
   assert.equal(row.state.points.a,1)
 }
 await drop(t)
})
test('migration is idempotent, preserves all data and has invoker/stable/explicit ACLs and group publication', async () => {
 const t=await fixture(ctx),before=await snapshot(ctx)
 const sql=await readFile(new URL('../supabase/upgrades/20260906162739_synchronize_tournament_results.sql',import.meta.url),'utf8')
 await ctx.db.exec(sql);await ctx.db.exec(sql)
 assert.deepEqual(await snapshot(ctx),before)
 const p=(await ctx.db.query("select prosecdef,provolatile,has_function_privilege('anon',oid,'execute') a,has_function_privilege('authenticated',oid,'execute') u from pg_proc where oid='get_tournament_sync_state(uuid)'::regprocedure")).rows[0]
 assert.deepEqual(p,{prosecdef:false,provolatile:'s',a:true,u:true})
 const pub=(await ctx.db.query("select tablename from pg_publication_tables where pubname='supabase_realtime' and tablename in ('groups','group_entries') order by tablename")).rows
 assert.deepEqual(pub.map(r=>r.tablename),['group_entries','groups'])
 await drop(t)
})
