// Participant emails (lt / ru / en). Every string from the database is escaped; each
// email links to the tournament page and invites the reader to run their own tournament.
import { DEFAULT_LOCALE, isLocale, landingPath } from '../src/lib/localeRoute.js'
import { SITE_NAME, escapeHtml } from '../src/lib/seo.js'

const COPY = {
  lt: {
    hello: name => `Sveiki, ${name}!`,
    open: 'Atidaryti turnyro puslapį',
    why: t => `Šį laišką gavote, nes užsiregistravote į turnyrą „${t}“ ${SITE_NAME} platformoje.`,
    growth: 'Organizuojate turnyrą? Sukurkite jį nemokamai',
    court: c => `, kortas: ${c}`,
    kinds: {
      registration_received: { subject: t => `Registracija gauta: ${t}`, body: t => `Gavome jūsų registraciją į turnyrą „${t}“. Organizatorius ją peržiūrės, o apie sprendimą pranešime el. paštu.` },
      registration_waitlisted: { subject: t => `Esate laukiančiųjų sąraše: ${t}`, body: t => `Visos turnyro „${t}“ vietos užimtos, todėl įrašėme jus į laukiančiųjų sąrašą. Jei vieta atsilaisvins, pranešime.` },
      registration_approved: { subject: t => `Registracija patvirtinta: ${t}`, body: t => `Jūsų registracija į turnyrą „${t}“ patvirtinta. Tinklelį, tvarkaraštį ir rezultatus rasite turnyro puslapyje. Iki pasimatymo korte!` },
      registration_rejected: { subject: t => `Registracija nepatvirtinta: ${t}`, body: t => `Deja, organizatorius nepatvirtino jūsų registracijos į turnyrą „${t}“. Jei turite klausimų, susisiekite su organizatoriumi.` },
      match_reminder: { subject: t => `Jūsų rungtynės netrukus: ${t}`, body: (t, m) => `Jūsų rungtynės${m.opponent ? ` prieš ${m.opponent}` : ''} prasideda ${m.time}${m.court}. Turnyras „${t}“.` },
    },
  },
  ru: {
    hello: name => `Здравствуйте, ${name}!`,
    open: 'Открыть страницу турнира',
    why: t => `Вы получили это письмо, потому что зарегистрировались на турнир «${t}» в ${SITE_NAME}.`,
    growth: 'Организуете турнир? Создайте его бесплатно',
    court: c => `, корт: ${c}`,
    kinds: {
      registration_received: { subject: t => `Заявка получена: ${t}`, body: t => `Мы получили вашу заявку на турнир «${t}». Организатор её рассмотрит, а о решении мы сообщим по почте.` },
      registration_waitlisted: { subject: t => `Вы в листе ожидания: ${t}`, body: t => `Все места на турнире «${t}» заняты, поэтому мы добавили вас в лист ожидания. Если место освободится, мы сообщим.` },
      registration_approved: { subject: t => `Заявка одобрена: ${t}`, body: t => `Ваша заявка на турнир «${t}» одобрена. Сетку, расписание и счёт вы найдёте на странице турнира. До встречи на корте!` },
      registration_rejected: { subject: t => `Заявка не одобрена: ${t}`, body: t => `К сожалению, организатор не одобрил вашу заявку на турнир «${t}». Если есть вопросы, свяжитесь с организатором.` },
      match_reminder: { subject: t => `Ваш матч скоро: ${t}`, body: (t, m) => `Ваш матч${m.opponent ? ` против ${m.opponent}` : ''} начинается в ${m.time}${m.court}. Турнир «${t}».` },
    },
  },
  en: {
    hello: name => `Hi ${name},`,
    open: 'Open the tournament page',
    why: t => `You received this email because you signed up for “${t}” on ${SITE_NAME}.`,
    growth: 'Running a tournament? Create yours for free',
    court: c => `, court: ${c}`,
    kinds: {
      registration_received: { subject: t => `Registration received: ${t}`, body: t => `We have received your registration for “${t}”. The organiser will review it and we will email you the decision.` },
      registration_waitlisted: { subject: t => `You are on the waitlist: ${t}`, body: t => `All places in “${t}” are taken, so you are on the waitlist. We will let you know if a place opens up.` },
      registration_approved: { subject: t => `Registration approved: ${t}`, body: t => `Your registration for “${t}” is approved. The bracket, schedule and scores are on the tournament page. See you on court!` },
      registration_rejected: { subject: t => `Registration not approved: ${t}`, body: t => `Unfortunately the organiser did not approve your registration for “${t}”. If you have questions, please contact the organiser.` },
      match_reminder: { subject: t => `Your match starts soon: ${t}`, body: (t, m) => `Your match${m.opponent ? ` against ${m.opponent}` : ''} starts at ${m.time}${m.court}. Tournament: “${t}”.` },
    },
  },
}

const INTL = { ru: 'ru-RU', en: 'en-GB', lt: 'lt-LT' }

function matchTime(date, locale, timeZone) {
  if (!date) return ''
  const options = { hour: '2-digit', minute: '2-digit', hour12: false }
  try { return new Intl.DateTimeFormat(INTL[locale], { ...options, timeZone: timeZone || undefined }).format(new Date(date)) } catch { return new Intl.DateTimeFormat(INTL[locale], options).format(new Date(date)) }
}

/** { subject, html, text } for one claimed outbox row. */
export function buildEmail(row, origin) {
  const locale = isLocale(row.locale) ? row.locale : DEFAULT_LOCALE
  const copy = COPY[locale]
  const kind = copy.kinds[row.kind]
  if (!kind) throw new Error(`Unknown notification kind ${row.kind}`)
  const tournament = String(row.tournament_name ?? '')
  const match = {
    opponent: row.opponent_name || '',
    time: matchTime(row.scheduled_at, locale, row.time_zone),
    court: row.court_name ? copy.court(row.court_name) : '',
  }
  const pageUrl = `${origin}/tournaments/${encodeURIComponent(row.tournament_slug)}?utm_source=email&utm_medium=notification&utm_campaign=${row.kind}`
  const homeUrl = `${origin}${landingPath(locale)}?utm_source=email&utm_medium=notification&utm_campaign=growth`
  const subject = kind.subject(tournament)
  const hello = copy.hello(row.entry_name || '')
  const body = kind.body(tournament, match)
  const e = escapeHtml
  const text = [hello, '', body, '', `${copy.open}: ${pageUrl}`, '', '—', copy.why(tournament), `${copy.growth}: ${homeUrl}`].join('\n')
  const html = `<!doctype html>
<html lang="${locale}"><body style="margin:0;padding:0;background:#F7F7F4;font-family:Arial,Helvetica,sans-serif;color:#14201B">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F7F7F4"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#FFFFFF;border-radius:16px;border:1px solid #E4E7E2">
<tr><td style="padding:24px 28px 0;font-size:20px;font-weight:bold;color:#0F7B4D">${SITE_NAME}</td></tr>
<tr><td style="padding:16px 28px 0;font-size:16px;line-height:1.6">
<p style="margin:0 0 12px">${e(hello)}</p>
<p style="margin:0 0 20px">${e(body)}</p>
<p style="margin:0 0 24px"><a href="${e(pageUrl)}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#0F7B4D;color:#FFFFFF;text-decoration:none;font-weight:bold">${e(copy.open)}</a></p>
</td></tr>
<tr><td style="padding:16px 28px 24px;border-top:1px solid #E4E7E2;font-size:13px;line-height:1.5;color:#5E6B64">
<p style="margin:0 0 8px">${e(copy.why(tournament))}</p>
<p style="margin:0"><a href="${e(homeUrl)}" style="color:#0F7B4D">${e(copy.growth)} →</a></p>
</td></tr></table>
</td></tr></table></body></html>`
  return { subject, html, text }
}
