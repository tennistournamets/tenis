import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import vm from 'node:vm'
import { embedPreviewUrl, embedSnippet } from '../src/lib/embedCode.js'

test('the embed snippet keeps a plain, escaped link in the host page', () => {
  const code = embedSnippet({ origin: 'https://bracketa.lt', slug: 'vilnius-cup', name: 'Cup', linkText: 'Турнир «<Cup>» на Bracketa', locale: 'ru' })
  assert.equal(code, [
    '<div data-bracketa-tournament="vilnius-cup" data-lang="ru"><a href="https://bracketa.lt/tournaments/vilnius-cup">Турнир «&lt;Cup&gt;» на Bracketa</a></div>',
    '<script src="https://bracketa.lt/embed.js" async></script>',
  ].join('\n'))
  // Lithuanian is the widget's default language, so it needs no attribute.
  assert.ok(!embedSnippet({ origin: 'https://b.lt', slug: 's', name: 'n', locale: 'lt' }).includes('data-lang'))
  assert.equal(embedPreviewUrl('https://b.lt', 'a b'), 'https://b.lt/embed/a%20b')
})

function hostPage() {
  const listeners = {}
  const make = tag => {
    const node = { tagName: tag, attrs: {}, style: {}, children: [], textContent: '' }
    node.getAttribute = name => node.attrs[name] ?? null
    node.setAttribute = (name, value) => { node.attrs[name] = String(value) }
    node.insertBefore = child => { node.children.unshift(child) }
    node.querySelector = sel => (sel === 'a' ? node.link : null)
    return node
  }
  const box = make('div')
  box.attrs['data-bracketa-tournament'] = 'vilnius-cup'
  box.attrs['data-lang'] = 'lt'
  box.attrs['data-theme'] = 'dark'
  box.link = make('a')
  box.textContent = 'Cup on Bracketa'
  const window = {
    addEventListener: (name, fn) => { listeners[name] = fn },
  }
  const document = {
    currentScript: { src: 'https://bracketa.lt/embed.js' },
    createElement: tag => make(tag),
    querySelectorAll: () => [box],
  }
  return { window, document, box, listeners, URL }
}

test('embed.js inserts the widget iframe and only trusts height messages from Bracketa', () => {
  const page = hostPage()
  const source = readFileSync(new URL('../public/embed.js', import.meta.url), 'utf8')
  vm.runInNewContext(source, page)
  const iframe = page.box.children[0]
  assert.equal(iframe.tagName, 'iframe')
  assert.equal(iframe.src, 'https://bracketa.lt/embed/vilnius-cup?lang=lt&theme=dark')
  assert.equal(iframe.title, 'Cup on Bracketa')
  assert.match(iframe.style.cssText, /height:640px/)
  iframe.contentWindow = {}
  page.listeners.message({ origin: 'https://evil.example', source: iframe.contentWindow, data: { type: 'bracketa:embed-height', height: 900 } })
  assert.match(iframe.style.cssText, /height:640px/)
  page.listeners.message({ origin: 'https://bracketa.lt', source: iframe.contentWindow, data: { type: 'bracketa:embed-height', height: 900 } })
  assert.equal(iframe.style.height, '900px')
  page.listeners.message({ origin: 'https://bracketa.lt', source: iframe.contentWindow, data: { type: 'bracketa:embed-height', height: 10 } })
  assert.equal(iframe.style.height, '160px')
  // Running the script twice (two snippets on one page) does not mount the same box again.
  vm.runInNewContext(source, page)
  assert.equal(page.box.children.length, 1)
})
