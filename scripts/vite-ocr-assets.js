// Vite plugin: text recognition on pictures (tesseract.js) runs from our own domain. The worker,
// the WebAssembly engine and the lt/ru/en language data are served under /ocr/<version>/ —
// by a dev middleware and as build assets — instead of tesseract.js's default CDN.
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const packageDir = name => dirname(require.resolve(`${name}/package.json`))

export const OCR_LANGUAGES = ['lit', 'rus', 'eng']
export const OCR_VERSION = require('tesseract.js/package.json').version
export const OCR_BASE = `/ocr/${OCR_VERSION}`

// The LSTM engine variants tesseract.js picks from (relaxed SIMD, SIMD, plain).
const CORE_FILES = ['tesseract-core-relaxedsimd-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js', 'tesseract-core-lstm.wasm.js']

/** Published path (without the leading slash) -> file on disk. */
export function ocrAssetFiles() {
  const files = { [`${OCR_BASE}/worker.min.js`.slice(1)]: join(packageDir('tesseract.js'), 'dist/worker.min.js') }
  for (const file of CORE_FILES) files[`${OCR_BASE}/core/${file}`.slice(1)] = join(packageDir('tesseract.js-core'), file)
  for (const lang of OCR_LANGUAGES) {
    files[`${OCR_BASE}/lang/${lang}.traineddata.gz`.slice(1)] = join(packageDir(`@tesseract.js-data/${lang}`), `4.0.0_best_int/${lang}.traineddata.gz`)
  }
  return files
}

export function ocrAssets() {
  const files = ocrAssetFiles()
  return {
    name: 'bracketa-ocr-assets',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = decodeURIComponent((req.url ?? '').split('?')[0]).slice(1)
        if (!Object.hasOwn(files, path)) return next()
        res.setHeader('Content-Type', path.endsWith('.gz') ? 'application/gzip' : 'text/javascript')
        res.end(readFileSync(files[path]))
      })
    },
    generateBundle() {
      for (const [fileName, source] of Object.entries(files)) {
        this.emitFile({ type: 'asset', fileName, source: readFileSync(source) })
      }
    },
  }
}
