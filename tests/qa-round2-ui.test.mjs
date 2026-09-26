import assert from 'node:assert/strict'
import { test } from 'node:test'
import { lookup, makeT } from './helpers/messages.mjs'
import { advanceOptions, advanceToSend, effectiveAdvance } from '../src/lib/groupsFlow.js'
import { groupAdvanceWarning, groupPlan } from '../src/lib/formatPlan.js'
import { finishConfirmation } from '../src/lib/tournamentChampion.js'
import { errorMessage } from '../src/lib/errorMessages.js'

const LOCALES = ['ru', 'en', 'lt']
const ru = makeT('ru')
const m = (id, stage, round, extra = {}) => ({ id, stage, round_number: round, match_number: 1, status: 'pending',
  side_a_entry_id: 'a', side_b_entry_id: 'b', winner_entry_id: null, next_match_id: 'x', ...extra })

// R2-01 / R2-05 ---------------------------------------------------------------

test('R2-01, R2-05: the new server codes are translated in every locale', () => {
  for (const key of ['lifecycle.rosterStale', 'schedule.errors.matchFinished', 'schedule.errors.matchLive', 'groupsFlow.advanceWarning_all',
    'groupsFlow.advanceWarning_almostAll', 'bracket.tourN', 'admin.rebuildMatchesConfirm', 'admin.startNeedMatches']) {
    for (const locale of LOCALES) assert.equal(typeof lookup(locale, key), 'string', `${locale}: ${key}`)
  }
  assert.match(errorMessage({ message: 'lifecycle.rosterStale' }, ru), /Пересоздайте матчи/)
  assert.match(errorMessage({ message: 'schedule.matchFinished' }, ru), /уже сыгран/)
})

// R2-02 -----------------------------------------------------------------------

test('R2-02: the wizard value of "advance per group" survives a field that is still too small', () => {
  // Wizard stored 3; the organizer approves entries one by one.
  for (const n of [0, 2, 4, 5]) {
    const options = advanceOptions(n, 2)
    const shown = effectiveAdvance(options, 3, null)
    assert.ok(!options.length || options.includes(shown), `n=${n}`)
  }
  assert.equal(effectiveAdvance(advanceOptions(0, 2), 3, null), 3)
  assert.equal(effectiveAdvance(advanceOptions(4, 2), 3, null), 2)
  // Enough entries again: the stored 3 comes back instead of a reset 1 or 2.
  assert.equal(effectiveAdvance(advanceOptions(12, 2), 3, null), 3)
  // The organizer's own pick wins over the stored value.
  assert.equal(effectiveAdvance(advanceOptions(12, 2), 3, 1), 1)
  assert.equal(effectiveAdvance([], null, null), 2)
})

test('R2-02: generation keeps the stored value unless the organizer changed it or it does not fit', () => {
  assert.equal(advanceToSend(advanceOptions(12, 2), 3, null), null)
  assert.equal(advanceToSend(advanceOptions(12, 2), 3, 2), 2)
  assert.equal(advanceToSend(advanceOptions(4, 2), 3, null), 2)
  assert.equal(advanceToSend(advanceOptions(8, 2), null, null), 2)
})

// R2-04 -----------------------------------------------------------------------

test('R2-04: the group plan warns when (almost) everyone advances', () => {
  assert.equal(groupAdvanceWarning(groupPlan(9, 4, 2)), 'almostAll') // 8 of 9
  assert.equal(groupAdvanceWarning(groupPlan(8, 4, 2)), 'all')
  assert.equal(groupAdvanceWarning(groupPlan(12, 2, 2)), null)
  assert.equal(groupAdvanceWarning(groupPlan(12, 2, 3)), null)
  assert.equal(groupAdvanceWarning(groupPlan(2, 1, 2)), null)
  assert.equal(ru('groupsFlow.advanceWarning_almostAll', { qualifiers: 8, n: 9 }).includes('8 из 9'), true)
})

// R2-03 -----------------------------------------------------------------------

test('R2-03: the finish dialog names matches like the board, without "bracket" in round robin', () => {
  const titles = (format, matches, groups = []) => finishConfirmation({ format, matches, groups, t: ru }).options.details.items.map(i => i.title)
  // Double elimination of 4.
  const de = [m('w1', 'winners', 1), m('w2', 'winners', 2), m('l1', 'losers', 1), m('l2', 'losers', 2), m('gf', 'grand_final', 1, { next_match_id: null })]
  assert.deepEqual(titles('double_elimination', de), ['Верхняя сетка · Полуфинал · №1', 'Верхняя сетка · Финал · №1', 'Нижняя сетка · Раунд 1 · №1', 'Нижняя сетка · Раунд 2 · №1', 'Гранд-финал'])
  // Round robin: tours only.
  assert.deepEqual(titles('round_robin', [m('r1', 'main', 1), m('r2', 'main', 2)]), ['Тур 1 · №1', 'Тур 2 · №1'])
  // Groups: the letter and the tour; the playoff by its round name.
  const gp = [m('g', 'group', 1002, { group_id: 'gB' }), m('p', 'winners', 1, { next_match_id: null })]
  assert.deepEqual(titles('groups_playoff', gp, [{ id: 'gB', name: 'B' }]), ['Группа B · Тур 2 · №1', 'Финал · №1'])
  for (const title of titles('round_robin', [m('r1', 'main', 1)])) assert.doesNotMatch(title, /сетк/i)
})
