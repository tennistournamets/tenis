import assert from 'node:assert/strict'
import { before, after, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createDatabase, seedPartialScore, fixture, asActor, matches, snapshot, assertDeniedUnchanged } from './helpers/database.mjs'
import { DEFAULT_TENNIS_RULES, tennisRules, ruleForSet, scoreRows, buildSetPayload, formatSetScore } from '../src/lib/tennisRules.js'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx?.db.close() })
const config = rules => ({ tennis: { ...DEFAULT_TENNIS_RULES, ...rules } })
const sets = pairs => pairs.map(([a,b],i)=>({set_index:i+1,side_a_games:a,side_b_games:b}))
const submit = (id, rows, actor='owner') => asActor(ctx,actor,'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))',[id,JSON.stringify(rows)])
const seed = (id, rows) => seedPartialScore(ctx,id,rows)
const stop = id => asActor(ctx,'owner','select stop_live_match($1,(select revision from live_scores where match_id=$1))',[id])
const live = async id => (await ctx.db.query('select * from live_scores where match_id=$1',[id])).rows[0]
const match = async id => (await ctx.db.query('select * from matches where id=$1',[id])).rows[0]
const saved = async id => (await ctx.db.query('select * from match_sets where match_id=$1 order by set_index',[id])).rows
async function draw(rules={}, options={}) {
  const t=await fixture(ctx,{scoringConfig:config(rules),...options})
  await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
  return {...t,m:(await matches(ctx,t.id)).find(m=>m.status==='ready')}
}
async function point(id,side) {
  const revision=(await live(id))?.revision ?? 0
  await asActor(ctx,'counter','select record_point($1,$2,$3)',[id,side,revision])
  return (await live(id)).state
}
async function points(id,sides) {let s;for(const side of sides)s=await point(id,side);return s}
const game=(id,side)=>points(id,[side,side,side,side])
const drop=t=>ctx.db.query('delete from tournaments where id=$1',[t.id])

// Independent path enumeration, ending the path at its first winning point.
function racePaths(target,margin,bound) {
  const map=new Map(), queue=[[0,0]]
  while(queue.length){
    const [a,b]=queue.shift(),key=`${a}:${b}`
    if(a>bound||b>bound||map.has(key))continue
    const won=Math.max(a,b)>=target&&Math.abs(a-b)>=margin
    map.set(key,won?(a>b?1:2):0)
    if(!won)queue.push([a+1,b],[a,b+1])
  }
  return map
}
test('ITF point races: every reachable score through 24 points; no overshooting the winning point',async()=>{
  for(const [target,margin] of [[4,2],[4,1],[5,1],[7,2],[10,2]]){
    const paths=racePaths(target,margin,24)
    const rows=(await ctx.db.query('select a,b,tennis_race_result(a,b,$1,$2) result from generate_series(0,24)a cross join generate_series(0,24)b',[target,margin])).rows
    for(const r of rows)assert.equal(r.result,paths.get(`${r.a}:${r.b}`)??-1,`${target}/${margin} ${r.a}:${r.b}`)
  }
})

test('all regular/short/advantage set paths, including 8:6 and forbidden post-tiebreak games',async()=>{
  for(const [set_rule,at] of [['standard',6],['advantage',null],['short',3],['short',4]]){
    const cfg=config({set_rule,short_tiebreak_at:at===3?3:4})
    const target=set_rule==='short'?4:6, states=new Map(),queue=[[0,0]]
    while(queue.length){
      const [a,b]=queue.shift(),key=`${a}:${b}`
      if(a>14||b>14||states.has(key))continue
      const won=(Math.max(a,b)>=target&&Math.abs(a-b)>=2)||(at!==null&&Math.max(a,b)===at+1&&Math.min(a,b)===at)
      states.set(key,won?(a>b?1:2):0)
      if(!won)queue.push([a+1,b],[a,b+1])
    }
    const rows=(await ctx.db.query(`select a,b,tennis_set_result(jsonb_build_object('side_a_games',a,'side_b_games',b),
      tennis_set_rule(tennis_scoring_rules($1),1,2)) result from generate_series(0,14)a cross join generate_series(0,14)b`,[JSON.stringify(cfg)])).rows
    for(const r of rows)assert.equal(r.result,states.get(`${r.a}:${r.b}`)??-1,`${set_rule}/${at} ${r.a}:${r.b}`)
  }
})

test('UI rule selection and SQL agree for every combination and both match lengths',async()=>{
  for(const set_rule of ['standard','advantage','short'])for(const final_set_rule of ['same','standard','advantage','tiebreak_10','match_tiebreak_7','match_tiebreak_10']){
    for(const short_tiebreak_at of [3,4])for(const short_tiebreak_to of [5,7])for(const format of ['best_of_3','best_of_5']){
      const cfg=config({set_rule,final_set_rule,short_tiebreak_at,short_tiebreak_to}),required=format==='best_of_5'?3:2
      const rows=(await ctx.db.query('select i,tennis_set_rule(tennis_scoring_rules($1),i,$2) r from generate_series(1,$2*2-1)i',[JSON.stringify(cfg),required])).rows
      for(const {i,r} of rows)assert.deepEqual(ruleForSet(cfg,i,format),r)
    }
  }
})

test('5:5 → 6:5 → 7:5 ends the set; 5:5 → 6:6 starts an extended 7-point tiebreak',async()=>{
  const t=await draw()
  await seed(t.m.id,sets([[5,5]]))
  await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id])
  let s=await game(t.m.id,'a');assert.deepEqual(s.games,{a:6,b:5});assert.equal(s.isTiebreak,false);assert.equal(s.setsWon.a,0)
  s=await game(t.m.id,'a');assert.equal(s.setsWon.a,1);assert.equal(s.sets[0].side_a_games,7);assert.equal(s.sets[0].side_b_games,5)
  await seed(t.m.id,sets([[5,5]]));await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id])
  await game(t.m.id,'a');s=await game(t.m.id,'b');assert.equal(s.isTiebreak,true);assert.equal(s.tiebreakTo,7)
  s=await points(t.m.id,Array(8).fill(['a','b']).flat());assert.deepEqual(s.tiebreakPoints,{a:8,b:8});assert.equal(s.setsWon.a,0)
  s=await point(t.m.id,'a');assert.equal(s.setsWon.a,0)
  s=await point(t.m.id,'a');assert.equal(s.setsWon.a,1)
  let row=(await saved(t.m.id))[0];assert.equal(row.side_a_tiebreak,10);assert.equal(row.side_b_tiebreak,8);assert.equal(row.side_a_games,7);assert.equal(row.side_b_games,6)
  assert.equal((await match(t.m.id)).side_a_score,1)
  s=await point(t.m.id,'undo');assert.equal(s.isTiebreak,true);assert.deepEqual(s.tiebreakPoints,{a:9,b:8})
  row=(await saved(t.m.id))[0];assert.equal(row.side_a_games,6);assert.equal(row.side_a_tiebreak,9);assert.equal((await match(t.m.id)).side_a_score,0)
  await drop(t)
})

test('No-Ad uses a single deciding point at deuce; advantage still requires two',async()=>{
  for(const game_rule of ['advantage','no_ad']){
    const t=await draw({game_rule});await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id])
    let s=await points(t.m.id,['a','b','a','b','a','b','a'])
    assert.equal(s.games.a,game_rule==='no_ad'?1:0)
    if(game_rule==='advantage'){assert.deepEqual(s.points,{a:4,b:3});s=await point(t.m.id,'b');assert.deepEqual(s.points,{a:4,b:4});s=await points(t.m.id,['a','a']);assert.equal(s.games.a,1)}
    await drop(t)
  }
})

test('short tiebreak at 3:3/4:4: 4:4 → 5:4 wins, undo restores sudden death',async()=>{
  for(const at of [3,4]){
    const t=await draw({set_rule:'short',short_tiebreak_at:at,short_tiebreak_to:5})
    await seed(t.m.id,sets([[at,at]]));await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id])
    let s=await points(t.m.id,Array(4).fill(['a','b']).flat());assert.equal(s.tiebreakMargin,1)
    s=await point(t.m.id,'b');assert.equal(s.setsWon.b,1);assert.equal(s.sets[0].side_b_games,at+1);assert.equal(s.sets[0].side_b_tiebreak,5)
    s=await point(t.m.id,'undo');assert.deepEqual(s.tiebreakPoints,{a:4,b:4});assert.equal(s.setsWon.b,0)
    await drop(t)
  }
})

test('advantage sets continue through 6:6/7:7, both manual and live',async()=>{
  const t=await draw({set_rule:'advantage'})
  await seed(t.m.id,sets([[7,7]]));await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id])
  let s=await game(t.m.id,'b');assert.equal(s.isTiebreak,false);assert.equal(s.setsWon.b,0)
  s=await game(t.m.id,'b');assert.equal(s.setsWon.b,1);assert.equal(s.sets[0].side_b_games,9)
  await stop(t.m.id);await submit(t.m.id,sets([[70,68],[6,0]]));assert.equal((await match(t.m.id)).winner_entry_id,t.m.side_a_entry_id)
  await assertDeniedUnchanged(ctx,'owner','select update_match_sets($1,$2,(select score_revision from matches where id=$1))',[t.m.id,JSON.stringify(sets([[71,68]]))],/Invalid set/)
  await drop(t)
})

test('final-set 10 applies only at 6:6 of the deciding set, in best-of-3 and best-of-5',async()=>{
  for(const setFormat of ['best_of_3','best_of_5']){
    const t=await draw({final_set_rule:'tiebreak_10'},{setFormat})
    const previous=setFormat==='best_of_5'?[[6,0],[0,6],[6,0],[0,6]]:[[6,0],[0,6]]
    await seed(t.m.id,sets([...previous,[6,6]]));await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id])
    let s=await points(t.m.id,Array(7).fill('a'));assert.equal(s.winner,null);assert.equal(s.tiebreakTo,10)
    s=await points(t.m.id,['a','a','a']);assert.equal(s.winner,'a');assert.equal(s.sets.at(-1).side_a_games,7)
    assert.equal((await match(t.m.id)).side_a_score,setFormat==='best_of_5'?3:2)
    await drop(t)
  }
})

test('match-tiebreak replaces final set; extended points are retained, counted as one set, and advanced',async()=>{
  for(const target of [7,10]){
    const t=await draw({final_set_rule:`match_tiebreak_${target}`})
    await seed(t.m.id,sets([[6,4],[4,6]]));await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id])
    let s=(await live(t.m.id)).state;assert.equal(s.isTiebreak,true);assert.equal(s.isMatchTiebreak,true);assert.deepEqual(s.games,{a:0,b:0})
    s=await points(t.m.id,Array(target).fill(['a','b']).flat());assert.equal(s.winner,null)
    s=await points(t.m.id,['b','b']);assert.equal(s.winner,'b')
    const last=(await saved(t.m.id)).at(-1);assert.equal(last.score_kind,'match_tiebreak');assert.equal(last.side_a_games,0);assert.equal(last.side_b_games,0)
    assert.equal(last.side_b_tiebreak,target+2);assert.equal(last.side_a_tiebreak,target)
    assert.equal((await match(t.m.id)).side_b_score,2);assert.equal((await match(t.m.next_match_id)).side_a_entry_id,t.m.side_b_entry_id)
    await drop(t)
  }
})

test('manual tiebreak details validate winner, finish and chronology before modifying any results',async()=>{
  const t=await draw({final_set_rule:'match_tiebreak_10'})
  const first={set_index:1,side_a_games:7,side_b_games:6,side_a_tiebreak:9,side_b_tiebreak:7}
  const second={set_index:2,side_a_games:4,side_b_games:6}
  const mt={set_index:3,score_kind:'match_tiebreak',side_a_games:0,side_b_games:0,side_a_tiebreak:12,side_b_tiebreak:10}
  await submit(t.m.id,[first,second,mt]);assert.equal((await match(t.m.id)).side_a_score,2)
  for(const bad of [
    [{...first,side_a_tiebreak:7,side_b_tiebreak:9}], [{...first,side_a_tiebreak:7,side_b_tiebreak:6}],
    [{...first,side_a_tiebreak:8,side_b_tiebreak:3}], [{...first,side_a_tiebreak:null}],
    [{...first,side_a_tiebreak:'9'}], [{...first,side_a_tiebreak:9.5}],
    [first,second,{...mt,side_a_games:12}], [first,second,{...mt,side_a_tiebreak:13}],
    [first,{...second,side_a_tiebreak:1,side_b_tiebreak:0}],
    [first,{...mt,set_index:2}], [first,second,{...mt,score_kind:'set'}],
  ])await assertDeniedUnchanged(ctx,'editor','select update_match_sets($1,$2,(select score_revision from matches where id=$1))',[t.m.id,JSON.stringify(bad)],/score|set|Tiebreak/)
  await assert.rejects(submit(t.m.id,[first,second,{...mt,side_a_tiebreak:10,side_b_tiebreak:9}]),/finalRequired/)
  await drop(t)
})

test('rules validate on creation and direct edits; only managers can change them before play',async()=>{
  const t=await fixture(ctx,{status:'draft'})
  await asActor(ctx,'editor','update tournaments set scoring_config=$1 where id=$2',[JSON.stringify(config({game_rule:'no_ad'})),t.id])
  const baseline=await snapshot(ctx)
  await asActor(ctx,'counter','update tournaments set scoring_config=$1 where id=$2',[JSON.stringify(config({game_rule:'advantage'})),t.id])
  assert.deepEqual(await snapshot(ctx),baseline)
  for(const invalid of [{tennis:null},{tennis:{game_rule:'wrong'}},{tennis:{short_tiebreak_to:10}},{tennis:{short_tiebreak_at:'3'}},{tennis:{unexpected:true}}]){
    await assertDeniedUnchanged(ctx,'owner','update tournaments set scoring_config=$1 where id=$2',[JSON.stringify(invalid),t.id],/Invalid|Unknown|cannot/)
  }
  await asActor(ctx,'owner',"update tournaments set status='in_progress' where id=$1",[t.id])
  await assertDeniedUnchanged(ctx,'owner','update tournaments set scoring_config=$1 where id=$2',[JSON.stringify(config({game_rule:'advantage'})),t.id],/locked/)
  await assertDeniedUnchanged(ctx,'owner',"update tournaments set set_format='best_of_5' where id=$1",[t.id],/locked/)
  await assertDeniedUnchanged(ctx,'owner',"update tournaments set sport='football',scoring_config=$1 where id=$2",[JSON.stringify(config({game_rule:'advantage'})),t.id],/locked/)
  // Cosmetic and standings fields do not change the rules and remain editable.
  await asActor(ctx,'owner',"update tournaments set scoring_config=scoring_config||'{\"gender\":\"women\"}' where id=$1",[t.id])
  await drop(t)
})

test('manual final result requires stopping live and fences its old revisions',async()=>{
  const t=await draw();await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id]);await point(t.m.id,'a')
  const old=(await live(t.m.id)).revision
  await assert.rejects(submit(t.m.id,sets([[6,0],[6,0]])),/liveBlocked/)
  await stop(t.m.id)
  await submit(t.m.id,sets([[6,0],[6,0]]))
  const l=await live(t.m.id);assert.equal(l.status,'finished');assert.deepEqual(l.history,[])
  await assertDeniedUnchanged(ctx,'counter','select record_point($1,$2,$3)',[t.m.id,'a',old],/liveConflict/)
  await drop(t)
})

test('internal helpers stay closed to API roles; counter cannot replace the manual score',async()=>{
  const t=await draw()
  for(const actor of ['anon','counter','outsider']){
    for(const call of ["tennis_scoring_rules('{}')","tennis_set_rule('{}',1,2)","tennis_race_result(7,5,7,2)","tennis_set_result('{}','{}')",`tennis_live_state('${t.m.id}','{}',2)`,`tennis_apply_point('{}','a')`]){
      await assertDeniedUnchanged(ctx,actor,`select ${call}`)
    }
  }
  await assertDeniedUnchanged(ctx,'counter','select update_match_sets($1,$2,(select score_revision from matches where id=$1))',[t.m.id,JSON.stringify(sets([[6,0]]))])
  await drop(t)
})

test('client manual payload preserves tiebreak points and refuses half-filled rows',()=>{
  const cfg=config({final_set_rule:'match_tiebreak_10'})
  const rows=scoreRows([{...sets([[7,6]])[0],side_a_tiebreak:9,side_b_tiebreak:7}], 'best_of_3')
  assert.equal(buildSetPayload(rows,cfg,'best_of_3')[0].side_a_tiebreak,9)
  rows[1].side_a_games='4';assert.throws(()=>buildSetPayload(rows,cfg,'best_of_3'),/incompleteScore/)
  rows[1].side_b_games='6';rows[2].side_a_tiebreak='10';rows[2].side_b_tiebreak='8'
  const p=buildSetPayload(rows,cfg,'best_of_3');assert.equal(p[2].score_kind,'match_tiebreak');assert.equal(p[2].side_a_games,0)
  assert.equal(formatSetScore(p[0]),'7:6 (9:7)');assert.equal(formatSetScore(p[2]),'[10:8]')
})

test('ITF migration is repeatable and preserves current data, definitions and permissions',async()=>{
  const t=await draw({final_set_rule:'match_tiebreak_10'});await seed(t.m.id,sets([[6,0],[0,6]]));await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[t.m.id]);await point(t.m.id,'b')
  const before=await snapshot(ctx)
  const defs=async()=>(await ctx.db.query("select oid::regprocedure::text signature,md5(pg_get_functiondef(oid)) body,proowner,proacl::text from pg_proc where pronamespace='public'::regnamespace order by signature")).rows
  let functions; const migration=(await readFile(new URL('../supabase/upgrades/20260906065724_add_itf_2026_scoring.sql',import.meta.url),'utf8')) + '\n' + (await readFile(new URL('../supabase/upgrades/20260906073551_lock_started_tournament_sport.sql',import.meta.url),'utf8'))
  for(let i=0;i<2;i++){await ctx.db.exec(migration);assert.deepEqual(await snapshot(ctx),before);if(i===0)functions=await defs();else assert.deepEqual(await defs(),functions)}
  await drop(t)
})
