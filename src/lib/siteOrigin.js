// Public site origin baked in at build time (vite.config.js, SITE_URL or Vercel's production
// domain); preview deployments and the dev server fall back to their own host.
/* global __SITE_ORIGIN__ */
export const siteOrigin = (typeof __SITE_ORIGIN__ !== 'undefined' && __SITE_ORIGIN__) || globalThis.location?.origin || ''
