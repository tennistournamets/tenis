import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CREATE_VISIBILITY_MODES, ROLE_MATRIX, ROLES, VISIBILITY_MODES, accessError, assignableRoles, canEditMembership, clearAccessToken, isAccessExpiredError, readAccessToken, setRobotsMeta, storeAccessToken, visibilityOf } from '../src/lib/access.js'
import { scoringAccess } from '../src/lib/scoringAccess.js'
import { readFileSync } from 'node:fs'
import { accessMessages } from '../src/i18n/access.js'
import { mobileMessages } from '../src/i18n/mobile.js'

// messages.js uses extension-less imports for Vite; read it as text here.
const messagesSource = readFileSync(new URL('../src/i18n/messages.js', import.meta.url), 'utf8')

const t = (key, params) => params ? `${key}:${JSON.stringify(params)}` : key

test('visibility falls back to is_public for rows without the column and maps codes to translations', () => {
  assert.equal(visibilityOf({ visibility: 'public' }), 'public')
  assert.equal(visibilityOf({ visibility: 'weird', is_public: true }), 'link')
  assert.equal(visibilityOf({ is_public: false }), 'private')
  assert.equal(visibilityOf({ is_public: true }), 'link')
  assert.equal(visibilityOf(null), 'link')
  assert.deepEqual(VISIBILITY_MODES, ['public', 'link', 'private', 'password'])
  assert.deepEqual(CREATE_VISIBILITY_MODES, ['public', 'link', 'private'])
  assert.equal(visibilityOf({ visibility: 'password' }), 'password')
  assert.equal(accessError('access.tokenExpired', t), 'access.errors.tokenExpired')
  assert.equal(isAccessExpiredError(new Error('access.tokenExpired')), true)
  assert.equal(isAccessExpiredError(new Error('other')), false)
  assert.equal(accessError('access.lastOwner', t), 'access.errors.lastOwner')
  assert.equal(accessError('access.ownerOnly', t), 'access.errors.ownerOnly')
  assert.equal(accessError('schedule.conflict', t), 'schedule.errors.conflict')
  assert.equal(accessError('registration.full', t), 'registrationRules.errors.full')
  assert.equal(accessError('User with email x not found', t), 'User with email x not found')
})

test('the displayed role matrix agrees with the client scoring rules and with who may assign roles', () => {
  const active = { sport: 'tennis', status: 'in_progress' }
  for (const role of ROLES) {
    const rows = Object.fromEntries(ROLE_MATRIX.map(r => [r.key, r[role]]))
    const access = scoringAccess(active, role)
    assert.equal(rows.live, access.live, role)
    assert.equal(rows.results, access.final, role)
    assert.equal(rows.settings, access.manager, role)
    assert.equal(rows.entries, access.manager, role)
    assert.equal(rows.owners, role === 'owner', role)
  }
  assert.deepEqual(assignableRoles('owner'), ['owner', 'editor', 'counter'])
  assert.deepEqual(assignableRoles('editor'), ['editor', 'counter'])
  assert.deepEqual(assignableRoles('counter'), [])
  assert.deepEqual(assignableRoles(null), [])
  assert.equal(canEditMembership('owner', 'owner'), true)
  assert.equal(canEditMembership('editor', 'owner'), false)
  assert.equal(canEditMembership('editor', 'counter'), true)
  assert.equal(canEditMembership('counter', 'counter'), false)
})

test('the robots meta is added only for non-public pages and removed again', () => {
  const head = { children: [], querySelector(selector) { return this.children.find(m => selector.includes('robots') && m.name === 'robots') || null }, appendChild(node) { this.children.push(node) } }
  const doc = { head, createElement() { const el = { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; if (k === 'name') this.name = v }, remove: () => { head.children = head.children.filter(m => m !== el) } }; return el } }
  setRobotsMeta(false, doc)
  assert.equal(head.children.length, 1)
  assert.equal(head.children[0].attrs.content, 'noindex')
  setRobotsMeta(false, doc)
  assert.equal(head.children.length, 1)
  setRobotsMeta(true, doc)
  assert.equal(head.children.length, 0)
  setRobotsMeta(true, { head: null })
})

test('access grants live per slug in this tab and expire on their own', () => {
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: k => store.delete(k) }
  assert.equal(readAccessToken('cup', storage), null)
  storeAccessToken('cup', { tournament_id: 't1', token: 'abc', expires_at: new Date(Date.now() + 60_000).toISOString(), extra: 'dropped' }, storage)
  assert.deepEqual(Object.keys(readAccessToken('cup', storage)).sort(), ['expires_at', 'token', 'tournament_id'])
  assert.equal(readAccessToken('other', storage), null)
  storeAccessToken('old', { tournament_id: 't2', token: 'x', expires_at: new Date(Date.now() - 1000).toISOString() }, storage)
  assert.equal(readAccessToken('old', storage), null)
  assert.equal(store.has('champ_access_old'), false)
  clearAccessToken('cup', storage)
  assert.equal(readAccessToken('cup', storage), null)
  storage.setItem('champ_access_bad', '{not json')
  assert.equal(readAccessToken('bad', storage), null)
  assert.equal(readAccessToken('cup', undefined), null)
})

test('RU, EN and LT access messages share keys, and the counter label now reads "results only"', () => {
  const keys = obj => Object.entries(obj).flatMap(([k, v]) => typeof v === 'object' ? keys(v).map(s => `${k}.${s}`) : [k]).sort()
  const ru = keys(accessMessages.ru)
  assert.ok(ru.length > 25)
  assert.deepEqual(keys(accessMessages.en), ru)
  assert.deepEqual(keys(accessMessages.lt), ru)
  for (const locale of ['ru', 'en', 'lt']) {
    assert.ok(messagesSource.includes(`counter: '${accessMessages[locale].roleCounter}',`), locale)
    assert.equal(mobileMessages[locale].finalScoreRole, undefined)
    for (const mode of VISIBILITY_MODES) {
      assert.ok(accessMessages[locale].visibility[mode])
      assert.ok(accessMessages[locale].visibility[`${mode}Hint`])
    }
  }
})
