import assert from 'node:assert/strict'
import {before,after,test} from 'node:test'
import {readFile} from 'node:fs/promises'
import {createDatabase,seedPartialScore,fixture,asActor,matches,snapshot,assertDeniedUnchanged} from './helpers/database.mjs'

let ctx
before(async()=>{ctx=await createDatabase()})
after(async()=>{await ctx?.db.close()})
const payload=pairs=>pairs.map(([a,b],i)=>({set_index:i+1,side_a_games:a,side_b_games:b}))
const submit=(id,sets,actor='owner')=>asActor(ctx,actor,'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))',[id,JSON.stringify(sets)])
const row=async id=>(await ctx.db.query('select * from matches where id=$1',[id])).rows[0]
const saved=async id=>(await ctx.db.query('select set_index,side_a_games,side_b_games from match_sets where match_id=$1 order by set_index',[id])).rows
async function draw(options={}){
  const t=await fixture(ctx,options)
  await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
  return {...t,first:(await matches(ctx,t.id)).find(m=>m.status==='ready')}
}
const drop=t=>ctx.db.query('delete from tournaments where id=$1',[t.id])
async function reject(id,sets,pattern=/sets|set |score|games|finalRequired/i){
  await assertDeniedUnchanged(ctx,'editor','select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))',[id,sets===undefined?null:JSON.stringify(sets)],pattern)
}

test('partial manual results are rejected without assigning a set or match winner',async()=>{
  const t=await draw()
  for(const scores of [[[1,0]],[[6,0],[6,5]]])await reject(t.first.id,payload(scores),/finalRequired/)
  await drop(t)
})

test('known invalid-score bug: impossible 7:0 is rejected without touching the saved result',async()=>{
  const t=await draw()
  await submit(t.first.id,payload([[6,4],[7,5]]))
  await reject(t.first.id,payload([[7,0],[6,0]]))
  await drop(t)
})

test('all reachable standard set scores 0–7 are classified correctly for tennis and padel',async()=>{
  // Independently enumerate legal paths one game at a time, stopping at the
  // first completed set. At 6:6 the next game represents the tiebreak winner.
  const states=new Map()
  function visit(a,b){
    const key=`${a}:${b}`
    if(states.has(key))return
    const winner=a===7?'a':b===7?'b':a===6&&b<=4?'a':b===6&&a<=4?'b':null
    states.set(key,winner)
    if(!winner){visit(a+1,b);visit(a,b+1)}
  }
  visit(0,0)
  for(const sport of ['tennis','padel']){
    const t=await draw({sport})
    for(let a=0;a<=7;a++)for(let b=0;b<=7;b++){
      const key=`${a}:${b}`,sets=payload([[a,b]])
      if(!states.has(key)){await reject(t.first.id,sets);continue}
      const result=(await ctx.db.query("select tennis_set_result($1,tennis_set_rule(tennis_scoring_rules('{}'),1,2)) r",[JSON.stringify(sets[0])])).rows[0].r
      assert.equal(result,states.get(key)==='a'?1:states.get(key)==='b'?2:0,`${sport} ${key}`)
      await reject(t.first.id,sets,/finalRequired/)
    }
    await drop(t)
  }
})

test('best-of-3 and best-of-5 terminate on the required wins in every legal set-winner sequence',async()=>{
  for(const setFormat of ['best_of_3','best_of_5']){
    const required=setFormat==='best_of_3'?2:3
    const sequences=[]
    function walk(seq,a,b){
      sequences.push([seq,a,b])
      if(a===required||b===required)return
      walk([...seq,[6,4]],a+1,b)
      walk([...seq,[5,7]],a,b+1)
    }
    walk([],0,0)
    const t=await draw({setFormat})
    for(const [seq,a,b] of sequences){
      if(a<required && b<required){await reject(t.first.id,payload(seq),/finalRequired/);continue}
      await submit(t.first.id,payload(seq),'editor')
      const m=await row(t.first.id)
      const winner=a===required?m.side_a_entry_id:b===required?m.side_b_entry_id:null
      assert.equal(m.side_a_score,a)
      assert.equal(m.side_b_score,b)
      assert.equal(m.winner_entry_id,winner)
      assert.equal(m.status,winner?'finished':'ready')
      if(winner)await reject(m.id,payload([...seq,[0,0]]))
    }
    await drop(t)
  }
})

test('an unfinished set is allowed only at the end, including 0:0 and 6:6',async()=>{
  const t=await draw()
  for(const partial of [[0,0],[1,0],[5,5],[6,5],[5,6],[6,6]]){
    await reject(t.first.id,payload([[6,0],partial]),/finalRequired/)
    await reject(t.first.id,payload([partial,[6,0]]))
    await reject(t.first.id,payload([[6,0],partial,[6,0]]))
  }
  await drop(t)
})

test('malformed JSON, missing/null/string fields and non-integral or out-of-range numbers are atomic failures',async()=>{
  const t=await draw()
  await submit(t.first.id,payload([[6,0],[7,6]]))
  for(const malformed of [undefined,null,{},true,2,'[]',[null],[false],[[]],[{}]])await reject(t.first.id,malformed)
  const valid=payload([[6,4]])[0]
  for(const field of ['set_index','side_a_games','side_b_games']){
    const missing={...valid};delete missing[field]
    await reject(t.first.id,[missing])
    for(const bad of [null,true,false,'6','',{},[],0.5,-1,8,1e100])await reject(t.first.id,[{...valid,[field]:bad}])
  }
  await reject(t.first.id,[{...valid,set_index:0}])
  await drop(t)
})

test('set indices are unique and contiguous from one; their numeric order defines chronology',async()=>{
  const t=await draw()
  const sets=payload([[6,4],[4,6],[7,6]])
  await submit(t.first.id,[sets[2],sets[0],sets[1]])
  assert.deepEqual(await saved(t.first.id),sets)
  assert.equal((await row(t.first.id)).winner_entry_id,t.first.side_a_entry_id)
  for(const bad of [[sets[1]],[sets[0],sets[2]],[sets[0],sets[0]],payload([[6,0],[0,6],[6,0],[0,6]])])await reject(t.first.id,bad)
  await drop(t)
})

test('tiebreak_to=10 still uses game score 7:6 and does not introduce a match-tiebreak set',async()=>{
  const t=await draw({sport:'padel',scoringConfig:{tiebreak_to:10}})
  await submit(t.first.id,payload([[7,6],[6,7],[7,6]]))
  assert.equal((await row(t.first.id)).winner_entry_id,t.first.side_a_entry_id)
  for(const score of [[10,8],[10,0],[8,6],[7,7]])await reject(t.first.id,payload([score]))
  await drop(t)
})

test('empty manual result cannot erase a completed match',async()=>{
  const t=await draw()
  await submit(t.first.id,payload([[6,0],[6,0]]))
  await reject(t.first.id,[],/finalRequired/)
  await drop(t)
})

test('invalid replacement is rejected before any DELETE, preserving completed downstream games and live state',async()=>{
  const t=await draw()
  for(const m of (await matches(ctx,t.id)).filter(m=>m.round_number===1))await submit(m.id,payload([[6,4],[7,5]]))
  const final=(await matches(ctx,t.id)).find(m=>m.round_number===2)
  await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[final.id])
  await asActor(ctx,'counter',"select record_point($1,'b',(select revision from live_scores where match_id=$1))",[final.id])
  await asActor(ctx,'owner','select stop_live_match($1,(select revision from live_scores where match_id=$1))',[final.id])
  await submit(final.id,payload([[7,6],[6,4]]))
  await ctx.db.exec(`create function guard_score_delete() returns trigger language plpgsql as $$ begin raise exception 'DELETE before validation'; end $$;
    create trigger guard_score_delete before delete on match_sets for each statement execute function guard_score_delete();`)
  try{
    for(const bad of [null,payload([[7,0]]),payload([[1,0],[6,0]]),payload([[6,0],[6,0],[0,0]])])await reject(t.first.id,bad)
  }finally{await ctx.db.exec('drop trigger guard_score_delete on match_sets; drop function guard_score_delete()')}
  await drop(t)
})

test('partial group results do not enter standings; finished results use completed set totals',async()=>{
  const t=await fixture(ctx,{count:4,format:'groups_playoff',sport:'padel'})
  await asActor(ctx,'owner','select generate_groups($1,2)',[t.id])
  const m=(await matches(ctx,t.id))[0]
  await seedPartialScore(ctx,m.id,payload([[6,4],[6,5]]))
  let standings=(await asActor(ctx,'owner','select * from get_standings($1,$2)',[t.id,m.group_id])).rows
  assert.ok(standings.every(r=>r.played===0))
  await submit(m.id,payload([[6,4],[7,5]]))
  standings=(await asActor(ctx,'owner','select * from get_standings($1,$2)',[t.id,m.group_id])).rows
  assert.equal(standings.find(r=>r.entry_id===m.side_a_entry_id).score_for,2)
  assert.equal(standings.find(r=>r.entry_id===m.side_b_entry_id).score_against,2)
  await drop(t)
})

test('sport boundaries reject set/goal cross-calls and tennis live scoring on football, even an existing session',async()=>{
  for(const sport of ['tennis','padel']){
    const t=await draw({sport})
    await assertDeniedUnchanged(ctx,'owner','select update_football_result($1,2,0,null,null,(select score_revision from matches where id=$1))',[t.first.id],/football/i)
    await drop(t)
  }
  const t=await draw({sport:'football'})
  await asActor(ctx,'owner','select update_football_result($1,2,0,null,null,(select score_revision from matches where id=$1))',[t.first.id])
  await reject(t.first.id,payload([[6,0],[6,0]]),/tennis|padel/i)
  for(const actor of ['owner','editor','counter']){
    await assertDeniedUnchanged(ctx,actor,'select start_live_match($1,(select score_revision from matches where id=$1))',[t.first.id],/tennis|padel/i)
    await assertDeniedUnchanged(ctx,actor,"select record_point($1,'a',(select revision from live_scores where match_id=$1))",[t.first.id],/tennis|padel/i)
  }
  await ctx.db.query("insert into live_scores(match_id,tournament_id,status,state,history) values($1,$2,'active',live_score_initial_state(2,7),jsonb_build_array(live_score_initial_state(2,7)))",[t.first.id,t.id])
  for(const side of ['a','b','undo'])await assertDeniedUnchanged(ctx,'counter','select record_point($1,$2,(select revision from live_scores where match_id=$1))',[t.first.id,side],/tennis|padel/i)
  await drop(t)
})

test('set-result migration is repeatable and preserves all existing data, function definitions and ACLs',async()=>{
  const t=await draw()
  await submit(t.first.id,payload([[7,5],[6,7],[6,4]]))
  await asActor(ctx,'counter','select start_live_match($1,(select score_revision from matches where id=$1))',[(await matches(ctx,t.id)).find(m=>m.status==='ready').id])
  const before=await snapshot(ctx)
  const functions=async()=>(await ctx.db.query("select oid::regprocedure::text as signature,pg_get_functiondef(oid) as body,proowner,proacl::text from pg_proc where pronamespace='public'::regnamespace order by oid")).rows
  let definitions
  const migration=await readFile(new URL('../supabase/upgrades/20260905211522_validate_match_set_results.sql',import.meta.url),'utf8')
  for(let pass=0;pass<2;pass++){
    await ctx.db.exec(migration)
    assert.deepEqual(await snapshot(ctx),before)
    if (pass===0) definitions=await functions()
    else assert.deepEqual(await functions(),definitions)
    const check=await ctx.db.exec(await readFile(new URL('../supabase/checks/match_set_results.sql',import.meta.url),'utf8'))
    assert.equal(check[0].rows.length,4)
    assert.ok(check[0].rows.every(r=>r.passed),JSON.stringify(check[0].rows))
    assert.deepEqual(check[1].rows,[])
    const access=await ctx.db.exec(await readFile(new URL('../supabase/checks/internal_rpc_access.sql',import.meta.url),'utf8'))
    assert.ok(access[0].rows.every(r=>r.function_exists&&!r.anon_execute&&!r.authenticated_execute&&!r.public_execute))
    assert.ok(access[1].rows.every(r=>r.authenticated_execute))
  }
  await drop(t)
})
