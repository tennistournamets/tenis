import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SHARE_CHANNELS, shareHref, taggedUrl } from '../src/lib/shareChannels.js'

const url = 'https://bracketa.lt/tournaments/vilnius-cup'
const text = 'Atvira registracija į turnyrą „Vilnius Cup“. Registruokitės:'

test('each channel opens with the message and a link tagged with its own utm_source', () => {
  assert.deepEqual(SHARE_CHANNELS, ['whatsapp', 'telegram', 'viber', 'email'])
  assert.equal(taggedUrl(url, 'whatsapp'), `${url}?utm_source=whatsapp&utm_medium=share`)
  const wa = new URL(shareHref('whatsapp', { url, text }))
  assert.equal(wa.origin, 'https://wa.me')
  assert.equal(wa.searchParams.get('text'), `${text} ${url}?utm_source=whatsapp&utm_medium=share`)
  const tg = new URL(shareHref('telegram', { url, text }))
  assert.equal(tg.searchParams.get('url'), `${url}?utm_source=telegram&utm_medium=share`)
  assert.equal(tg.searchParams.get('text'), text)
  assert.ok(shareHref('viber', { url, text }).startsWith('viber://forward?text='))
  const mail = shareHref('email', { url, text, subject: 'Vilnius Cup' })
  assert.ok(mail.startsWith('mailto:?subject=Vilnius%20Cup&body='))
  assert.throws(() => shareHref('fax', { url, text }), /Unknown share channel/)
})
