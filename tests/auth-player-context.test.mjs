import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {compileFunction} from 'node:vm'
import {test} from 'node:test'
import {createPinia,defineStore} from 'pinia'

// Execute the actual store with its two imports injected, so no browser env or
// Auth network is needed. Store action bodies are not copied into the test.
const source=readFileSync(new URL('../src/stores/auth.js',import.meta.url),'utf8')
  .replace(/^import .*\n/gm,'').replace('export const useAuthStore','const useAuthStore')
const build=compileFunction(source+'\nreturn useAuthStore;',['defineStore','supabase'])
function store(result){
  const queries=[]
  const api={from(table){return {select(){return this},eq(column,value){queries.push({table,column,value});return this},maybeSingle(){return result()}}},auth:{async signOut(){return {error:null}}}}
  return {auth:build(defineStore,api)(createPinia()),queries}
}
function profileStore(results) {
  const calls=[]
  const api={
    from(table) {
      const query={table,operation:'',values:null,filters:[]}
      return {
        update(values){query.operation='update';query.values=values;return this},
        insert(values){query.operation='insert';query.values=values;return this},
        eq(column,value){query.filters.push({column,value});return this},
        select(){return this},
        single(){calls.push(structuredClone(query));return Promise.resolve(results.shift())},
      }
    },
    auth:{async signOut(){return {error:null}}},
  }
  return {auth:build(defineStore,api)(createPinia()),calls}
}
const session=id=>({user:{id}})

test('switching accounts or signing out clears the previous private profile and roles',async()=>{
  const {auth}=store(async()=>({data:null,error:null}))
  auth.applySession(session('a'))
  auth.currentPlayer={id:'profile-a',display_name:'A'}
  auth.playerContextLoaded=true
  auth.platformRole='superadmin'
  auth.tournamentRoles=['owner']
  auth.tournamentRolesLoaded=true
  auth.applySession(session('b'))
  assert.equal(auth.currentPlayer,null)
  assert.equal(auth.playerContextLoaded,false)
  assert.equal(auth.platformRole,null)
  assert.deepEqual(auth.tournamentRoles,[])
  auth.currentPlayer={id:'profile-b'}
  await auth.signOut()
  assert.equal(auth.currentPlayer,null)
  assert.equal(auth.user,null)
})

test('a slow profile response from the previous account cannot populate the current account',async()=>{
  let resolve
  const {auth,queries}=store(()=>new Promise(r=>{resolve=r}))
  auth.applySession(session('a'))
  const pending=auth.loadPlayerContext()
  auth.applySession(session('b'))
  resolve({data:{id:'profile-a'},error:null})
  await pending
  assert.deepEqual(queries,[{table:'players',column:'user_id',value:'a'}])
  assert.equal(auth.currentPlayer,null)
  assert.equal(auth.playerContextLoaded,false)
})

test('a slow role response from the previous account cannot authorize the current account',async()=>{
  let resolveRoles
  const roleResult=new Promise(resolve=>{resolveRoles=resolve})
  const api={
    from(){
      const query={
        select(){return query},
        eq(){return query},
        then(resolve,reject){return roleResult.then(resolve,reject)},
      }
      return query
    },
    auth:{async signOut(){return {error:null}}},
  }
  const auth=build(defineStore,api)(createPinia())
  auth.applySession(session('a'))
  const pending=auth.loadTournamentRoles()
  auth.applySession(session('b'))
  resolveRoles({data:[{role:'owner'}],error:null})
  await pending
  assert.deepEqual(auth.tournamentRoles,[])
  assert.equal(auth.tournamentRolesLoaded,false)
})

test('profile errors remain retryable and same-user token refresh preserves the loaded profile',async()=>{
  let fail=true
  const {auth}=store(async()=>fail?{data:null,error:new Error('query failed')}:{data:{id:'profile-a'},error:null})
  auth.applySession(session('a'))
  await assert.rejects(auth.loadPlayerContext(),/query failed/)
  assert.equal(auth.playerContextLoaded,false)
  fail=false
  await auth.loadPlayerContext()
  auth.applySession(session('a'))
  assert.equal(auth.currentPlayer.id,'profile-a')
  assert.equal(auth.playerContextLoaded,true)
})

test('profile save updates the signed-in player and normalizes the visible name', async () => {
  const row={id:'profile-a',user_id:'a',display_name:'Ada Lovelace'}
  const {auth,calls}=profileStore([{data:row,error:null}])
  auth.applySession(session('a'))
  auth.currentPlayer={id:'profile-a',user_id:'a',display_name:'Old name'}
  assert.deepEqual(await auth.savePlayerProfile('  Ada   Lovelace  '),row)
  assert.deepEqual(calls,[{
    table:'players',operation:'update',values:{display_name:'Ada Lovelace'},filters:[{column:'user_id',value:'a'}],
  }])
  assert.equal(auth.currentPlayer.display_name,'Ada Lovelace')
  assert.equal(auth.playerContextLoaded,true)
})

test('a profile load already in flight cannot overwrite a newer saved name', async () => {
  let resolveLoad
  const calls=[]
  const saved={id:'profile-a',user_id:'a',display_name:'New name'}
  const api={
    from(table) {
      const query={table,operation:'select',values:null,filters:[]}
      return {
        select(){return this},
        update(values){query.operation='update';query.values=values;return this},
        insert(values){query.operation='insert';query.values=values;return this},
        eq(column,value){query.filters.push({column,value});return this},
        maybeSingle(){return new Promise(resolve=>{resolveLoad=resolve})},
        single(){calls.push(structuredClone(query));return Promise.resolve({data:saved,error:null})},
      }
    },
    auth:{async signOut(){return {error:null}}},
  }
  const auth=build(defineStore,api)(createPinia())
  auth.applySession(session('a'))
  const pendingLoad=auth.loadPlayerContext()
  await auth.savePlayerProfile('New name')
  resolveLoad({data:{id:'profile-a',user_id:'a',display_name:'Old name'},error:null})
  await pendingLoad
  assert.equal(auth.currentPlayer.display_name,'New name')
  assert.equal(auth.playerContextLoaded,true)
  assert.deepEqual(calls.map(call=>call.operation),['insert'])
})

test('first profile save recovers when another tab wins the insert race', async () => {
  const duplicate={data:null,error:{code:'23505',message:'duplicate'}}
  const row={id:'profile-a',user_id:'a',display_name:'Ada'}
  const {auth,calls}=profileStore([duplicate,{data:row,error:null}])
  auth.applySession({user:{id:'a',user_metadata:{picture:'avatar.png'}}})
  await auth.savePlayerProfile('Ada')
  assert.deepEqual(calls.map(call=>call.operation),['insert','update'])
  assert.deepEqual(calls[0].values,{user_id:'a',display_name:'Ada',avatar_url:'avatar.png'})
  assert.equal(auth.currentPlayer.id,'profile-a')
})
