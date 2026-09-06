import assert from 'node:assert/strict'
import {after,before,test} from 'node:test'
import {readFile} from 'node:fs/promises'
import {createDatabase,asActor,fixture,matches,snapshot,assertDeniedUnchanged,winningSets} from './helpers/database.mjs'

let ctx
before(async()=>{ctx=await createDatabase()})
after(async()=>{await ctx?.db.close()})
const stageRows=async(id,stage)=> (await matches(ctx,id)).filter(m=>m.stage===stage)
const drop=async(id)=>ctx.db.query('delete from tournaments where id=$1',[id])
const upperPower=n=>2**Math.ceil(Math.log2(n))

function checkDraw(rows,entries,label){
  const n=entries.length,b=upperPower(n)
  assert.equal(rows.length,b-1,label)
  const first=rows.filter(m=>m.round_number===1).sort((a,b)=>a.match_number-b.match_number)
  assert.equal(first.length,b/2,label)
  assert.ok(first.every(m=>m.side_a_entry_id || m.side_b_entry_id),`${label}: empty first-round match`)
  const roster=first.flatMap(m=>[m.side_a_entry_id,m.side_b_entry_id].filter(Boolean))
  assert.deepEqual(roster.slice().sort(),entries.slice().sort(),`${label}: lost or duplicated entry`)
  const byes=first.filter(m=>!m.side_a_entry_id || !m.side_b_entry_id)
  assert.equal(byes.length,b-n,`${label}: wrong BYE count`)
  assert.ok(byes.every(m=>m.status==='finished' && m.winner_entry_id===(m.side_a_entry_id||m.side_b_entry_id) && m.side_a_score===null && m.side_b_score===null),`${label}: invalid BYE result`)
  // Distribute free passes across every pair of sibling bracket sections.
  for(let width=first.length;width>=2;width/=2){
    for(let offset=0;offset<first.length;offset+=width){
      const count=part=>part.filter(m=>!m.side_a_entry_id||!m.side_b_entry_id).length
      assert.ok(Math.abs(count(first.slice(offset,offset+width/2))-count(first.slice(offset+width/2,offset+width)))<=1,`${label}: unbalanced BYEs`)
    }
  }
  for(const m of rows){
    if(m.round_number>1){
      const feeders=rows.filter(f=>f.next_match_id===m.id)
      assert.equal(feeders.length,2,`${label}: missing feeder`)
      assert.deepEqual(feeders.map(f=>f.next_slot).sort(),['A','B'])
      for(const f of feeders){
        const slot=f.next_slot==='A'?'side_a_entry_id':'side_b_entry_id'
        assert.equal(m[slot],f.winner_entry_id,`${label}: premature or missing advancement`)
      }
      assert.equal(m.status,m.side_a_entry_id && m.side_b_entry_id?'ready':'pending')
    }
  }
  return roster
}

async function save(actor,m,sport,winner){
  const a=winner===m.side_a_entry_id
  if(sport==='football')await asActor(ctx,actor,'select update_football_result($1,$2,$3,null,null,(select score_revision from matches where id=$1))',[m.id,a?2:0,a?0:2])
  else{
    const sets=a?winningSets:JSON.stringify(JSON.parse(winningSets).map(s=>({...s,side_a_games:0,side_b_games:6})))
    await asActor(ctx,actor,'select update_match_sets($1,$2::jsonb,(select score_revision from matches where id=$1))',[m.id,sets])
  }
}
async function complete(id,stage,sport,champion){
  let played=0
  while(true){
    const rows=await stageRows(id,stage)
    const ready=rows.filter(m=>m.status==='ready').sort((a,b)=>b.round_number-a.round_number||b.match_number-a.match_number)
    if(!ready.length){
      assert.ok(rows.every(m=>m.status==='finished'),`stuck ${stage} bracket: ${rows.filter(m=>m.status!=='finished').map(m=>`${m.round_number}/${m.match_number}`).join(',')}`)
      const finals=rows.filter(m=>m.next_match_id===null)
      assert.equal(finals.length,1)
      assert.equal(finals[0].winner_entry_id,champion)
      return {rows,played}
    }
    assert.ok(played<128,'unbounded bracket')
    const m=ready[0]
    assert.ok(m.side_a_entry_id && m.side_b_entry_id)
    assert.notEqual(m.side_a_entry_id,m.side_b_entry_id)
    const winner=[m.side_a_entry_id,m.side_b_entry_id].includes(champion)?champion:(played%2?m.side_a_entry_id:m.side_b_entry_id)
    await save(played%2?'editor':'owner',m,sport,winner)
    played++
  }
}

test('known five-player single-elimination failure has no empty branch and reaches its champion',async()=>{
  const t=await fixture(ctx,{count:5})
  await asActor(ctx,'owner',"select generate_bracket($1,'manual',$2::uuid[])",[t.id,t.entries])
  checkDraw(await stageRows(t.id,'main'),t.entries,'five players')
  assert.equal((await complete(t.id,'main','tennis',t.entries[4])).played,4)
  await drop(t.id)
})

test('known two-player double-elimination failure routes both finalists',async()=>{
  const t=await fixture(ctx,{count:2,format:'double_elimination'})
  await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
  const first=(await matches(ctx,t.id)).find(m=>m.stage==='winners')
  await save('owner',first,'tennis',first.side_a_entry_id)
  const final=(await matches(ctx,t.id)).find(m=>m.stage==='grand_final')
  assert.equal(final.status,'ready')
  assert.deepEqual([final.side_a_entry_id,final.side_b_entry_id],[first.side_a_entry_id,first.side_b_entry_id])
  await save('editor',final,'tennis',final.side_b_entry_id)
  assert.ok((await matches(ctx,t.id)).every(m=>m.status==='finished'))
  await drop(t.id)
})

test('single elimination completes for every size 2–64, preserving order and exact played/BYE counts',async()=>{
  for(let n=2;n<=64;n++){
    const sport=n%2?'tennis':'football'
    const t=await fixture(ctx,{count:n,sport})
    const mode=n%3?'manual':'auto-random'
    await asActor(ctx,n%2?'editor':'owner','select generate_bracket($1,$2,$3::uuid[])',[t.id,mode,mode==='manual'?t.entries:null])
    const roster=checkDraw(await stageRows(t.id,'main'),t.entries,`single ${n}`)
    if(mode==='manual')assert.deepEqual(roster,t.entries,`single ${n}: input order changed`)
    const result=await complete(t.id,'main',sport,t.entries[n-1])
    assert.equal(result.played,n-1,`single ${n}`)
    assert.equal(result.rows.filter(m=>!m.side_a_entry_id||!m.side_b_entry_id).length,upperPower(n)-n)
    await drop(t.id)
  }
})

test('group playoff completes for every qualifier count 2–64 and preserves the group results',async()=>{
  for(let n=2;n<=64;n++){
    const sport=n%2?'football':'tennis'
    const t=await fixture(ctx,{count:n*2,format:'groups_playoff',sport})
    await ctx.db.query("update tournaments set format_config='{\"advance_per_group\":1}' where id=$1",[t.id])
    await asActor(ctx,'owner','select generate_groups($1,$2)',[t.id,n])
    const groupMatches=await stageRows(t.id,'group')
    assert.equal(groupMatches.length,n)
    for(const m of groupMatches)await save('editor',m,sport,m.side_a_entry_id)
    const before=await stageRows(t.id,'group')
    const qualifiers=before.map(m=>m.winner_entry_id)
    await asActor(ctx,'editor','select generate_group_playoff($1)',[t.id])
    checkDraw(await stageRows(t.id,'winners'),qualifiers,`playoff ${n}`)
    assert.equal((await complete(t.id,'winners',sport,qualifiers[n-1])).played,n-1,`playoff ${n}`)
    assert.deepEqual(await stageRows(t.id,'group'),before)
    await drop(t.id)
  }
})

test('six qualifiers from three groups retain group scores across playoff regeneration',async()=>{
  const t=await fixture(ctx,{count:9,format:'groups_playoff'})
  await asActor(ctx,'owner','select generate_groups($1,3)',[t.id])
  for(const m of await stageRows(t.id,'group'))await save('owner',m,'tennis',m.side_b_entry_id)
  const originalGroups=await stageRows(t.id,'group')
  const originalSets=(await ctx.db.query('select * from match_sets where match_id=any($1::uuid[]) order by id',[originalGroups.map(m=>m.id)])).rows
  for(let run=0;run<2;run++){
    await asActor(ctx,'editor','select generate_group_playoff($1)',[t.id])
    const initial=await stageRows(t.id,'winners')
    const qualifiers=initial.filter(m=>m.round_number===1).flatMap(m=>[m.side_a_entry_id,m.side_b_entry_id].filter(Boolean))
    assert.equal(qualifiers.length,6)
    checkDraw(initial,qualifiers,'six qualifiers')
    assert.equal((await complete(t.id,'winners','tennis',qualifiers[0])).played,5)
    assert.deepEqual(await stageRows(t.id,'group'),originalGroups)
    assert.deepEqual((await ctx.db.query('select * from match_sets where match_id=any($1::uuid[]) order by id',[originalGroups.map(m=>m.id)])).rows,originalSets)
  }
  await drop(t.id)
})

test('unsupported double-elimination counts 3–63 fail before DELETE and preserve existing scores and snapshots',async()=>{
  // A DELETE trigger detects even attempted writes before the validation error;
  // unchanged snapshots alone would only prove transaction rollback.
  await ctx.db.exec(`create function reject_test_delete() returns trigger language plpgsql as $$ begin raise exception 'DELETE before validation'; end $$;
    create trigger guard_test_delete_matches before delete on matches for each statement execute function reject_test_delete();
    create trigger guard_test_delete_sets before delete on match_sets for each statement execute function reject_test_delete();`)
  const t=await fixture(ctx,{count:64,format:'double_elimination'})
  try{
    // Privileged synthetic existing result, without invoking DELETE generators.
    const m=(await ctx.db.query("insert into matches(tournament_id,stage,round_number,match_number,side_a_entry_id,side_b_entry_id,status) values($1,'winners',1,1,$2,$3,'ready') returning *",[t.id,t.entries[0],t.entries[1]])).rows[0]
    await ctx.db.query("insert into match_sets(match_id,set_index,side_a_games,side_b_games) values($1,1,6,0)",[m.id])
    for(let n=3;n<64;n++){
      if((n&(n-1))===0)continue
      await ctx.db.query("update entries set status=case when id=any($1::uuid[]) then 'approved'::registration_status else 'pending'::registration_status end where tournament_id=$2",[t.entries.slice(0,n),t.id])
      for(const fn of ['generate_bracket','rebuild_bracket'])await assertDeniedUnchanged(ctx,'owner',`select ${fn}($1)`,[t.id],/power-of-two/)
    }
  }finally{
    await ctx.db.exec('drop trigger guard_test_delete_matches on matches; drop trigger guard_test_delete_sets on match_sets; drop function reject_test_delete()')
    await drop(t.id)
  }
})

test('all supported double-elimination sizes 2,4,8,16,32,64 reach the single grand final',async()=>{
  for(const n of [2,4,8,16,32,64]){
    const t=await fixture(ctx,{count:n,format:'double_elimination',sport:'football'})
    await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
    let played=0
    while(true){
      const rows=await matches(ctx,t.id)
      const m=rows.find(m=>m.status==='ready')
      if(!m){assert.ok(rows.every(m=>m.status==='finished'),`DE ${n} stuck`);break}
      await save('editor',m,'football',played%2?m.side_a_entry_id:m.side_b_entry_id)
      assert.ok(++played<=2*n-2)
    }
    assert.equal(played,2*n-2)
    const final=(await matches(ctx,t.id)).find(m=>m.stage==='grand_final')
    assert.ok(final.winner_entry_id)
    await drop(t.id)
  }
})

test('correction in a completed BYE bracket is blocked pending safe graph rollback',async()=>{
  const t=await fixture(ctx,{count:6})
  await asActor(ctx,'owner',"select generate_bracket($1,'manual',$2::uuid[])",[t.id,t.entries])
  const first=(await stageRows(t.id,'main')).find(m=>m.round_number===1&&m.status==='ready')
  await complete(t.id,'main','tennis',first.side_a_entry_id)
  const before=await snapshot(ctx)
  await assert.rejects(save('editor',first,'tennis',first.side_b_entry_id),/downstreamStarted/)
  assert.deepEqual(await snapshot(ctx),before)
  await drop(t.id)
})

test('knockout migration is repeatable, matches canonical functions and preserves data, owners and ACLs',async()=>{
  const t=await fixture(ctx,{count:4})
  await asActor(ctx,'owner','select generate_bracket($1)',[t.id])
  const m=(await matches(ctx,t.id)).find(m=>m.status==='ready')
  await save('editor',m,'tennis',m.side_a_entry_id)
  const before=await snapshot(ctx)
  const definitions=async()=>(await ctx.db.query("select oid::regprocedure::text as signature,pg_get_functiondef(oid) as body,proowner,proacl::text from pg_proc where pronamespace='public'::regnamespace order by oid")).rows
  const functions=await definitions()
  const migration=await readFile(new URL('../supabase/upgrades/20260905205404_fix_knockout_byes.sql',import.meta.url),'utf8')
  for(let pass=0;pass<2;pass++){
    await ctx.db.exec(migration)
    assert.deepEqual(await snapshot(ctx),before)
    assert.deepEqual(await definitions(),functions)
    const checks=await ctx.db.exec(await readFile(new URL('../supabase/checks/knockout_byes.sql',import.meta.url),'utf8'))
    assert.equal(checks[0].rows.length,3)
    assert.ok(checks[0].rows.every(r=>r.passed===true),JSON.stringify(checks[0].rows))
    assert.deepEqual(checks[1].rows,[])
    const access=await ctx.db.exec(await readFile(new URL('../supabase/checks/internal_rpc_access.sql',import.meta.url),'utf8'))
    assert.equal(access[0].rows.length,6)
    assert.ok(access[0].rows.every(r=>r.function_exists&&!r.public_execute&&!r.anon_execute&&!r.authenticated_execute))
    assert.ok(access[1].rows.every(r=>r.authenticated_execute))
  }
  await drop(t.id)
})
