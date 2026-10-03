import assert from 'node:assert/strict'
import { test } from 'node:test'
import { matchStreamUrl, normalizeStreamUrl, youtubeEmbedUrl } from '../src/lib/matchStream.js'

test('a pasted YouTube link becomes the https link the server accepts', () => {
  assert.equal(normalizeStreamUrl('  https://www.youtube.com/live/abc123?si=x  '), 'https://www.youtube.com/live/abc123?si=x')
  assert.equal(normalizeStreamUrl('youtu.be/abc123'), 'https://youtu.be/abc123')
  assert.equal(normalizeStreamUrl('http://m.youtube.com/watch?v=abc'), 'https://m.youtube.com/watch?v=abc')
  assert.equal(normalizeStreamUrl('HTTPS://WWW.YouTube.com/@club/live'), 'https://www.youtube.com/@club/live')
  assert.equal(normalizeStreamUrl(''), '')
  assert.equal(normalizeStreamUrl('   '), '')
})

test('anything that is not a YouTube page is refused', () => {
  for (const value of ['https://vimeo.com/1', 'https://youtube.com.evil.test/x', 'https://www.youtube.com/', 'javascript:alert(1)', 'ftp://youtu.be/x', 'https://youtu.be/a b', `https://youtu.be/${'x'.repeat(500)}`]) {
    assert.equal(normalizeStreamUrl(value), null, value)
  }
})

test('only a valid stored link is rendered', () => {
  assert.equal(matchStreamUrl({ stream_url: 'https://youtu.be/abc' }), 'https://youtu.be/abc')
  assert.equal(matchStreamUrl({ stream_url: 'javascript:alert(1)' }), '')
  assert.equal(matchStreamUrl({ stream_url: null }), '')
  assert.equal(matchStreamUrl(null), '')
})

test('the phone player embeds a video named by the link, and nothing else', () => {
  const embed = id => `https://www.youtube-nocookie.com/embed/${id}?autoplay=1&playsinline=1&rel=0`
  assert.equal(youtubeEmbedUrl('https://www.youtube.com/watch?v=abcDEF12345&t=30'), embed('abcDEF12345'))
  assert.equal(youtubeEmbedUrl('https://youtu.be/abcDEF12345?si=x'), embed('abcDEF12345'))
  assert.equal(youtubeEmbedUrl('https://youtube.com/live/abcDEF12345?feature=share'), embed('abcDEF12345'))
  assert.equal(youtubeEmbedUrl('https://m.youtube.com/shorts/abcDEF12345'), embed('abcDEF12345'))
  assert.equal(youtubeEmbedUrl('https://www.youtube.com/channel/UC1234567890123456789012/live'),
    'https://www.youtube-nocookie.com/embed/live_stream?channel=UC1234567890123456789012&autoplay=1&playsinline=1')
  for (const url of ['https://www.youtube.com/@club/live', 'https://www.youtube.com/watch?v=a"b', 'https://vimeo.com/123', null]) {
    assert.equal(youtubeEmbedUrl(url), '', String(url))
  }
})
