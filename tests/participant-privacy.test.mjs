import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile} from 'node:fs/promises'
import {after,before,test} from 'node:test'
import {createDatabase,asActor,fixture,snapshot,assertDeniedUnchanged} from './helpers/database.mjs'

const actors=['anon','outsider','counter','editor','owner','platform_admin']
const managers=['owner','editor']
let ctx
before(async()=>{ctx=await createDatabase()})
after(async()=>{await ctx?.db.close()})

async function participants(isPublic=true){
  const t=await fixture(ctx,{count:3,isPublic,status:'registration_open'})
  await ctx.db.query("update entries set status='pending' where id=$1",[t.entries[1]])
  await ctx.db.query("update entries set status='rejected' where id=$1",[t.entries[2]])
  return t
}
async function visible(actor,id){
  return (await asActor(ctx,actor,'select id,status from entries where tournament_id=$1 order by id',[id])).rows
}
async function profiles(){
  const rows={}
  for (const [actor,userId] of Object.entries(ctx.actors)){
    rows[actor]=(await ctx.db.query(`insert into players(user_id,display_name,contact_hash,birth_year,country)
      values ($1,$2,$3,1990,'LT') returning *`,[userId,`Profile ${actor}`,`private-${randomUUID()}`])).rows[0]
  }
  return rows
}

test('public entries expose only approved rows and their members; assigned managers see all statuses',async()=>{
  const t=await participants()
  for (const actor of actors){
    const expected=managers.includes(actor)?t.entries:[t.entries[0]]
    assert.deepEqual((await visible(actor,t.id)).map(r=>r.id).sort(),expected.slice().sort(),actor)
    const members=await asActor(ctx,actor,`select em.entry_id,em.member_name from entry_members em
      where em.entry_id=any($1::uuid[]) order by em.entry_id`,[t.entries])
    assert.deepEqual(members.rows.map(m=>m.entry_id).sort(),expected.slice().sort(),actor)
    // Match the nested REST relationship at SQL/RLS level.
    const nested=await asActor(ctx,actor,`select e.id,
      (select jsonb_agg(jsonb_build_object('name',em.member_name)) from entry_members em where em.entry_id=e.id) as members
      from entries e where e.tournament_id=$1`,[t.id])
    assert.equal(nested.rows.length,expected.length)
  }
})

test('private tournament participants are limited to managers and approved rows for its counter',async()=>{
  const t=await participants(false)
  for (const actor of actors){
    const expected=managers.includes(actor)?t.entries:actor==='counter'?[t.entries[0]]:[]
    assert.deepEqual((await visible(actor,t.id)).map(r=>r.id).sort(),expected.slice().sort(),actor)
    const members=await asActor(ctx,actor,'select entry_id from entry_members where entry_id=any($1::uuid[])',[t.entries])
    assert.deepEqual(members.rows.map(r=>r.entry_id).sort(),expected.slice().sort(),actor)
  }
})

test('contact column is inaccessible through selection, wildcard, filters, row JSON and joins for every API role',async()=>{
  const t=await participants()
  for(const actor of actors){
    for(const sql of [
      'select phone_or_email from entries where tournament_id=$1',
      'select * from entries where tournament_id=$1',
      'select to_jsonb(e) from entries e where tournament_id=$1',
      "select id from entries where tournament_id=$1 and phone_or_email like '%'",
      'select id from entries where tournament_id=$1 order by phone_or_email',
      'select e.phone_or_email from entry_members em join entries e on e.id=em.entry_id where e.tournament_id=$1',
    ]) await assertDeniedUnchanged(ctx,actor,sql,[t.id],/permission denied/)
  }
  const acl=await ctx.db.query(`select has_column_privilege('anon','entries','phone_or_email','select') as anon,
    has_column_privilege('authenticated','entries','phone_or_email','select') as authenticated`)
  assert.deepEqual(acl.rows[0],{anon:false,authenticated:false})
})

test('public registration stays write-only until approval and managers retain insertion with RETURNING id',async()=>{
  const t=await fixture(ctx,{count:0,isPublic:true,status:'registration_open'})
  const {rows}=await asActor(ctx,'anon',"select register_entry($1,'singles','fixture@example.test','Private applicant') as id",[t.id])
  const id=rows[0].id
  assert.deepEqual(await visible('anon',t.id),[])
  assert.deepEqual(await visible('counter',t.id),[])
  assert.equal((await visible('owner',t.id))[0].status,'pending')
  await asActor(ctx,'editor',"update entries set status='approved' where id=$1",[id])
  assert.deepEqual(await visible('anon',t.id),[{id,status:'approved'}])
  await asActor(ctx,'owner',"update entries set status='rejected' where id=$1",[id])
  assert.deepEqual(await visible('anon',t.id),[])
  assert.deepEqual((await asActor(ctx,'anon','select member_name from entry_members where entry_id=$1',[id])).rows,[])
  for(const actor of managers){
    const {rows}=await asActor(ctx,actor,`insert into entries(tournament_id,entry_type,display_name,phone_or_email,status)
      values($1,'singles','Admin applicant',$2,'pending') returning id`,[t.id,`${actor}@example.test`])
    await asActor(ctx,actor,"insert into entry_members(entry_id,member_name,member_order) values($1,'Admin applicant',1)",[rows[0].id])
  }
  assert.equal((await visible('owner',t.id)).length,3)
})

test('random/manual pairing and splitting retain stored contacts with the restricted client projection',async()=>{
  for(const mode of ['random','manual']){
    const t=await fixture(ctx,{category:'doubles',pairing:'pick_random',status:'registration_closed'})
    const original=(await ctx.db.query('select phone_or_email from entries where tournament_id=$1',[t.id])).rows.map(r=>r.phone_or_email)
    if(mode==='random')await asActor(ctx,'owner','select form_random_pairs($1)',[t.id])
    else await asActor(ctx,'editor','select form_manual_pairs($1,$2::jsonb)',[t.id,JSON.stringify([t.entries.slice(0,2),t.entries.slice(2,4)])])
    const paired=(await ctx.db.query('select phone_or_email from entries where tournament_id=$1',[t.id])).rows
    assert.equal(paired.length,2)
    assert.ok(paired.every(r=>original.includes(r.phone_or_email)))
    await asActor(ctx,'editor','select split_pairs($1)',[t.id])
    assert.equal((await visible('owner',t.id)).length,4)
  }
})

test('profiles are visible only to their Auth owner, including when queried without a user filter',async()=>{
  const p=await profiles()
  for(const actor of actors){
    if(actor==='anon'){
      await assertDeniedUnchanged(ctx,actor,'select * from players',[],/permission denied/)
      continue
    }
    const result=await asActor(ctx,actor,'select * from players')
    assert.deepEqual(result.rows,[p[actor]],actor)
    const foreign=await asActor(ctx,actor,'select * from players where id=$1',[p[actor==='outsider'?'owner':'outsider'].id])
    assert.deepEqual(foreign.rows,[],actor)
  }
  await ctx.db.query('delete from players')
})

test('own profile editing is allowed but foreign editing, claiming, contact matching, merge and deletion are denied',async()=>{
  const p=await profiles()
  for(const actor of actors.filter(a=>a!=='anon')){
    const own=p[actor]
    await asActor(ctx,actor,"update players set display_name='Updated',avatar_url='https://example.test/avatar.png',birth_year=1991,gender='other',country='LV' where id=$1",[own.id])
    assert.equal((await asActor(ctx,actor,'select display_name from players where id=$1',[own.id])).rows[0].display_name,'Updated')
    const foreign=p[actor==='outsider'?'owner':'outsider']
    const before=await snapshot(ctx)
    const denied=await asActor(ctx,actor,"update players set display_name='Denied' where id=$1 returning id",[foreign.id])
    assert.deepEqual(denied.rows,[])
    assert.deepEqual(await snapshot(ctx),before)
    for(const [column,value] of [['id',randomUUID()],['user_id',ctx.actors.outsider],['contact_hash','forged'],['merged_into',foreign.id],['is_deleted',true]]){
      await assertDeniedUnchanged(ctx,actor,`update players set ${column}=$1 where id=$2`,[value,own.id],/permission denied/)
    }
    await assertDeniedUnchanged(ctx,actor,'delete from players where id=$1',[own.id],/permission denied/)
    await assertDeniedUnchanged(ctx,actor,'truncate players cascade',[],/permission denied/)
  }
  await ctx.db.query('delete from players')
})

test('a user can create only a fresh profile for themselves; system fields and unlinked profiles cannot be claimed',async()=>{
  const unlinked=(await ctx.db.query("insert into players(display_name) values('Unlinked') returning id")).rows[0].id
  for(const actor of actors.filter(a=>a!=='anon')){
    const {rows}=await asActor(ctx,actor,"insert into players(user_id,display_name) values($1,'Own profile') returning id,user_id",[ctx.actors[actor]])
    assert.equal(rows[0].user_id,ctx.actors[actor])
    await assertDeniedUnchanged(ctx,actor,"insert into players(user_id,display_name) values($1,'Foreign')",[randomUUID()],/row-level security/)
    await assertDeniedUnchanged(ctx,actor,"insert into players(display_name) values('Unlinked')",[],/row-level security/)
    await assertDeniedUnchanged(ctx,actor,'update players set user_id=$1 where id=$2',[ctx.actors[actor],unlinked],/permission denied/)
    for(const [column,value] of [['id',randomUUID()],['contact_hash','forged'],['merged_into',unlinked],['is_deleted',true]]){
      await assertDeniedUnchanged(ctx,actor,`insert into players(user_id,display_name,${column}) values($1,'Forged',$2)`,[ctx.actors[actor],value],/permission denied/)
    }
  }
  await assertDeniedUnchanged(ctx,'anon',"insert into players(user_id,display_name) values($1,'Anon')",[ctx.actors.owner],/permission denied/)
  await ctx.db.query('delete from players')
})

test('merged, deleted and unlinked profiles stay hidden even from their former owner',async()=>{
  const p=await profiles()
  await ctx.db.query('update players set is_deleted=true where id=$1',[p.owner.id])
  await ctx.db.query('update players set merged_into=$1 where id=$2',[p.counter.id,p.editor.id])
  await ctx.db.query("insert into players(display_name) values('Unlinked')")
  assert.deepEqual((await asActor(ctx,'owner','select * from players')).rows,[])
  assert.deepEqual((await asActor(ctx,'editor','select * from players')).rows,[])
  assert.deepEqual((await asActor(ctx,'owner',"update players set display_name='Revived' returning id")).rows,[])
  await ctx.db.query('delete from players')
})

test('privacy migration removes old table and column grants, enables RLS and is repeatable without losing data',async()=>{
  await participants()
  await profiles()
  const original=await snapshot(ctx)
  await ctx.db.exec(`grant select on entries to public,anon,authenticated;
    grant select(phone_or_email) on entries to public,anon,authenticated;
    alter table players disable row level security;
    grant all on players to public,anon,authenticated;
    grant update(user_id),insert(contact_hash) on players to public,anon,authenticated;`)
  const sql=await readFile(new URL('../supabase/upgrades/20260905202739_protect_participant_privacy.sql',import.meta.url),'utf8')
  for(let run=0;run<2;run++){
    await ctx.db.exec(sql)
    assert.deepEqual(await snapshot(ctx),original)
    await assertDeniedUnchanged(ctx,'anon','select phone_or_email from entries',[],/permission denied/)
    await assertDeniedUnchanged(ctx,'owner','update players set user_id=$1',[ctx.actors.outsider],/permission denied/)
    assert.equal((await asActor(ctx,'owner','select * from players')).rows.length,1)
    assert.equal((await ctx.db.query("select relrowsecurity from pg_class where oid='players'::regclass")).rows[0].relrowsecurity,true)
  }
})
