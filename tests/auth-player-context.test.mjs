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
