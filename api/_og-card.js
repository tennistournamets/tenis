// Layout of the per-tournament preview image (1200x630), as satori element objects
// (no JSX build step). Files starting with "_" in api/ are not deployed as functions.
import { LABELS, formatDateRange } from '../src/lib/seo.js'
import { DEFAULT_LOCALE } from '../src/lib/localeRoute.js'

const h = (type, style, children, props = {}) => ({ type, props: { style, children, ...props } })

const LOGO = 'data:image/svg+xml;base64,' + Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 28 28"><rect width="28" height="28" rx="8" fill="#0F7B4D"/><path d="M11 8H9.5A1.5 1.5 0 0 0 8 9.5v9A1.5 1.5 0 0 0 9.5 20H11" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/><path d="M17 8h1.5A1.5 1.5 0 0 1 20 9.5v9a1.5 1.5 0 0 1-1.5 1.5H17" stroke="#fff" stroke-width="2" stroke-linecap="round" fill="none"/><circle cx="14" cy="14" r="2.2" fill="#C6F24E"/></svg>`).toString('base64')

const CHIP_STYLE = {
  registration_open: { background: '#C6F24E', color: '#11251C' },
  registration_closed: { background: 'rgba(255,255,255,0.12)', color: '#F4F6F2' },
  in_progress: { background: '#FF5A48', color: '#FFFFFF' },
  completed: { background: '#8B5CF6', color: '#FFFFFF' },
}

/** Title size steps down for long names so up to three lines fit. */
export function titleSize(name) {
  const length = [...String(name ?? '')].length
  if (length <= 22) return 92
  if (length <= 40) return 76
  if (length <= 64) return 62
  return 52
}

export function tournamentCard(row, locale = DEFAULT_LOCALE) {
  const labels = LABELS[locale] ?? LABELS[DEFAULT_LOCALE]
  const chip = labels.chip[row.status]
  const facts = [
    labels.sport[row.sport],
    labels.format[row.format],
    formatDateRange(row.starts_at, row.ends_at, locale, row.schedule_config?.timezone),
  ].filter(Boolean)
  const venue = row.venue_address ? String(row.venue_address).slice(0, 70) : ''

  return h('div', {
    width: '100%', height: '100%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
    padding: '56px 72px', background: '#101512', color: '#F4F6F2', fontFamily: 'Onest',
    backgroundImage: 'radial-gradient(circle at 92% 8%, rgba(198,242,78,0.18), rgba(16,21,18,0) 45%), radial-gradient(circle at 0% 100%, rgba(15,123,77,0.55), rgba(16,21,18,0) 55%)',
  }, [
    h('div', { display: 'flex', alignItems: 'center', justifyContent: 'space-between' }, [
      h('div', { display: 'flex', alignItems: 'center' }, [
        h('img', { width: 56, height: 56 }, undefined, { src: LOGO, width: 56, height: 56 }),
        h('div', { marginLeft: 18, fontSize: 40, fontWeight: 800, letterSpacing: '-0.03em' }, 'Bracketa'),
      ]),
      chip
        ? h('div', { display: 'flex', alignItems: 'center', padding: '12px 26px', borderRadius: 999, fontSize: 28, fontWeight: 800, letterSpacing: row.status === 'in_progress' ? '0.08em' : '0', ...CHIP_STYLE[row.status] },
          row.status === 'in_progress'
            ? [h('div', { width: 14, height: 14, borderRadius: 999, background: '#FFFFFF', marginRight: 12 }), chip]
            : chip)
        : h('div', { display: 'flex' }, ''),
    ]),
    h('div', {
      display: 'block', fontSize: titleSize(row.name), fontWeight: 800, lineHeight: 1.06, letterSpacing: '-0.035em',
      lineClamp: 3, overflow: 'hidden', maxHeight: titleSize(row.name) * 1.06 * 3 + 4,
    }, String(row.name ?? '')),
    h('div', { display: 'flex', flexDirection: 'column' }, [
      h('div', { display: 'flex', flexWrap: 'wrap' }, facts.map(fact => h('div', {
        display: 'flex', padding: '10px 22px', marginRight: 14, marginTop: 12, borderRadius: 999, fontSize: 28, fontWeight: 600,
        background: 'rgba(255,255,255,0.08)', border: '1px solid rgba(255,255,255,0.16)',
      }, fact))),
      venue ? h('div', { display: 'flex', marginTop: 20, fontSize: 28, fontWeight: 600, color: '#AAB6AF' }, venue) : h('div', { display: 'flex' }, ''),
    ]),
  ])
}
