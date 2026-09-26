import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { READABLE_SCALE, fitTransform, wheelIntent } from '../src/lib/canvasView.js'

const source = readFileSync(new URL('../src/components/InfiniteCanvas.vue', import.meta.url), 'utf8')

test('plain wheel scrolls the page; Ctrl/⌘ or pinch zooms; fullscreen pans', () => {
  assert.equal(wheelIntent({ deltaY: 100 }), 'scroll')
  assert.equal(wheelIntent({ deltaY: 100, ctrlKey: true }), 'zoom')
  assert.equal(wheelIntent({ deltaY: 100, metaKey: true }), 'zoom')
  assert.equal(wheelIntent({ deltaY: 100 }, true), 'pan')
  assert.ok(!/@wheel\.prevent/.test(source), 'the wheel is not prevented unconditionally')
})

test('automatic fit on a 390 px phone keeps cards readable instead of 25 %', () => {
  const phone = { width: 358, height: 400 }, bracket = { width: 1400, height: 900 }
  const readable = fitTransform(phone, bracket, { mode: 'readable' })
  assert.equal(readable.scale, READABLE_SCALE)
  assert.equal(readable.translateX, 12)
  const all = fitTransform(phone, bracket, { mode: 'all' })
  assert.ok(all.scale < 0.3)
  // Wide screens are unchanged: fit everything, never above 100 %, centered.
  const desktop = fitTransform({ width: 1200, height: 600 }, { width: 800, height: 400 })
  assert.deepEqual(desktop, { scale: 1, translateX: 200, translateY: 100 })
  assert.equal(fitTransform({ width: 0, height: 0 }, bracket), null)
})

test('reset differs from fit, zoom buttons exist, fullscreen refusal is handled', () => {
  assert.match(source, /t\('bracket\.resetView'\)" @click="resetView"/)
  assert.match(source, /t\('bracket\.fitView'\)" @click="fitAll"/)
  assert.match(source, /@click="zoomIn"/)
  assert.match(source, /@click="zoomOut"/)
  assert.match(source, /Promise\.resolve\(pending\)\.catch\(/)
})
