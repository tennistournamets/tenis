import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookup, makeT } from './helpers/messages.mjs'
import { bracketPlan, groupPlan, roundRobinPlan } from '../src/lib/formatPlan.js'
import { countText, pluralParams } from '../src/lib/plural.js'

const ru = makeT('ru'), en = makeT('en'), lt = makeT('lt')

test('russian counts agree with their numbers', () => {
  assert.equal(countText(ru, 'ru', 'participants', 4), '4 участника')
  assert.equal(countText(ru, 'ru', 'participants', 21), '21 участник')
  assert.equal(countText(ru, 'ru', 'matches', 3), '3 матча')
  assert.equal(countText(ru, 'ru', 'matches', 6), '6 матчей')
  assert.equal(countText(ru, 'ru', 'rounds', 5), '5 раундов')
  assert.equal(countText(ru, 'ru', 'byes', 1), '1 проходит первый раунд без игры')
})

test('plans read naturally: «4 участника → 3 матча», «1 проходит», «5 раундов»', () => {
  assert.equal(ru('admin.bracketPlanSE', pluralParams(bracketPlan(4), ru, 'ru')), '4 участника → сетка на 4: 2 раунда, 3 матча.')
  assert.equal(ru('admin.bracketPlanByes', pluralParams(bracketPlan(7), ru, 'ru')), '7 участников → сетка на 8: 3 раунда, 1 проходит первый раунд без игры.')
  assert.equal(ru('standings.rrPlan', pluralParams(roundRobinPlan(6), ru, 'ru')), '6 участников → 15 матчей, 5 раундов. Каждый сыграет с каждым.')
  assert.ok(ru('admin.bracketPlanDE', pluralParams(bracketPlan(4, 'double_elimination'), ru, 'ru'))
    .startsWith('4 участника → верхняя сетка: 3 матча, нижняя: 2 матча, финал.'))
  const g = groupPlan(8, 2)
  assert.match(ru('admin.groupPlan', pluralParams({ groups: g.groups, size: 4, matches: g.matches, advance: 2, qualifiers: 4 }, ru, 'ru')), /^2 группы по 4 · 12 матчей в группах/)
  assert.equal(en('admin.bracketPlanByes', pluralParams(bracketPlan(7), en, 'en')), '7 entries → draw of 8: 3 rounds, 1 bye in round one.')
  assert.equal(lt('standings.rrPlan', pluralParams(roundRobinPlan(4), lt, 'lt')), '4 dalyviai → 6 rungtynės, 3 raundai. Kiekvienas žais su kiekvienu.')
  assert.equal(countText(lt, 'lt', 'participants', 10), '10 dalyvių')
})

test('every plural noun has the categories its locale uses', () => {
  const needed = { ru: [1, 2, 5, 1.5], en: [1, 2], lt: [1, 2, 10, 1.5] }
  for (const [locale, samples] of Object.entries(needed)) for (const noun of Object.keys(lookup(locale, 'plural'))) {
    for (const n of samples) {
      const cat = new Intl.PluralRules(locale).select(n)
      assert.equal(typeof lookup(locale, `plural.${noun}.${cat}`), 'string', `${locale} ${noun} ${cat}`)
    }
  }
})

test('lithuanian uses one bracket word and translated live/tie-break terms', () => {
  assert.equal(lookup('lt', 'admin.winnersBracket'), 'Viršutinis tinklelis')
  assert.equal(lookup('lt', 'admin.losersBracket'), 'Apatinis tinklelis')
  assert.equal(lookup('lt', 'live.tiebreak'), 'Pratęsimas')
  assert.doesNotMatch(lookup('lt', 'live.scoringTitle'), /Live/)
})
