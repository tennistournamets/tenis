// Minimal browser globals for rendering the landing page with Vue SSR at build time.
// Landing code reads matchMedia/localStorage/document during setup or at import
// (theme, motion preference); the values here describe a default visitor:
// light theme, motion allowed, empty storage. The client re-renders on mount anyway.
const noop = () => {}
const media = query => ({ matches: false, media: query, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop })
const memoryStorage = () => {
  const data = new Map()
  return {
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)) },
    removeItem: key => { data.delete(key) },
    clear: () => data.clear(),
    key: index => [...data.keys()][index] ?? null,
    get length() { return data.size },
  }
}
const events = { addEventListener: noop, removeEventListener: noop, dispatchEvent: () => true }
const element = () => ({ ...events, dataset: {}, style: { setProperty: noop }, setAttribute: noop, getAttribute: () => null, remove: noop, appendChild: noop, querySelector: () => null, querySelectorAll: () => [], classList: { add: noop, remove: noop, toggle: noop, contains: () => false } })

export function installPrerenderGlobals({ url = 'https://bracketa.local/' } = {}) {
  const location = new URL(url)
  const documentElement = element()
  const head = element()
  const document = {
    ...events,
    documentElement,
    head,
    body: element(),
    title: '',
    readyState: 'loading',
    referrer: '',
    createElement: element,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
  }
  // vue-router treats a defined `document` as a browser and reads history.state.
  const history = { state: {}, length: 1, pushState: noop, replaceState: noop, back: noop, forward: noop, go: noop }
  const window = {
    ...events,
    document,
    location,
    history,
    matchMedia: media,
    innerWidth: 1280,
    innerHeight: 800,
    scrollY: 0,
    requestAnimationFrame: () => 0,
    cancelAnimationFrame: noop,
  }
  const define = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true })
  define('window', window)
  define('document', document)
  define('localStorage', memoryStorage())
  define('sessionStorage', memoryStorage())
  define('matchMedia', media)
  define('location', location)
  define('history', history)
}
