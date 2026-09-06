// Explicit manual integration check against the local project's configured API.
// Uses only its public anon key. Optional registration is confined to the named
// synthetic smoke tournament; no real Auth accounts or profile records touched.
import assert from 'node:assert/strict'
import {createClient} from '@supabase/supabase-js'
import {loadEnv} from 'vite'
const env=loadEnv('development',process.cwd(),'VITE_SUPABASE_')
const api=createClient(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_ANON_KEY,{auth:{persistSession:false,autoRefreshToken:false}})
const id=process.env.PRIVACY_SMOKE_TOURNAMENT
assert.ok(id,'Set PRIVACY_SMOKE_TOURNAMENT to the dedicated fixture UUID')
const {data:tournament,error:te}=await api.from('tournaments').select('id,slug,status,category,description').eq('id',id).single()
assert.ifError(te)
assert.equal(tournament.slug,'privacy-smoke-20260905')
assert.equal(tournament.category,'doubles')
for(const [label,request] of [
  ['contacts',api.from('entries').select('phone_or_email').eq('tournament_id',id)],
  ['wildcard',api.from('entries').select('*').eq('tournament_id',id)],
  ['contact filter',api.from('entries').select('id').eq('tournament_id',id).like('phone_or_email','%')],
  ['profiles',api.from('players').select('*').limit(1)],
]){
  const {error,status}=await request
  assert.equal(error?.code,'42501',label)
  console.log(JSON.stringify({check:label,denied:true,httpStatus:status}))
}
if(process.argv.includes('--register-and-observe')){
  let resolveApproved,rejectApproved,entryId
  const done=new Promise((resolve,reject)=>{resolveApproved=resolve;rejectApproved=reject})
  const events=[]
  const channel=api.channel('privacy-smoke-'+Date.now()).on('postgres_changes',{
    event:'*',schema:'public',table:'entries',filter:`tournament_id=eq.${id}`,
  },payload=>{
    try{
      assert.ok(!Object.hasOwn(payload.new,'phone_or_email'))
      assert.ok(!Object.hasOwn(payload.old,'phone_or_email'))
      events.push({event:payload.eventType,id:payload.new?.id,status:payload.new?.status})
      if(payload.new?.id===entryId && payload.new.status==='approved')resolveApproved()
    }catch(error){rejectApproved(error)}
  })
  await new Promise((resolve,reject)=>{channel.subscribe(status=>{
    if(status==='SUBSCRIBED')resolve()
    if(['CHANNEL_ERROR','TIMED_OUT'].includes(status))reject(new Error('Realtime subscription '+status))
  })})
  const {data,error}=await api.rpc('register_entry',{
    p_slug:tournament.slug,p_entry_type:'doubles',p_phone_or_email:`privacy-${Date.now()}@example.test`,p_member_one:'Приватность Игрок А',
  })
  assert.ifError(error);entryId=data
  const {data:pending,error:pe}=await api.from('entries').select('id,status,entry_members(member_name,member_order)').eq('id',entryId)
  assert.ifError(pe);assert.deepEqual(pending,[])
  console.log(JSON.stringify({registration:'pending and hidden',entryId,awaiting:'Approve this fixture entry through the organiser UI'}))
  const timeout=setTimeout(()=>rejectApproved(new Error('Timed out waiting for approval')),180000)
  try{
    await done
    const {data:approved,error:ae}=await api.from('entries').select('id,display_name,status,entry_members(member_name,member_order)').eq('id',entryId)
    assert.ifError(ae);assert.equal(approved.length,1);assert.equal(approved[0].status,'approved')
    assert.equal(approved[0].entry_members.length,1)
    console.log(JSON.stringify({realtime:'approved event received without contact fields',approvedRead:true,events}))
  }finally{clearTimeout(timeout);await api.removeChannel(channel)}
}else{
  const {data,error}=await api.from('entries').select('id,display_name,status,entry_members(member_name,member_order)').eq('tournament_id',id)
  assert.ifError(error);assert.ok(data.every(e=>e.status==='approved'))
  console.log(JSON.stringify({publicRows:data.length,approvedOnly:true,nestedMembersReadable:true}))
}
