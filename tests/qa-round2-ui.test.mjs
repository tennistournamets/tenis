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

// R2-07 … R2-20 ---------------------------------------------------------------

import { readFileSync } from 'node:fs'
import { matchScoreCheck, scoreRows } from '../src/lib/tennisRules.js'
import { completedSetCount, isByeMatch } from '../src/lib/bracketDisplay.js'
import { categoryLabelKey } from '../src/lib/sportConfig.js'
import { displayStatus } from '../src/lib/tournamentStatus.js'
import { sameNameMember } from '../src/lib/registrationRules.js'

const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8')
const sets = (...list) => scoreRows(list.map(([a, b, ta, tb], i) => ({ set_index: i + 1, side_a_games: a, side_b_games: b, side_a_tiebreak: ta ?? '', side_b_tiebreak: tb ?? '' })))

test('R2-07: the theme toggle reports its state; entry buttons name the participant', () => {
  assert.match(read('src/components/ThemeToggle.vue'), /:aria-pressed="theme === 'dark'/)
  const view = read('src/views/AdminTournamentView.vue')
  assert.equal((view.match(/t\('a11y\.entryAction', \{ action: t\('admin\.(approve|reject)'\), name: entryLabel\(entry\) \}\)/g) || []).length, 4)
  assert.equal(ru('a11y.entryAction', { action: 'Подтвердить', name: 'Анна' }), 'Подтвердить: Анна')
})

test('R2-08: BYE passes are not listed among the matches to score', () => {
  assert.match(read('src/components/ScoreEditor.vue'), /props\.matches\.filter\(m => !isByeMatch\(m\)\)/)
  assert.equal(isByeMatch({ status: 'finished', side_a_entry_id: 'a', side_b_entry_id: null, winner_entry_id: 'a' }), true)
})

test('R2-09: editing a score clears the error raised for the previous one', () => {
  assert.match(read('src/components/ScoreEditor.vue'), /first\.error !== t\('scoringFlow\.conflict'\)\) first\.error = ''/)
  assert.match(read('src/components/MatchScoreModal.vue'), /errorText\.value !== t\('scoringFlow\.conflict'\) && !saving\.value\) errorText\.value = ''/)
})

test('R2-10: a pick-random doubles form says the partner is optional', () => {
  assert.match(read('src/components/RegistrationForm.vue'), /showMemberTwoOptional \? 'registrationForm\.doublesRandomNote'/)
  for (const locale of LOCALES) assert.equal(typeof lookup(locale, 'registrationForm.doublesRandomNote'), 'string', locale)
})

test('R2-11: the score preview judges sets like the server', () => {
  const check = (...list) => matchScoreCheck(sets(...list), {}, 'best_of_3')
  assert.equal(check([6, 5], [6, 3]).problem, 'partialLast')
  assert.equal(check([8, 6], [6, 3]).problem, 'invalidScore')
  assert.equal(check([6, 4], [6, 4], [6, 0]).problem, 'matchOver')
  assert.equal(check([6, 4], [], [6, 0]).problem, 'setOrder')
  assert.equal(check([6, 4], [6, 5]).problem, 'needWinner')
  assert.equal(check([6, 4], [7, 5]).winner, true)
  assert.equal(check([6, 4], [7, 6, 7, 3]).winner, true)
  assert.equal(check([6, 4], [7, 6, 3, 7]).problem, 'invalidScore')
  // Advantage sets have no tie-break: 8:6 is a normal win there.
  assert.equal(matchScoreCheck(sets([8, 6], [6, 4]), { tennis: { set_rule: 'advantage' } }, 'best_of_3').winner, true)
  // Short sets to 4 with a tie-break at 3:3: 4:2 and 4:3 win, 5:3 cannot happen.
  const short = { tennis: { set_rule: 'short', short_tiebreak_at: 3 } }
  assert.equal(matchScoreCheck(sets([4, 2], [4, 3, 7, 5]), short, 'best_of_3').winner, true)
  assert.equal(matchScoreCheck(sets([5, 3], [4, 2]), short, 'best_of_3').problem, 'invalidScore')
})

test('R2-12: a set left open by a stopped live match is not counted as won', () => {
  assert.equal(completedSetCount({ status: 'ready', side_a_score: 0, side_b_score: 0 }), 0)
  assert.equal(completedSetCount({ status: 'ready', side_a_score: 1, side_b_score: 0 }), 1)
  assert.equal(completedSetCount({ status: 'finished', side_a_score: 2, side_b_score: 1 }), Infinity)
  assert.match(read('src/components/GroupStageBoard.vue'), /won: i < completed &&/)
})

test('R2-13: the date picker controls and the required message follow the page language', () => {
  const field = read('src/components/DateTimeField.vue')
  assert.match(field, /:aria-labels="ariaLabels"/)
  for (const key of ['prevMonth', 'nextMonth', 'openMonthsOverlay', 'incrementValue']) assert.match(field, new RegExp(`${key}:`))
  assert.match(field, /setCustomValidity\(t\('actions\.dateTimeRequired'\)\)/)
  for (const locale of LOCALES) {
    for (const key of ['prevMonth', 'nextMonth', 'increment', 'hours']) assert.equal(typeof lookup(locale, `actions.datePicker.${key}`), 'string', `${locale} ${key}`)
  }
  assert.equal(ru('actions.datePicker.increment', { unit: ru('actions.datePicker.hours') }), 'Увеличить: часы')
})

test('R2-14: a padel card names its (always doubles) category; football does not', () => {
  assert.equal(categoryLabelKey('padel', 'doubles'), 'tournament.doubles')
  assert.equal(categoryLabelKey('tennis', 'singles'), 'tournament.singles')
  assert.equal(categoryLabelKey('football', 'singles'), null)
})

test('R2-15: registration open past its deadline shows as closed', () => {
  const now = Date.parse('2026-09-26T12:00:00Z')
  assert.equal(displayStatus({ status: 'registration_open', registration_deadline: '2026-09-25T12:00:00Z' }, now), 'registration_closed')
  assert.equal(displayStatus({ status: 'registration_open', registration_deadline: '2026-09-27T12:00:00Z' }, now), 'registration_open')
  assert.equal(displayStatus({ status: 'registration_open', registration_deadline: null }, now), 'registration_open')
  assert.equal(displayStatus({ status: 'in_progress', registration_deadline: '2026-09-25T12:00:00Z' }, now), 'in_progress')
  assert.match(read('src/views/AdminTournamentListView.vue'), /registration_deadline,/)
})

test('R2-16: padel has no badminton emoji on the public page', () => {
  assert.doesNotMatch(read('src/views/PublicTournamentView.vue'), /🏸/)
})

test('R2-17: adding a participant whose name is already entered asks first', () => {
  const entries = [
    { status: 'approved', entry_members: [{ member_name: 'Marta Kowalska' }, { member_name: 'Ewa Nowak' }] },
    { status: 'rejected', entry_members: [{ member_name: 'Old Name' }] },
  ]
  assert.equal(sameNameMember(entries, [' marta   kowalska ', '']), 'Marta Kowalska')
  assert.equal(sameNameMember(entries, ['Ewa Nowak', 'Someone']), 'Ewa Nowak')
  assert.equal(sameNameMember(entries, ['Old Name']), null)
  assert.equal(sameNameMember(entries, ['New Player']), null)
  assert.match(read('src/components/admin/ManualEntryForm.vue'), /confirmDialog\(t\('admin\.addEntrySameName'/)
})

test('R2-19: padel settings let the organizer change the tie-break before the start', () => {
  const form = read('src/components/admin/TournamentSettingsForm.vue')
  assert.match(form, /<select id="adm-tiebreak" v-model\.number="padelTiebreak" class="input" :disabled="structureDisabled">/)
})

test('R2-20: the entry lists show the chosen bracket name', () => {
  const view = read('src/views/AdminTournamentView.vue')
  assert.equal((view.match(/class="entry-alias">\{\{ t\('admin\.shownAs'/g) || []).length, 4)
  for (const locale of LOCALES) assert.equal(typeof lookup(locale, 'admin.shownAs'), 'string', locale)
})
