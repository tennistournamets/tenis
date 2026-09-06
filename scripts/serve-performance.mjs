// A fixed gzip/HTTP setup for repeatable production-build measurements.
// Usage: node scripts/serve-performance.mjs <dist-directory> [port]
import http from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { resolve, extname, sep } from 'node:path'
import { gzipSync } from 'node:zlib'

const root = resolve(process.argv[2] || 'dist')
const port = Number(process.argv[3] || 4175)
const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2' }
const cache = new Map()
http.createServer(async (request, response) => {
  try {
    let file = resolve(root, `.${decodeURIComponent(new URL(request.url, 'http://localhost').pathname)}`)
    if (!file.startsWith(root + sep) && file !== root) { response.writeHead(403).end(); return }
    if (!(await stat(file).catch(() => null))?.isFile()) {
      if (extname(file)) { response.writeHead(404).end(); return }
      file = resolve(root, 'index.html')
    }
    let body = cache.get(file)
    if (!body) { body = gzipSync(await readFile(file)); cache.set(file, body) }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream',
      'Content-Encoding': 'gzip', 'Content-Length': body.length, 'Cache-Control': 'no-store' })
    response.end(body)
  } catch { response.writeHead(500).end('Unable to serve performance fixture') }
}).listen(port, '127.0.0.1', () => console.log(`Performance server: http://127.0.0.1:${port}`))
