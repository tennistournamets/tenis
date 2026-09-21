import assert from 'node:assert/strict'
import { test } from 'node:test'
import { formatVenuePoint, hasVenue, parseVenuePoint, venueRouteLinks, venueRouteUrl } from '../src/lib/venue.js'

test('a pasted map link or a plain pair of numbers becomes the same point', () => {
  const vilnius = { lat: 54.6872, lng: 25.2797 }
  const sources = [
    '54.6872, 25.2797',
    '54.6872;25.2797',
    'geo:54.6872,25.2797',
    'https://maps.google.com/?q=54.6872,25.2797',
    'https://www.google.com/maps/place/Vilnius/@54.6872,25.2797,15z',
    'https://maps.apple.com/?daddr=54.6872,25.2797',
    'https://www.google.com/maps/dir/?api=1&destination=54.6872%2C25.2797',
  ]
  for (const source of sources) assert.deepEqual(parseVenuePoint(source), vilnius, source)
})

test('Google place links prefer the exact !3d/!4d pair over the view centre', () => {
  const link = 'https://www.google.com/maps/place/Court/@54.70001,25.30001,17z/data=!3m1!4b1!4m6!3d54.6872!4d25.2797'
  assert.deepEqual(parseVenuePoint(link), { lat: 54.6872, lng: 25.2797 })
})

test('Yandex links are read longitude first, as Yandex writes them', () => {
  assert.deepEqual(parseVenuePoint('https://yandex.ru/maps/?ll=25.2797%2C54.6872&z=17'), { lat: 54.6872, lng: 25.2797 })
})

test('nonsense, empty input and out-of-range numbers produce no point', () => {
  for (const value of ['', '   ', 'Центральный корт', '200, 25', '54.6872', '91,0', '0,181', null, undefined]) {
    assert.equal(parseVenuePoint(value), null, String(value))
  }
})

test('a tournament has a venue when it has an address, a point, or both', () => {
  assert.equal(hasVenue({}), false)
  assert.equal(hasVenue({ venue_address: 'Vilnius' }), true)
  assert.equal(hasVenue({ venue_lat: 54.6872, venue_lng: 25.2797 }), true)
  assert.equal(hasVenue({ venue_lat: 54.6872 }), false)
})

test('route links aim at the point when there is one and at the address otherwise', () => {
  const withPoint = venueRouteLinks({ venue_address: 'Ignored', venue_lat: 54.6872, venue_lng: 25.2797 })
  assert.deepEqual(withPoint.map(l => l.id), ['google', 'yandex', 'waze'])
  assert.match(withPoint[0].url, /destination=54\.6872%2C25\.2797$/)

  const addressOnly = venueRouteLinks({ venue_address: 'Vilnius, Konstitucijos pr. 20' })
  // Without a point there is nothing for Waze to navigate to.
  assert.deepEqual(addressOnly.map(l => l.id), ['google', 'yandex'])
  assert.match(addressOnly[0].url, /destination=Vilnius%2C%20Konstitucijos%20pr\.%2020$/)

  assert.deepEqual(venueRouteLinks({}), [])
  assert.equal(venueRouteUrl({}), '')
})

test('Apple Maps is offered only on Apple platforms', () => {
  const venue = { venue_lat: 54.6872, venue_lng: 25.2797 }
  assert.ok(venueRouteLinks(venue, { platform: 'iPhone' }).some(l => l.id === 'apple'))
  assert.ok(venueRouteLinks(venue, { platform: 'MacIntel' }).some(l => l.id === 'apple'))
  assert.ok(!venueRouteLinks(venue, { platform: 'Win32' }).some(l => l.id === 'apple'))
  assert.ok(!venueRouteLinks(venue).some(l => l.id === 'apple'))
})

test('a stored point is printed back in the form the parser accepts', () => {
  const printed = formatVenuePoint({ lat: 54.68720049, lng: 25.2797 })
  assert.equal(printed, '54.6872, 25.2797')
  assert.deepEqual(parseVenuePoint(printed), { lat: 54.6872, lng: 25.2797 })
  assert.equal(formatVenuePoint({ lat: null, lng: null }), '')
})
