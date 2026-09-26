// Renders the app icons in public/ from the Bracketa mark with headless Chrome:
// favicon.svg, favicon.ico (48 px), apple-touch-icon.png (180), icon-192/512.png, icon-maskable-512.png.
// CHROME=/path/to/chrome npm run icons
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const publicDir = fileURLToPath(new URL('../public/', import.meta.url))

const GLYPH = `<path d="M11 8H9.5A1.5 1.5 0 0 0 8 9.5v9A1.5 1.5 0 0 0 9.5 20H11" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>
<path d="M17 8h1.5A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5H17" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/>
<circle cx="14" cy="14" r="2.2" fill="#C6F24E"/>`

// Rounded tile (tab icon, "any" purpose) and full-bleed square (iOS and Android mask their own shape).
export const markSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="#0F7B4D"/>${GLYPH}</svg>`
const bleedSvg = scale => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" fill="#0F7B4D"/><g transform="translate(14 14) scale(${scale}) translate(-14 -14)">${GLYPH}</g></svg>`

function render(svg, size, file, dir) {
  const html = join(dir, `${size}.html`)
  writeFileSync(html, `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`)
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1',
    '--default-background-color=00000000', `--window-size=${size},${size}`,
    `--screenshot=${join(publicDir, file)}`, `file://${html}`,
  ], { stdio: 'ignore' })
}

/** ICO container with one embedded PNG (supported by every current browser). */
function pngToIco(png, size) {
  const header = Buffer.alloc(22)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(1, 4)
  header.writeUInt8(size >= 256 ? 0 : size, 6)
  header.writeUInt8(size >= 256 ? 0 : size, 7)
  header.writeUInt16LE(1, 10)
  header.writeUInt16LE(32, 12)
  header.writeUInt32LE(png.length, 14)
  header.writeUInt32LE(22, 18)
  return Buffer.concat([header, png])
}

const dir = mkdtempSync(join(tmpdir(), 'bracketa-icons-'))
try {
  writeFileSync(join(publicDir, 'favicon.svg'), `${markSvg}\n`)
  render(markSvg, 48, 'favicon-48.png', dir)
  writeFileSync(join(publicDir, 'favicon.ico'), pngToIco(readFileSync(join(publicDir, 'favicon-48.png')), 48))
  rmSync(join(publicDir, 'favicon-48.png'))
  render(bleedSvg(1.15), 180, 'apple-touch-icon.png', dir)
  render(markSvg, 192, 'icon-192.png', dir)
  render(markSvg, 512, 'icon-512.png', dir)
  // Maskable: the glyph stays inside the central 80 % safe zone.
  render(bleedSvg(1), 512, 'icon-maskable-512.png', dir)
  console.log('Icons written to public/')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
