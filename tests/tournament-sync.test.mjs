import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSnapshotRefresh, isTournamentEvent, subscribeTournament, subscribeRefreshTriggers } from '../src/lib/tournamentSync.js'
const deferred=()=>{ let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return {promise,resolve,reject} }
const tick=()=>new Promise(r=>setImmediate(r))
const state={entries:[{id:'e'}],matches:[{id:'m'}],sets:[{id:'s'}],live:[{id:'l'}],groups:[{id:'g'}]}

test('page recovery works without a tournament channel and is removed on departure', t => {
 t.mock.timers.enable({ apis: ['setInterval'] })
 const win = new EventTarget(), doc = new EventTarget(); doc.visibilityState = 'visible'
 let requests = 0
 const stop = subscribeRefreshTriggers({ refresh: () => requests++, windowTarget: win, documentTarget: doc, pollMs: 100 })
 win.dispatchEvent(new Event('online')); win.dispatchEvent(new Event('focus'))
 doc.dispatchEvent(new Event('visibilitychange')); t.mock.timers.tick(100)
 assert.equal(requests, 4)
 doc.visibilityState = 'hidden'; t.mock.timers.tick(100); assert.equal(requests, 4)
 stop(); doc.visibilityState = 'visible'; win.dispatchEvent(new Event('online')); win.dispatchEvent(new Event('focus'))
 doc.dispatchEvent(new Event('visibilitychange')); t.mock.timers.tick(1000); assert.equal(requests, 4)
})

test('PK-only DELETE invalidates known rows across tables and ignores other tournaments',()=>{
 for(const [table,id] of [['entries','e'],['matches','m'],['match_sets','s'],['live_scores','l'],['groups','g'],['tournaments','t']]) {
  assert.equal(isTournamentEvent({table,eventType:'DELETE',old:{id}},'t',state),true)
  assert.equal(isTournamentEvent({table,eventType:'DELETE',old:{id:'other'}},'t',state),false)
 }
 assert.equal(isTournamentEvent({table:'matches',eventType:'INSERT',new:{id:'new',tournament_id:'t'}},'t',state),true)
 assert.equal(isTournamentEvent({table:'matches',eventType:'UPDATE',new:{id:'m',tournament_id:'other'}},'t',state),false)
 assert.equal(isTournamentEvent({table:'match_sets',eventType:'INSERT',new:{id:'new',match_id:'m'}},'t',state),true)
 assert.equal(isTournamentEvent({table:'group_entries',eventType:'DELETE',old:{id:'membership'}},'t',state),true)
})
test('bursts are coalesced; a read invalidated by DELETE cannot resurrect the removed match',async()=>{
 const reads=[],applied=[]
 const q=createSnapshotRefresh({read:()=>{const d=deferred();reads.push(d);return d.promise},apply:x=>applied.push(x),onError:assert.fail})
 const done=q.refresh();for(let i=0;i<50;i++)q.request()
 assert.equal(reads.length,1);reads[0].resolve({matches:['deleted']});await tick()
 assert.equal(reads.length,2);assert.deepEqual(applied,[])
 reads[1].resolve({matches:['replacement']});assert.equal(await done,true)
 assert.deepEqual(applied,[{matches:['replacement']}]);q.dispose()
})
test('manual refresh waits for the newest event received while a read is in flight',async()=>{
 const reads=[],applied=[]
 const q=createSnapshotRefresh({read:()=>{const d=deferred();reads.push(d);return d.promise},apply:x=>applied.push(x),onError:assert.fail})
 const a=q.refresh(),b=q.refresh();reads[0].resolve('old');await tick();reads[1].resolve('new')
 assert.deepEqual(await Promise.all([a,b]),[true,true]);assert.deepEqual(applied,['new']);q.dispose()
})
test('a transient failure retains the last snapshot and retries without a new event',async t=>{
 t.mock.timers.enable({apis:['setTimeout']})
 let calls=0,shown='existing',errors=0
 const q=createSnapshotRefresh({read:async()=>{if(++calls===1)throw Error('offline');return 'updated'},apply:x=>shown=x,onError:()=>errors++,retryDelay:100})
 assert.equal(await q.refresh(),false);assert.equal(shown,'existing');assert.equal(errors,1)
 t.mock.timers.tick(100);await tick();assert.equal(shown,'updated');assert.equal(calls,2);q.dispose()
})
test('late success/error after leaving a page cannot alter its state or start a retry',async()=>{
 for(const fail of [false,true]) {
  const d=deferred();let changed=false
  const q=createSnapshotRefresh({read:()=>d.promise,apply:()=>changed=true,onError:()=>changed=true})
  const done=q.refresh();q.dispose();fail?d.reject(Error('late')):d.resolve('late')
  assert.equal(await done,false);assert.equal(changed,false);assert.equal(await q.refresh(),false)
 }
})
test('subscription catches initial/rejoin gaps, online, focus, visibility, silent loss, and cleans up',t=>{
 t.mock.timers.enable({apis:['setInterval']})
 const win=new EventTarget(),doc=new EventTarget();doc.visibilityState='visible'
 const bindings=[];let subscription,requests=0,removed=0
 const channel={on(type,filter,callback){bindings.push({type,filter,callback});return this},subscribe(cb){subscription=cb;return this}}
 const stop=subscribeTournament({client:{channel:()=>channel,removeChannel:()=>removed++},id:'t',name:'test',getState:()=>state,refresh:()=>requests++,windowTarget:win,documentTarget:doc,pollMs:100})
 for(const s of ['SUBSCRIBED','CHANNEL_ERROR','SUBSCRIBED'])subscription(s)
 assert.equal(requests,2)
 bindings.find(b=>b.type==='system').callback({extension:'postgres_changes',status:'ok'});assert.equal(requests,3)
 win.dispatchEvent(new Event('online'));win.dispatchEvent(new Event('focus'));doc.dispatchEvent(new Event('visibilitychange'));assert.equal(requests,6)
 t.mock.timers.tick(100);assert.equal(requests,7)
 doc.visibilityState='hidden';t.mock.timers.tick(100);assert.equal(requests,7)
 const deletion=bindings.find(b=>b.filter.table==='matches'&&b.filter.event==='DELETE')
 assert.equal(deletion.filter.filter,undefined)
 deletion.callback({table:'matches',eventType:'DELETE',old:{id:'m'}});assert.equal(requests,8)
 stop();subscription('SUBSCRIBED');win.dispatchEvent(new Event('online'));t.mock.timers.tick(1000)
 deletion.callback({table:'matches',eventType:'DELETE',old:{id:'m'}});assert.equal(requests,8);assert.equal(removed,1)
})
