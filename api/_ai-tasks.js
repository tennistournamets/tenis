// AI tasks: prompt + answer check per feature. A task is
//   { tournament: boolean,                          // needs context.tournamentId (import, score, posts)
//     allowEmptyInput?: boolean,                    // the task works from context alone (posts)
//     maxTokens?, temperature?,
//     prompt({ input, context }) -> { system, user },
//     check(json, { input, context }) -> result }   // throws AiError('ai.badResponse') when unusable
// Keys match the feature switches (`ai.<task>`) and the task check in ai_begin_call().
// Each feature adds its task here.
import { checkCreate, checkImport } from '../src/lib/aiSchemas.js'
import { SPORTS } from '../src/lib/sportConfig.js'
import { AiError } from './_ai-errors.js'

// Named in English and in the language itself: with the English name alone the model kept
// answering in the list's language.
const LANGUAGES = { ru: 'Russian (на русском языке)', en: 'English', lt: 'Lithuanian (lietuvių kalba)' }
const SHAPES = ['single', 'pair', 'pairOptional']

const language = context => LANGUAGES[context.locale] ?? LANGUAGES.lt
const shapeOf = context => (SHAPES.includes(context.shape) ? context.shape : 'single')

// The model's answer passes through the shared check; a broken shape is the model's fault.
function checked(fn) {
  try {
    return fn()
  } catch (error) {
    if (error?.code === 'ai.badResponse') throw new AiError('ai.badResponse')
    throw error
  }
}

const ENTRY_RULE = {
  single: 'Each entry is ONE participant: put exactly one name in "members". If a line names two people, they are two separate entries.',
  pair: 'Each entry is a PAIR of two players: put both names in "members". If a line has only one player, return that one name; the organizer will pair them.',
  pairOptional: 'Each entry is one player or a pair: put one or two names in "members" exactly as registered.',
}

export function importPrompt(input, context) {
  const shape = shapeOf(context)
  const team = context.sport === 'football'
  const system = [
    'You read lists of tournament participants that an organizer pasted: chat messages, spreadsheet rows, documents, notes.',
    'Reply with json only, in this shape:',
    '{"entries":[{"members":["name"],"contact":null,"note":null}],"unparsed":[],"warnings":[]}',
    'Rules:',
    team ? '- Participants are football teams: "members" holds the team name only.' : `- ${ENTRY_RULE[shape]}`,
    '- Copy names exactly as written, keeping diacritics (ą č ę ė į š ų ū ž, й, ё). Remove list numbers, bullets, emoji, times, prices and payment marks.',
    '- Pairs are often written "A / B", "A - B", "A ir B", "A и B", "A & B", "A + B" or on two lines under one number.',
    '- "contact": the email or phone written next to that participant, otherwise null. Never invent contacts.',
    '- "note": a short remark written next to the name (level, rating, club, "paid", "reserve"), otherwise null.',
    '- Ignore lines that are not participants (titles, dates, rules, chat chatter). Lines that look like participants but cannot be read go to "unparsed" as written.',
    '- Keep the order of the list. Do not merge or drop repeated names, do not invent people.',
    '- The text may be recognized from a photo or a screenshot: ignore stray symbols around the lines and repair only obvious recognition errors — a space or a lost dot in an email ("gmail com" → "gmail.com", "k klimas@" → "k.klimas@"), "1t"/"It" → "lt" in a domain, é → ė or similar in Lithuanian names. Name each repair in "warnings". Never guess a missing part: leave such a contact null.',
    `- "warnings": up to 5 short sentences about doubtful places, or []. Write them in ${language(context)}, whatever the language of the list.`,
  ].join('\n')
  // Repeated after the list: the model otherwise answers in the list's language.
  return { system, user: `Participant list:\n<<<\n${input}\n>>>\nWrite "warnings" in ${language(context)}, not in the language of the list.` }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/

export function createPrompt(input, context) {
  const sports = (Array.isArray(context.enabledSports) ? context.enabledSports : []).filter(sport => SPORTS.includes(sport))
  const today = DATE.test(String(context.today ?? '')) ? context.today : new Date().toISOString().slice(0, 10)
  const system = [
    'An organizer describes a sports tournament in free text (a chat message, an announcement, notes, a dictated message), sometimes with the list of participants. Fill the create form of a tournament app.',
    'Reply with json only, in this shape ("name" is filled whenever the text describes a tournament; other fields are null when the text does not give them):',
    '{"language":"lt","tournament":{"name":"Rudens lyga","sport":null,"format":null,"category":null,"pairing":null,"description":null,"venue_address":null,"contact_phone":null,"contact_email":null,"set_format":null,"tiebreak_to":null,"points_per_match":null,"gender":null,"advance_per_group":null,"capacity":null,"deadline":null,"fee":null,"waitlist":null},"participants":[],"unparsed":[],"warnings":[]}',
    'Fields:',
    `- "sport": one of ${JSON.stringify(sports.length ? sports : SPORTS)} (tenisas/теннис = tennis, padelis/падел = padel, futbolas/футбол = football).`,
    '- "format": "single_elimination" (knockout, olimpinė, на выбывание, плей-офф), "round_robin" (league, kiekvienas su kiekvienu, круговая), "groups_playoff" (groups then knockout), "double_elimination", or padel only: "americano", "mexicano", "team_americano" (Americano with fixed pairs), "king_of_court".',
    '- "category": "singles" or "doubles" (pairs, poros, пары) — tennis only. "pairing": "pick_random" when partners are drawn for people who sign up alone, "pre_agreed" when pairs register together.',
    '- "language": the language the organizer wrote in ("lt", "ru", "en", …). "name" and "description" are written in this language, not in the language of the warnings.',
    '- "name": the tournament name if written; otherwise you must compose a short one from the sport, format and date (e.g. "Padelio Americano 11.15", "Парный турнир по теннису 16.11", "Autumn Tennis League") and say so in "warnings". Never a participant\'s name. Null only when the text is just a list of participants.',
    '- "description": 1–3 sentences for the public page in the organizer\'s language: date and time, level, what is included. No participant list, no contacts.',
    '- "venue_address": club and address as written. "contact_phone"/"contact_email": the organizer\'s contacts for questions or registration.',
    '- "set_format": "best_of_3" or "best_of_5". "tiebreak_to": 7 or 10 (padel). "points_per_match": total points of one match in Americano/Mexicano/King of the Court (e.g. "to 21" → 21, "24 points" → 24).',
    '- "gender": "men", "women" or "mixed". "advance_per_group": players advancing from each group (1–4).',
    '- "capacity": maximum number of entries (players, pairs or teams). "waitlist": true if a waiting list is mentioned.',
    `- "deadline": registration deadline as local "YYYY-MM-DDTHH:MM". Today is ${today} (${context.weekday || 'unknown weekday'}), time zone Europe/Vilnius; resolve "until Friday 20:00" from today; a date without a year is the next such date (this year if it is still ahead, else next year). Not the date of the tournament itself — that goes into the description.`,
    '- "fee": {"mode":"free"} when free; {"mode":"paid","amount":20,"currency":"EUR","unit":"player"|"pair"|"team"} when paid.',
    '- "participants": only if the text lists participants, else []. Each: {"members":["name"] or ["name","partner"],"contact":null,"note":null}. Copy names exactly with diacritics; a pair written "A / B", "A ir B", "A и B" is one entry with two members. Team sports: the team name only.',
    '- "unparsed": lines that look like participants but cannot be read.',
    '- The text may be dictated or recognized from a photo: ignore stray symbols and repair only obvious recognition slips, naming each in "warnings".',
    '- Never invent facts that are not in the text: leave them null.',
    `- "warnings": up to 5 short sentences about doubtful places, or []. Write them in ${language(context)}, whatever the language of the text.`,
  ].join('\n')
  return { system, user: `Tournament description:\n<<<\n${input}\n>>>\nWrite "warnings" in ${language(context)}, not in the language of the text.` }
}

export const TASKS = {
  create: {
    tournament: false,
    maxTokens: 8000,
    temperature: 0,
    prompt: ({ input, context }) => createPrompt(input, context),
    check: (json, { context }) => checked(() => checkCreate(json, {
      enabledSports: (Array.isArray(context.enabledSports) ? context.enabledSports : SPORTS).filter(sport => SPORTS.includes(sport)),
      sport: SPORTS.includes(context.sport) ? context.sport : 'tennis',
      today: DATE.test(String(context.today ?? '')) ? context.today : null,
    })),
  },
  import: {
    tournament: true,
    maxTokens: 8000,
    temperature: 0,
    prompt: ({ input, context }) => importPrompt(input, context),
    check: (json, { context }) => checked(() => checkImport(json, { shape: shapeOf(context) })),
  },
}
