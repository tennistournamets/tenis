// Renders scripts/og-image.html to public/og-image.png with headless Chrome (macOS path by default).
// CHROME=/path/to/chrome npm run og:image
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const chrome = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const source = fileURLToPath(new URL('./og-image.html', import.meta.url))
const target = fileURLToPath(new URL('../public/og-image.png', import.meta.url))

execFileSync(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  '--window-size=1200,630',
  '--virtual-time-budget=5000',
  `--screenshot=${target}`,
  `file://${source}`,
], { stdio: 'inherit' })
console.log(`Wrote ${target}`)
