import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { createEmptyDatabase, installDatabase } from './helpers/database.mjs'
const root = new URL('../', import.meta.url)
const read = path => readFile(new URL(path, root), 'utf8')
const manifest = JSON.parse(await read('supabase/database-release.json'))
const catalog = await read('tests/helpers/catalog.sql')

test('release manifest locks the baseline, upgrade source and ordered history; legacy SQL is outside active migrations', async () => {
  for (const item of [manifest.baseline,manifest.upgradeSource,...manifest.upgrades,...manifest.forwardMigrations]) {
    assert.equal(createHash('sha256').update(await read(item.path)).digest('hex'), item.sha256, item.path)
  }
  const versions = manifest.upgrades.map(m => m.path)
  assert.deepEqual(versions, [...versions].sort())
  assert.equal(new Set(versions).size, versions.length)
  const active = (await readdir(new URL('supabase/migrations', root))).filter(n => n.endsWith('.sql')).sort()
  const released = [manifest.baseline,...manifest.forwardMigrations].map(m => m.path.split('/').at(-1))
  assert.deepEqual(released, [...released].sort())
  assert.deepEqual(active, released)
})

test('fresh baseline and full historical upgrade converge to the canonical catalog', async t => {
  const expected = await createEmptyDatabase(); t.after(() => expected.close())
  await installDatabase(expected, 'schema')
  const reference = (await expected.query(catalog)).rows[0].catalog
  for (const mode of ['fresh','upgrade']) {
    const db = await createEmptyDatabase()
    try {
      await installDatabase(db, mode)
      const actual = (await db.query(catalog)).rows[0].catalog
      for (const key of Object.keys(reference)) assert.deepEqual(actual[key], reference[key], `${mode}: ${key}`)
    } finally { await db.close() }
  }
})

test('baseline refuses an existing current or legacy database before changing its contents', async () => {
  for (const table of ['tournaments','organizations']) {
    const db = await createEmptyDatabase()
    try {
      await db.exec(`create table public.${table}(id integer primary key); insert into public.${table} values (42)`)
      await assert.rejects(installDatabase(db,'fresh'), /Baseline requires a fresh database/)
      assert.deepEqual((await db.query(`select * from public.${table}`)).rows, [{ id: 42 }])
      assert.equal((await db.query("select count(*)::int n from information_schema.tables where table_schema='public'")).rows[0].n,1)
    } finally { await db.close() }
  }
})
