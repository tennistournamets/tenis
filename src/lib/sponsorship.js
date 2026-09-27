// Tournament sponsorship: any number of sponsors per tournament, and slots on the
// public pages that the organizer fills with them.
//   logo slots   — a quiet "Presented by [logo] Name" line; one sponsor, own caption;
//   banner slots — one or more banners (image, text, or text over an image), one shown per view;
//   partners     — the logo wall at the bottom of the page, grouped by tier.
// Prototype storage: the config lives in localStorage (images in IndexedDB, see
// sponsorAssets.js), keyed by tournament id, so only this browser sees it.
import { computed, inject, provide, ref, unref } from 'vue'
import { track } from './analytics'
import { deleteAsset } from './sponsorAssets'
import { sponsorshipApproved, useSponsorshipFeature } from './sponsorshipRequests'

const STORAGE_KEY = 'bracketa_sponsorship_v2'
const SPONSORSHIP_KEY = Symbol('tournamentSponsorship')

// Display order in the partners block, most prominent first.
export const SPONSOR_TIERS = ['title', 'official', 'partner', 'media', 'supplier']
export const LOGO_SLOTS = ['hero', 'bracket', 'standings', 'live', 'champion', 'embed', 'poster']
export const BANNER_SLOTS = ['top', 'registration', 'bottom']

// Recommended artwork per banner slot; uploads are shrunk to `max`.
export const BANNER_FORMATS = {
  top: { ratio: 4, size: '1600 × 400', mobileSize: '800 × 400', max: { maxWidth: 2400, maxHeight: 1200 } },
  registration: { ratio: 4 / 3, size: '800 × 600', mobileSize: '', max: { maxWidth: 1200, maxHeight: 1200 } },
  bottom: { ratio: 4, size: '1600 × 400', mobileSize: '800 × 400', max: { maxWidth: 2400, maxHeight: 1200 } },
}
export const LOGO_MAX = { maxWidth: 800, maxHeight: 400 }

// Places on the pages, in the order the Sponsors tab shows them. A place is the
// organizer's entry point: open it, put a sponsor (logo) or banners in it.
export const PLACES = [
  { key: 'hero', kind: 'logo', group: 'page' },
  { key: 'top', kind: 'banner', group: 'page' },
  { key: 'registration', kind: 'banner', group: 'page' },
  { key: 'bracket', kind: 'logo', group: 'page' },
  { key: 'standings', kind: 'logo', group: 'page' },
  { key: 'bottom', kind: 'banner', group: 'page' },
  { key: 'partners', kind: 'partners', group: 'page' },
  { key: 'live', kind: 'logo', group: 'moments' },
  { key: 'champion', kind: 'logo', group: 'moments' },
  { key: 'embed', kind: 'logo', group: 'outside' },
  { key: 'poster', kind: 'logo', group: 'outside' },
]
export const PLACE_GROUPS = ['page', 'moments', 'outside']

export const DEFAULT_BANNER_BG = '#10284A'

/** Plain deep copy; configs are JSON data, and structured cloning fails on Vue proxies. */
export function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function uid() {
  return globalThis.crypto?.randomUUID?.() || `s${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
}

/** Only http(s) links leave the page; a bare domain gets https://. */
export function safeUrl(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export function emptySponsor() {
  return { id: uid(), name: '', url: '', tier: 'partner', caption: '', logo: null, logoDark: null, showName: true }
}

export function emptyBanner(sponsorId = null) {
  return {
    id: uid(),
    sponsorId,
    image: null,
    imageMobile: null,
    alt: '',
    eyebrow: '',
    title: '',
    text: '',
    cta: '',
    url: '',
    bg: DEFAULT_BANNER_BG,
    showLogo: true,
    adLabel: true,
  }
}

function emptyConfig() {
  return {
    sponsors: [],
    slots: {
      ...Object.fromEntries(LOGO_SLOTS.map((key) => [key, { enabled: true, sponsorId: null, label: '' }])),
      partners: { enabled: true, title: '', sponsorIds: null },
      ...Object.fromEntries(BANNER_SLOTS.map((key) => [key, { enabled: true, banners: [] }])),
    },
  }
}

/** Fills in whatever an older or partial config lacks. */
function normalize(saved) {
  const base = emptyConfig()
  if (!saved || typeof saved !== 'object') return base
  const sponsors = Array.isArray(saved.sponsors)
    ? saved.sponsors.filter((s) => s?.id).map((s) => ({ ...emptySponsor(), ...s, tier: SPONSOR_TIERS.includes(s.tier) ? s.tier : 'partner' }))
    : []
  const slots = { ...base.slots }
  for (const key of LOGO_SLOTS) slots[key] = { ...base.slots[key], ...(saved.slots?.[key] || {}) }
  slots.partners = { ...base.slots.partners, ...(saved.slots?.partners || {}) }
  for (const key of BANNER_SLOTS) {
    const slot = saved.slots?.[key] || {}
    slots[key] = {
      ...base.slots[key],
      ...slot,
      banners: Array.isArray(slot.banners) ? slot.banners.filter((b) => b?.id).map((b) => ({ ...emptyBanner(), ...b })) : [],
    }
  }
  return { sponsors, slots }
}

function readStore() {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) || '{}') || {}
  } catch {
    return {}
  }
}

const store = ref(readStore())

// The admin tab and an open public tab stay in step.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEY) store.value = readStore()
  })
}

export function sponsorshipConfig(tournamentId) {
  return normalize(tournamentId ? store.value[tournamentId] : null)
}

/** Applies `mutate(config)` to a copy and saves it. Throws 'quota' when the browser is full. */
export function updateSponsorship(tournamentId, mutate) {
  if (!tournamentId) return
  const next = clone(sponsorshipConfig(tournamentId))
  mutate(next)
  const all = { ...store.value, [tournamentId]: next }
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch (error) {
    throw new Error(error?.name === 'QuotaExceededError' ? 'quota' : 'save')
  }
  store.value = all
}

export function saveSponsor(tournamentId, sponsor) {
  updateSponsorship(tournamentId, (config) => {
    const clean = { ...sponsor, name: sponsor.name.trim(), url: safeUrl(sponsor.url), caption: sponsor.caption.trim() }
    const index = config.sponsors.findIndex((s) => s.id === sponsor.id)
    if (index >= 0) config.sponsors[index] = clean
    else config.sponsors.push(clean)
  })
}

export function removeSponsor(tournamentId, sponsorId) {
  const config = sponsorshipConfig(tournamentId)
  const sponsor = config.sponsors.find((s) => s.id === sponsorId)
  const banners = BANNER_SLOTS.flatMap((key) => config.slots[key].banners.filter((b) => b.sponsorId === sponsorId))
  updateSponsorship(tournamentId, (next) => {
    next.sponsors = next.sponsors.filter((s) => s.id !== sponsorId)
    for (const key of LOGO_SLOTS) if (next.slots[key].sponsorId === sponsorId) next.slots[key].sponsorId = null
    if (next.slots.partners.sponsorIds) next.slots.partners.sponsorIds = next.slots.partners.sponsorIds.filter((id) => id !== sponsorId)
    for (const key of BANNER_SLOTS) next.slots[key].banners = next.slots[key].banners.filter((b) => b.sponsorId !== sponsorId)
  })
  for (const asset of [sponsor?.logo, sponsor?.logoDark, ...banners.flatMap((b) => [b.image, b.imageMobile])]) void deleteAsset(asset)
}

export function moveSponsor(tournamentId, sponsorId, delta) {
  updateSponsorship(tournamentId, (config) => {
    const i = config.sponsors.findIndex((s) => s.id === sponsorId)
    const j = i + delta
    if (i < 0 || j < 0 || j >= config.sponsors.length) return
    ;[config.sponsors[i], config.sponsors[j]] = [config.sponsors[j], config.sponsors[i]]
  })
}

export function saveBanner(tournamentId, slotKey, banner) {
  updateSponsorship(tournamentId, (config) => {
    const clean = {
      ...banner,
      url: safeUrl(banner.url),
      ...Object.fromEntries(['alt', 'eyebrow', 'title', 'text', 'cta'].map((k) => [k, String(banner[k] || '').trim()])),
    }
    const list = config.slots[slotKey].banners
    const index = list.findIndex((b) => b.id === banner.id)
    if (index >= 0) list[index] = clean
    else list.push(clean)
  })
}

export function removeBanner(tournamentId, slotKey, bannerId) {
  const banner = sponsorshipConfig(tournamentId).slots[slotKey].banners.find((b) => b.id === bannerId)
  updateSponsorship(tournamentId, (config) => {
    config.slots[slotKey].banners = config.slots[slotKey].banners.filter((b) => b.id !== bannerId)
  })
  void deleteAsset(banner?.image)
  void deleteAsset(banner?.imageMobile)
}

export function patchSlot(tournamentId, slotKey, patch) {
  updateSponsorship(tournamentId, (config) => {
    config.slots[slotKey] = { ...config.slots[slotKey], ...patch }
  })
}

// A banner needs a picture or a headline to be worth showing.
export const bannerIsShowable = (banner) => Boolean(banner.image || banner.title)

/** Everything the public pages need, resolved: `lockup(slot)`, `banners(slot)`, `partners`. */
export function sponsorshipView(config) {
  const byId = Object.fromEntries(config.sponsors.map((s) => [s.id, s]))

  function lockup(slotKey) {
    const slot = config.slots[slotKey]
    // A logo place shows exactly the sponsor put there, nothing implicit.
    const sponsor = slot?.enabled && slot.sponsorId ? byId[slot.sponsorId] || null : null
    return sponsor ? { sponsor, label: slot.label, slot: slotKey } : null
  }

  function banners(slotKey) {
    const slot = config.slots[slotKey]
    if (!slot?.enabled) return []
    return slot.banners
      .filter(bannerIsShowable)
      .map((banner) => ({ banner, sponsor: byId[banner.sponsorId] || null }))
  }

  const partnersSlot = config.slots.partners
  const partnerList = partnersSlot.enabled
    ? (partnersSlot.sponsorIds ? partnersSlot.sponsorIds.map((id) => byId[id]).filter(Boolean) : config.sponsors)
    : []
  const partners = partnerList.length
    ? {
      title: partnersSlot.title,
      groups: SPONSOR_TIERS
        .map((tier) => ({ tier, sponsors: partnerList.filter((s) => s.tier === tier) }))
        .filter((group) => group.sponsors.length),
    }
    : null

  return { lockup, banners, partners }
}

// Nothing shows while the feature is off on the platform, or until a platform
// admin approved sponsorship for the tournament.
export function useSponsorship(tournament) {
  const featureOn = useSponsorshipFeature()
  return computed(() => {
    const id = unref(tournament)?.id
    const on = featureOn() && sponsorshipApproved(id)
    return sponsorshipView(on ? sponsorshipConfig(id) : emptyConfig())
  })
}

/** Pages provide it once; the bracket, live window and champion banner inject it. */
export function provideSponsorship(tournament) {
  const view = useSponsorship(tournament)
  provide(SPONSORSHIP_KEY, view)
  return view
}

export function injectSponsorship() {
  return inject(SPONSORSHIP_KEY, computed(() => sponsorshipView(emptyConfig())))
}

/** Outgoing link tagged so the sponsor sees which slot and tournament sent the visit. */
export function sponsorLink(url, placement, campaign = '') {
  const safe = safeUrl(url)
  if (!safe) return ''
  const tagged = new URL(safe)
  tagged.searchParams.set('utm_source', 'bracketa')
  tagged.searchParams.set('utm_medium', 'sponsorship')
  tagged.searchParams.set('utm_content', placement)
  if (campaign) tagged.searchParams.set('utm_campaign', campaign)
  return tagged.toString()
}

export function trackSponsorClick(sponsor, placement) {
  track('sponsor_click', { sponsor: sponsor?.name || 'unknown', placement })
}

/** Demo content to try the slots: three sponsors, labels and three banners. */
export function demoSponsorship(t) {
  const bmw = { ...emptySponsor(), name: 'BMW', url: 'https://www.bmw.com/', tier: 'title', caption: t('sponsor.demo.bmwCaption'), logo: { url: '/sponsor-demo/bmw.svg', width: 200, height: 200 }, logoDark: { url: '/sponsor-demo/bmw-dark.svg', width: 200, height: 200 }, showName: true }
  const water = { ...emptySponsor(), name: 'Aqua Vita', url: 'https://example.com/aqua-vita', tier: 'official', caption: t('sponsor.demo.waterCaption'), logo: { url: '/sponsor-demo/aqua-vita.svg', width: 360, height: 120 }, logoDark: { url: '/sponsor-demo/aqua-vita-dark.svg', width: 360, height: 120 }, showName: false }
  const radio = { ...emptySponsor(), name: 'Radio Sport 101', url: 'https://example.com/radio-sport', tier: 'media', caption: t('sponsor.demo.radioCaption'), logo: { url: '/sponsor-demo/radio-sport.svg', width: 360, height: 120 }, logoDark: { url: '/sponsor-demo/radio-sport-dark.svg', width: 360, height: 120 }, showName: false }
  const config = emptyConfig()
  config.sponsors = [bmw, water, radio]
  for (const key of ['hero', 'bracket', 'standings', 'champion', 'embed', 'poster']) config.slots[key].sponsorId = bmw.id
  config.slots.live.sponsorId = radio.id
  config.slots.top.banners = [{
    ...emptyBanner(bmw.id),
    image: { url: '/sponsor-demo/bmw-banner-wide.svg', width: 1600, height: 400 },
    imageMobile: { url: '/sponsor-demo/bmw-banner-mobile.svg', width: 800, height: 400 },
    alt: 'BMW iX',
    url: 'https://www.bmw.com/en/automotive-life/bmw-ix.html',
  }]
  config.slots.registration.banners = [{
    ...emptyBanner(bmw.id),
    eyebrow: t('sponsor.demo.offerEyebrow'),
    title: t('sponsor.demo.offerTitle'),
    text: t('sponsor.demo.offerText'),
    cta: t('sponsor.demo.offerCta'),
    url: 'https://www.bmw.com/',
  }]
  config.slots.bottom.banners = [{
    ...emptyBanner(water.id),
    image: { url: '/sponsor-demo/court-photo.svg', width: 1600, height: 400 },
    eyebrow: 'Aqua Vita',
    title: t('sponsor.demo.waterTitle'),
    text: t('sponsor.demo.waterText'),
    cta: t('sponsor.demo.waterCta'),
    url: 'https://example.com/aqua-vita',
    showLogo: false,
  }]
  return config
}

export function applyDemo(tournamentId, t) {
  const demo = demoSponsorship(t)
  updateSponsorship(tournamentId, (config) => {
    config.sponsors = demo.sponsors
    config.slots = demo.slots
  })
}
