import assert from 'node:assert/strict'
import { test } from 'node:test'
import { changeoverSwapped } from '../src/lib/liveSides.js'
import { pointLabel, scoreLine } from '../src/lib/useTennisScoring.js'
import { DEFAULT_TENNIS_RULES, liveRuleHint } from '../src/lib/tennisRules.js'
import { tennisRuleMessages } from '../src/i18n/tennisRules.js'
const state=(patch={})=>({points:{a:0,b:0},games:{a:6,b:6},sets:[],setsWon:{a:0,b:0},currentSet:1,requiredSets:2,isTiebreak:true,
  tiebreakPoints:{a:0,b:0},tiebreakTo:7,tiebreakMargin:2,rules:{...DEFAULT_TENNIS_RULES},winner:null,...patch})
test('live display keeps points separate from games, shows match tiebreak and never duplicates a finished set',()=>{
  const s=state({tiebreakPoints:{a:8,b:8}})
  assert.equal(pointLabel(s,'a'),'8');assert.equal(scoreLine(s),'6:6')
  s.isMatchTiebreak=true;s.games={a:0,b:0};assert.equal(scoreLine(s),'[8:8]')
  s.winner='a';s.sets=[{set_index:3,score_kind:'match_tiebreak',side_a_games:0,side_b_games:0,side_a_tiebreak:10,side_b_tiebreak:8}]
  assert.equal(scoreLine(s),'[10:8]')
})
test('standard and alternative tiebreak changeovers follow total points, including undo',()=>{
  for(const [mode,expected] of [['every_six',[false,false,false,false,false,false,true,true,true,true,true,true,false]],
    ['one_then_four',[false,true,true,true,true,false,false,false,false,true,true,true,true]]]){
    for(let p=0;p<expected.length;p++){
      const s=state({rules:{...DEFAULT_TENNIS_RULES,changeover:mode},tiebreakPoints:{a:Math.ceil(p/2),b:Math.floor(p/2)}})
      assert.equal(changeoverSwapped(s),expected[p],`${mode}, ${p}`)
    }
  }
})
test('5-point short tiebreak changes ends exactly once after point four',()=>{
  for(let p=0;p<=8;p++)assert.equal(changeoverSwapped(state({games:{a:4,b:4},tiebreakTo:5,tiebreakMargin:1,
    tiebreakPoints:{a:Math.ceil(p/2),b:Math.floor(p/2)},rules:{...DEFAULT_TENNIS_RULES,set_rule:'short',short_tiebreak_to:5}})),p>=4)
})
test('completed tiebreak keeps its internal changeovers and does not double-count the final point',()=>{
  // 12 regular games: 6 changes; 7:5 tiebreak: change at point 6 and
  // once at the end of the set (point 12). Eight changes in total.
  const s=state({isTiebreak:false,games:{a:0,b:0},currentSet:2,sets:[{set_index:1,side_a_games:7,side_b_games:6,side_a_tiebreak:7,side_b_tiebreak:5}]})
  assert.equal(changeoverSwapped(s),false)
  s.sets[0].side_a_tiebreak=7;s.sets[0].side_b_tiebreak=0
  assert.equal(changeoverSwapped(s),false)
  s.sets[0].side_a_tiebreak=10;s.sets[0].side_b_tiebreak=8
  assert.equal(changeoverSwapped(s),true)
  s.winner='a';s.games={a:7,b:6};assert.equal(changeoverSwapped(s),true)
})
test('all new labels exist in Russian, English and Lithuanian; No-Ad and tiebreak hints distinguish scoring',()=>{
  const keys=Object.keys(tennisRuleMessages.ru).sort()
  for(const locale of ['en','lt'])assert.deepEqual(Object.keys(tennisRuleMessages[locale]).sort(),keys)
  const t=(key,args)=>({key,args})
  assert.equal(liveRuleHint(state({isTiebreak:false,points:{a:3,b:3},rules:{game_rule:'no_ad'}}),t).key,'tennisRules.decidingPoint')
  assert.equal(liveRuleHint(state({isMatchTiebreak:true,tiebreakTo:10}),t).key,'tennisRules.liveMatchTiebreak')
})
