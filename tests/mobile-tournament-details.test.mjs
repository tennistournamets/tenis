import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'

import { asActor, createDatabase, fixture } from './helpers/database.mjs'

let ctx
before(async () => { ctx = await createDatabase() })
after(async () => { await ctx.db.close() })

test('organizer contacts stay private until the explicit publication flag is saved', async () => {
  const tournament = await fixture(ctx, { status: 'in_progress', isPublic: true })
  await ctx.db.query("update tournaments set contact_phone='+37060000000',contact_email='organizer@example.test' where id=$1", [tournament.id])

  const hidden = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) state', [tournament.id])).rows[0].state.tournament
  assert.equal(hidden.publish_contact, false)
  assert.equal(hidden.contact_phone, null)
  assert.equal(hidden.contact_email, null)
  await assert.rejects(asActor(ctx, 'anon', 'select contact_phone from tournaments where id=$1', [tournament.id]), /permission denied/)

  const revision = (await ctx.db.query('select settings_revision from tournaments where id=$1', [tournament.id])).rows[0].settings_revision
  await asActor(ctx, 'owner', 'select update_tournament_settings($1,$2,$3)', [
    tournament.id,
    JSON.stringify({ publish_contact: true }),
    revision,
  ])

  const published = (await asActor(ctx, 'anon', 'select get_tournament_sync_state($1) state', [tournament.id])).rows[0].state.tournament
  assert.equal(published.publish_contact, true)
  assert.equal(published.contact_phone, '+37060000000')
  assert.equal(published.contact_email, 'organizer@example.test')
})

test('active tournament public text remains editable while structure stays locked', async () => {
  const tournament = await fixture(ctx, { status: 'in_progress' })
  let revision = (await ctx.db.query('select settings_revision from tournaments where id=$1', [tournament.id])).rows[0].settings_revision
  const changed = (await asActor(ctx, 'owner', 'select update_tournament_settings($1,$2,$3) value', [
    tournament.id,
    JSON.stringify({ name: 'Updated during play', description: 'Court changed' }),
    revision,
  ])).rows[0].value
  assert.equal(changed.name, 'Updated during play')
  assert.equal(changed.description, 'Court changed')

  revision = changed.settings_revision
  await assert.rejects(asActor(ctx, 'owner', 'select update_tournament_settings($1,$2,$3)', [
    tournament.id,
    JSON.stringify({ category: 'doubles' }),
    revision,
  ]), /drafts.rulesLocked/)
})
