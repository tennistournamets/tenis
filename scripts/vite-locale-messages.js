// Vite plugin: one JSON chunk per language, so a visitor downloads only their locale.
// src/i18n/messages.js (all locales, plain data) stays the source of truth; it is
// evaluated at build time and `virtual:bracketa-locale/<code>` exports one locale.
import { build } from 'esbuild'
import { resolve } from 'node:path'

const PREFIX = 'virtual:bracketa-locale/'
const RESOLVED = `\0${PREFIX}`

export async function loadAllMessages(root) {
  const result = await build({
    entryPoints: [resolve(root, 'src/i18n/messages.js')],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'neutral',
    metafile: true,
    logLevel: 'silent',
  })
  const code = result.outputFiles[0].text
  const { messages } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const files = Object.keys(result.metafile.inputs).map(file => resolve(process.cwd(), file))
  return { messages, files }
}

export function localeMessages() {
  let root = process.cwd()
  let cache = null
  let watched = new Set()
  return {
    name: 'bracketa-locale-messages',
    configResolved(config) { root = config.root },
    resolveId(id) {
      return id.startsWith(PREFIX) ? `${RESOLVED}${id.slice(PREFIX.length)}` : null
    },
    async load(id) {
      if (!id.startsWith(RESOLVED)) return null
      const locale = id.slice(RESOLVED.length)
      cache ??= loadAllMessages(root)
      const { messages, files } = await cache
      watched = new Set(files)
      for (const file of files) this.addWatchFile(file)
      if (!messages[locale]) throw new Error(`Unknown locale "${locale}" in ${id}`)
      return `export default ${JSON.stringify(messages[locale])}`
    },
    // Dev server: an edited translation file rebuilds the locale modules and reloads the page.
    handleHotUpdate({ file, server }) {
      if (!watched.has(file)) return
      cache = null
      for (const module of server.moduleGraph.idToModuleMap.values()) {
        if (module.id?.startsWith(RESOLVED)) server.moduleGraph.invalidateModule(module)
      }
      server.ws.send({ type: 'full-reload' })
      return []
    },
  }
}
