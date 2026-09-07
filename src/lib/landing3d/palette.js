import * as THREE from 'three'

// Landing 3D palette is read from the CSS design tokens so the scene follows
// the light/dark theme automatically. Fallbacks mirror styles.css :root.
const TOKENS = {
  lime: ['--lime', '#C6F24E'],
  primary: ['--primary', '#0F7B4D'],
  primaryMuted: ['--primary-muted', '#E7F4EC'],
  ink: ['--text', '#14201B'],
  muted: ['--muted', '#5E6B64'],
  surface: ['--surface', '#FFFFFF'],
  bg: ['--bg', '#F7F7F4'],
  border: ['--border-strong', '#D8DCD6'],
  accent: ['--accent', '#FF5A48'],
}

// rgba()/rgb() with alpha is composited over the page background so the
// material colour matches what CSS paints (three ignores alpha and warns).
function parseColor(raw, bg) {
  const m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/i.exec(raw)
  if (m) {
    const a = m[4] === undefined ? 1 : Number(m[4])
    const c = new THREE.Color(Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255)
    return bg ? bg.clone().lerp(c, a) : c
  }
  return new THREE.Color().setStyle(raw)
}

export function readPalette() {
  const styles = getComputedStyle(document.documentElement)
  const out = {}
  const read = (token, fallback, bg) => {
    const raw = styles.getPropertyValue(token).trim()
    try {
      return parseColor(raw || fallback, bg)
    } catch {
      return new THREE.Color().setStyle(fallback)
    }
  }
  out.bg = read(...TOKENS.bg)
  for (const [key, [token, fallback]] of Object.entries(TOKENS)) {
    if (key === 'bg') continue
    out[key] = read(token, fallback, out.bg)
  }
  out.isDark = document.documentElement.dataset.theme === 'dark'
  return out
}
