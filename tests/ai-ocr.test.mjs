import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { OCR_BASE, OCR_LANGUAGES, ocrAssetFiles } from '../scripts/vite-ocr-assets.js'
import { FILE_ACCEPT, prepareForOcr, skewAngle } from '../src/lib/aiFileText.js'

test('pictures are accepted next to documents', () => {
  for (const ext of ['.pdf', '.xlsx', '.png', '.jpg', '.jpeg', '.webp', '.heic']) assert.ok(FILE_ACCEPT.split(',').includes(ext), ext)
})

test('the OCR worker, engines and lt/ru/en data are served from our domain and exist on disk', () => {
  const files = ocrAssetFiles()
  assert.match(OCR_BASE, /^\/ocr\/\d+\.\d+\.\d+$/)
  assert.ok(Object.keys(files).every(path => path.startsWith(OCR_BASE.slice(1) + '/')))
  for (const lang of OCR_LANGUAGES) assert.ok(Object.hasOwn(files, `${OCR_BASE.slice(1)}/lang/${lang}.traineddata.gz`), lang)
  assert.ok(Object.keys(files).some(path => path.endsWith('/worker.min.js')))
  assert.equal(Object.keys(files).filter(path => path.includes('/core/')).length, 3)
  for (const source of Object.values(files)) assert.ok(existsSync(source), source)
  // Long cache: the version is part of the path.
  const vercel = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  assert.ok(vercel.headers.some(h => h.source === '/ocr/(.*)' && h.headers.some(x => /immutable/.test(x.value))))
})

test('pictures turn grey, and dark-theme screenshots are inverted to dark text on light', () => {
  const light = new Uint8ClampedArray([250, 250, 250, 255, 20, 40, 60, 255])
  assert.equal(prepareForOcr(light), false)
  assert.equal(light[0], 250)
  assert.equal(light[4], light[5])
  const dark = new Uint8ClampedArray([11, 20, 26, 255, 11, 20, 26, 255, 233, 237, 239, 255])
  assert.equal(prepareForOcr(dark), true)
  assert.ok(dark[0] > 200, 'background becomes light')
  assert.ok(dark[8] < 30, 'text becomes dark')
  assert.equal(dark[3], 255, 'alpha untouched')
})

test('the tilt of text lines is found, so a photo of a sheet can be straightened', () => {
  // Synthetic page: light background, dark "text" lines tilted by a known angle.
  const page = (degrees, width = 400, height = 300) => {
    const grey = new Uint8ClampedArray(width * height).fill(230)
    const slope = Math.tan((degrees * Math.PI) / 180)
    for (let line = 0; line < 8; line++) {
      for (let x = 40; x < 360; x++) {
        if (x % 9 > 6) continue // gaps between letters
        const y = Math.round(40 + line * 28 - (x - 200) * slope)
        for (let t = 0; t < 3; t++) if (y + t >= 0 && y + t < height) grey[(y + t) * width + x] = 30
      }
    }
    return [grey, width, height]
  }
  // page(d): lines rise to the right by d degrees; the photo in the owner's test rose by ~11–12°.
  assert.equal(skewAngle(...page(0)), 0)
  assert.ok(Math.abs(skewAngle(...page(11)) + 11) <= 0.5, 'lines rising to the right')
  assert.ok(Math.abs(skewAngle(...page(-7)) - 7) <= 0.5, 'lines falling to the right')
  assert.equal(skewAngle(new Uint8ClampedArray(400 * 300).fill(230), 400, 300), 0, 'blank page')
})
