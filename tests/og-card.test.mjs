import assert from 'node:assert/strict'
import { test } from 'node:test'
import { titleSize, tournamentCard } from '../api/_og-card.js'

const texts = node => {
  if (node == null || typeof node !== 'object') return typeof node === 'string' ? [node] : []
  const children = node.props?.children
  return (Array.isArray(children) ? children : [children]).flatMap(texts)
}

test('the preview card shows name, status, sport, format, date and venue in the requested language', () => {
  const card = tournamentCard({
    name: 'Vilnius Padel Cup', sport: 'padel', format: 'groups_playoff', status: 'registration_open',
    starts_at: '2026-10-12T07:00:00Z', ends_at: '2026-10-14T16:00:00Z', venue_address: 'Ozo g. 14', schedule_config: { timezone: 'Europe/Vilnius' },
  }, 'lt')
  const all = texts(card)
  for (const text of ['Bracketa', 'Vilnius Padel Cup', 'Registracija atvira', 'Padelis', 'Grupės + atkrentamosios', 'Ozo g. 14']) {
    assert.ok(all.includes(text), text)
  }
  assert.ok(all.some(text => /spalio/.test(text)), 'Lithuanian date')
  assert.equal(card.props.style.width, '100%')
})

test('live tournaments get the LIVE chip; unknown status and no date leave them out', () => {
  assert.ok(texts(tournamentCard({ name: 'X', sport: 'tennis', format: 'round_robin', status: 'in_progress' }, 'ru')).includes('LIVE'))
  const draft = texts(tournamentCard({ name: 'X', sport: 'tennis', format: 'round_robin', status: 'draft' }, 'ru'))
  assert.deepEqual(draft.filter(Boolean), ['Bracketa', 'X', 'Теннис', 'Круговая'])
})

test('long names get a smaller font', () => {
  assert.equal(titleSize('Short name'), 92)
  assert.ok(titleSize('A'.repeat(50)) < titleSize('A'.repeat(30)))
  assert.equal(titleSize('A'.repeat(200)), 52)
})
