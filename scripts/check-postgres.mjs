import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { installDatabase } from '../tests/helpers/database.mjs'

// Local CI/test PostgreSQL only. Never accept a production connection URL.
assert.ok(['localhost','127.0.0.1','::1'].includes(process.env.PGHOST), 'Set PGHOST to a local test PostgreSQL')
const prefix = `tenis_verify_${process.pid}`
const databases = ['fresh','upgrade','restored'].map(s => `${prefix}_${s}`)
const container = process.env.TENIS_PG_CONTAINER
if (container) assert.match(container, /^[a-f0-9]{12,64}$/, 'Expected a local Docker container ID')
const run = (command, args, input, encoding = 'utf8') => {
  const options = { input, encoding, stdio: ['pipe','pipe','pipe'] }
  return container ? execFileSync('docker', ['exec','-i','-e','PGUSER','-e','PGPASSWORD','-e','PGHOST=127.0.0.1','-e','PGPORT=5432',container,command,...args], options)
    : execFileSync(command,args,options)
}
const sql = (database, text) => run('psql', ['-X','-qAt','-v','ON_ERROR_STOP=1','-d',database], text)
const client = name => ({
  exec: async text => sql(name,text),
  query: async text => ({ rows: JSON.parse(sql(name,`select coalesce(json_agg(q),'[]'::json) from (${text.trim().replace(/;$/,'')}) q;`)) }),
})
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8')
const manifest = JSON.parse(read('supabase/database-release.json'))
const bootstrap = read('tests/helpers/supabase-bootstrap.sql')
const catalog = read('tests/helpers/catalog.sql')
const snapshotColumns = async db => (await db.query("select table_name,column_name from information_schema.columns where table_schema='public' order by table_name,ordinal_position")).rows
async function snapshot(db, columns) {
  const result = {}
  for (const table of [...new Set(columns.map(c => c.table_name))]) {
    // Identifiers come from the local catalog and are still quoted.
    const quote = text => '"' + text.replaceAll('"','""') + '"'
    const fields = columns.filter(c => c.table_name === table).map(c => quote(c.column_name)).join(',')
    result[table] = (await db.query(`select ${fields} from public.${quote(table)} order by id`)).rows
  }
  return result
}
const created = []
try {
  for (const name of databases) { run('createdb', [name]); created.push(name) }
  const fresh = client(databases[0]), upgrade = client(databases[1]), restored = client(databases[2])
  await fresh.exec(bootstrap); await upgrade.exec(bootstrap)
  if (process.env.TENIS_TEST_CLI === '1') {
    const cli = fileURLToPath(new URL('../node_modules/.bin/supabase', import.meta.url))
    const url = new URL(`postgresql://127.0.0.1:${process.env.PGPORT || 5432}/${databases[0]}`)
    url.username = process.env.PGUSER || 'postgres'; url.password = process.env.PGPASSWORD || ''
    url.searchParams.set('sslmode','disable') // This script only accepts a loopback test server.
    for (let attempt = 0; attempt < 2; attempt++) execFileSync(cli, ['migration','up','--db-url',url.href], { encoding: 'utf8', stdio: ['pipe','pipe','pipe'] })
    assert.deepEqual((await fresh.query('select version from supabase_migrations.schema_migrations order by version')).rows,
      [manifest.baseline,...manifest.forwardMigrations].map(m => ({ version: m.path.split('/').at(-1).split('_')[0] })))
    console.log('PASS: Supabase CLI applies the fresh baseline once and skips it on the second run')
  } else await installDatabase(fresh, 'fresh')
  await upgrade.exec(read(manifest.upgradeSource.path))
  await upgrade.exec(read('tests/helpers/release-fixture.sql'))
  const columns = await snapshotColumns(upgrade)
  const before = await snapshot(upgrade,columns)
  for (const migration of [...manifest.upgrades,...manifest.forwardMigrations]) await upgrade.exec(read(migration.path))
  assert.deepEqual(await snapshot(upgrade,columns),before,'upgrade preserves every original column and row')
  assert.deepEqual((await upgrade.query(catalog)).rows,(await fresh.query(catalog)).rows,'fresh/upgrade catalogs')
  console.log('PASS: PostgreSQL fresh/upgrade catalogs match; populated upgrade preserves every original value')
  const allColumns = await snapshotColumns(upgrade), upgraded = await snapshot(upgrade,allColumns)
  // Re-running each patch immediately is covered by the historical test suites.
  // Replaying all old patches over current state would temporarily undo fixes.
  const dump = run('pg_dump',['--format=custom','--no-owner','--dbname',databases[1]],undefined,null)
  run('pg_restore',['--exit-on-error','--no-owner','--dbname',databases[2]],dump)
  assert.deepEqual(await snapshot(restored,allColumns),upgraded,'restored application data')
  assert.deepEqual((await restored.query(catalog)).rows,(await upgrade.query(catalog)).rows,'restored catalog including ACL and publication')
  console.log('PASS: pg_dump/pg_restore preserves data, functions, grants, policies, triggers and publication')
  await restored.exec(read('tests/helpers/release-smoke.sql'))
  console.log('PASS: restored database supports owner scoring and anonymous privacy scenarios')
} catch (error) {
  if (error.stderr) process.stderr.write(error.stderr)
  throw error
} finally {
  for (const name of created.reverse()) run('dropdb',[name])
}
