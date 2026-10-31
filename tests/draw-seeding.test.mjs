import assert from 'node:assert/strict'
import { test } from 'node:test'
import { drawSize, drawSummary, tennisSeedCount } from '../src/lib/drawSeeding.js'
import { readDrawMode, writeDrawMode } from '../src/lib/drawModePreference.js'
import { drawSeedingMessages } from '../src/i18n/drawSeeding.js'
import { readFileSync } from 'node:fs'

test('seeds by draw size follow the ITF/LTS table', () => {
  assert.deepEqual([2, 4, 8, 16, 32, 64].map(tennisSeedCount), [2, 2, 2, 4, 8, 16])
  assert.deepEqual([2, 3, 5, 11, 16, 17].map(drawSize), [2, 4, 8, 16, 16, 32])
})

test('summary: 11 entries in 16 lines', () => {
  assert.deepEqual(drawSummary('seeded', 11), { size: 16, byes: 5, seeds: 4, byesToSeeds: 4, byesByLot: 1, unseeded: 7 })
  assert.deepEqual(drawSummary('manual', 11), { size: 16, byes: 5, seeds: 0, byesToSeeds: 0, byesByLot: 5, unseeded: 11 })
  assert.deepEqual(drawSummary('seeded', 6), { size: 8, byes: 2, seeds: 2, byesToSeeds: 2, byesByLot: 0, unseeded: 4 })
  assert.deepEqual(drawSummary('seeded', 2), { size: 2, byes: 0, seeds: 2, byesToSeeds: 0, byesByLot: 0, unseeded: 0 })
  assert.equal(drawSummary('seeded', 24).seeds, 8)
})

test('the seeded mode is remembered per tournament like the others', () => {
  const store = new Map()
  const storage = { getItem: k => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
  writeDrawMode('t1', 'seeded', storage)
  assert.equal(readDrawMode('t1', storage), 'seeded')
  writeDrawMode('t1', 'bogus', storage)
  assert.equal(readDrawMode('t1', storage), 'seeded')
  assert.equal(readDrawMode('t2', storage), 'auto-random')
})

test('draw texts exist in RU, EN and LT', () => {
  const keys = o => Object.keys(o).sort()
  assert.deepEqual(keys(drawSeedingMessages.en), keys(drawSeedingMessages.ru))
  assert.deepEqual(keys(drawSeedingMessages.lt), keys(drawSeedingMessages.ru))
  const source = readFileSync(new URL('../src/i18n/messages.js', import.meta.url), 'utf8')
  for (const key of ['drawSeeded', 'drawSeededHint', 'generateSeeded', 'rebuildSeeded']) {
    assert.equal(source.match(new RegExp(`^      ${key}: '`, 'gm'))?.length, 3, `admin.${key} in each locale`)
  }
})
