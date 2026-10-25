// AI tasks: prompt + answer check per feature. A task is
//   { tournament: boolean,                          // needs context.tournamentId (import, score, posts)
//     allowEmptyInput?: boolean,                    // the task works from context alone (posts)
//     maxTokens?, temperature?,
//     prompt({ input, context }) -> { system, user },
//     check(json, { input, context }) -> result }   // throws AiError('ai.badResponse') when unusable
// Keys match the feature switches (`ai.<task>`) and the task check in ai_begin_call().
// Each feature adds its task here.
import { checkCreate, checkImport, checkPosts, checkScore } from '../src/lib/aiSchemas.js'
import { SPORTS } from '../src/lib/sportConfig.js'
import { AiError } from './_ai-errors.js'

// Named in English and in the language itself: with the English name alone the model kept
// answering in the list's language.
const LANGUAGES = { ru: 'Russian (на русском языке)', en: 'English', lt: 'Lithuanian (lietuvių kalba)' }
const SHAPES = ['single', 'pair', 'pairOptional']
const FAMILIES = ['sets', 'goals', 'points']
const SCORE_MATCHES_MAX = 150

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
    'An organizer describes a sports tournament in free text (a chat message, an announcement, notes, a dictated message), sometimes with the list of participants. Propose a complete tournament for a tournament app: what the text says, plus sensible choices for what it leaves out, plus short questions about what matters and cannot be guessed.',
    'Reply with json only, in this shape ("name" is filled whenever the text describes a tournament; other fields are null when the text does not give them):',
    '{"language":"lt","tournament":{"name":"Rudens lyga","sport":null,"format":null,"category":null,"pairing":null,"description":null,"venue_address":null,"contact_phone":null,"contact_email":null,"set_format":null,"tiebreak_to":null,"points_per_match":null,"gender":null,"advance_per_group":null,"capacity":null,"deadline":null,"fee":null,"waitlist":null,"courts":null},"suggested":{},"questions":[],"participants":[],"unparsed":[],"warnings":[]}',
    'Fields:',
    `- "sport": one of ${JSON.stringify(sports.length ? sports : SPORTS)} (tenisas/теннис = tennis, padelis/падел = padel, futbolas/футбол = football).`,
    '- "format": "single_elimination" (knockout, olimpinė, на выбывание, плей-офф), "round_robin" (league, kiekvienas su kiekvienu, круговая), "groups_playoff" (groups then knockout), "double_elimination", or padel only: "americano", "mexicano", "team_americano" (Americano with fixed pairs), "king_of_court".',
    '- "category": "singles" or "doubles" (pairs, poros, пары) — tennis only. "pairing": "pick_random" when partners are drawn for people who sign up alone, "pre_agreed" when pairs register together.',
    '- "language": the language the organizer wrote in ("lt", "ru", "en", …). "name" and "description" are written in this language, not in the language of the warnings. Mixed languages are normal (Lithuanian club names and addresses in a Russian or English text): never mention languages in "warnings".',
    '- "name": the tournament name if written; otherwise you must compose a short one from the sport, format and date (e.g. "Padelio Americano 11.15", "Парный турнир по теннису 16.11", "Autumn Tennis League") and say so in "warnings". Never a participant\'s name. Null only when the text is just a list of participants.',
    '- "description": only what has no field of its own, for the public page in the organizer\'s language: when it is played (date, time), level, prizes, what is included, other remarks to players. Never repeat what the other fields hold (sport, format, name, club or address, points, set format, gender, places, deadline, fee, waitlist, contacts) and no participant list. A short line is fine; null when nothing is left. Example: "Парный турнир по теннису 15 ноября в 10:00, клуб SEB арена, призы победителям" → "15 ноября, 10:00. Призы победителям." (pairs, sport and club have their own fields).',
    '- "venue_address": club and address as written. "contact_phone"/"contact_email": the organizer\'s contacts for questions or registration.',
    '- "set_format": "best_of_3" or "best_of_5". "tiebreak_to": 7 or 10 (padel). "points_per_match": total points of one match in Americano/Mexicano/King of the Court (e.g. "to 21" → 21, "24 points" → 24).',
    '- "gender": "men", "women" or "mixed" ("mixed" only for doubles with fixed pairs, never for Americano, Mexicano or King of the Court). "advance_per_group": players advancing from each group (1–4).',
    '- "capacity": maximum number of entries (players, pairs or teams). "waitlist": true if a waiting list is mentioned. "courts": number of courts available.',
    `- "deadline": registration deadline as local "YYYY-MM-DDTHH:MM". Today is ${today} (${context.weekday || 'unknown weekday'}), time zone Europe/Vilnius; resolve "until Friday 20:00" from today; a date without a year is the next such date (this year if it is still ahead, else next year). A date without a time means 23:59 of that day. Not the date of the tournament itself — that goes into the description.`,
    '- "fee": {"mode":"free"} when free; {"mode":"paid","amount":20,"currency":"EUR","unit":"player"|"pair"|"team"} when paid.',
    '- "participants": only if the text lists participants, else []. Each: {"members":["name"] or ["name","partner"],"contact":null,"note":null}. Copy names exactly with diacritics; a pair written "A / B", "A ir B", "A и B" is one entry with two members. Team sports: the team name only.',
    '- "unparsed": lines that look like participants but cannot be read.',
    '- The text may be dictated or recognized from a photo: ignore stray symbols and repair only obvious recognition slips, in names and contacts too ("inbox.1t" → "inbox.lt", "gmail com" → "gmail.com"), naming each in "warnings".',
    '- "tournament" holds only what the text (or the organizer\'s answers) says; never invent facts there.',
    '- "suggested": the same keys as "tournament" (plus "visibility": "public"|"link"|"private"), only for what "tournament" left null and a typical amateur club tournament needs. Choose like an experienced organizer: padel, players signing up alone → "americano" (up to ~24 players) with points_per_match 24 (21 or 16 when there are many rounds or little time); padel pairs → "single_elimination" up to 8 pairs, "groups_playoff" above; tennis singles → "round_robin" up to 6 players, "single_elimination" above; football teams → "round_robin" up to 6, "groups_playoff" above; set_format "best_of_3"; courts = players ÷ 4 rounded down (at least 1) for Americano/Mexicano when the number of players is known; capacity = the listed participants rounded up to fill the courts or the bracket (a multiple of 4 for Americano, a power of two for knockout), else 16; visibility "link". Do not suggest a deadline, fee, gender, contacts or venue.',
    '- "questions": at most 3, only about what matters for the tournament, is missing and cannot be chosen sensibly — usually the date and start time, the number of courts for Americano-style formats when the number of players is unknown, the number of places. Ask only about what applies to the chosen format: never a set format or tiebreak for Americano, Mexicano, Team Americano or King of the Court. Do not ask about anything already answered, in the text or in "suggested"; after the organizer\'s answers, ask again only if something essential is still missing. Never ask about gender, visibility or contacts. Each: {"field":"courts","question":"…","options":["…","…"]} — "field" is the "tournament" key the answer fills, or "date" for the day and start time; 2–4 short options (e.g. "10:00", "3", "16"). Write them in the language of the warnings. [] when nothing important is missing.',
    `- "warnings": up to 5 short sentences about doubtful places, or []. Write them in ${language(context)}, whatever the language of the text. Never a warning about something a question asks (if you ask about the date, do not also warn that it is missing), and do not comment on the language of the text or the name.`,
    '- Americano and Mexicano work with any number of players from 4: each court takes 4 players a round and whoever has no court rests (players − 4 × courts rest each round: 8 players on 2 courts means nobody rests), so a count that is not a multiple of 4 is fine. Never write a warning about resting players or about multiples of 4 for them. Only King of the Court needs a multiple of 4 (at least 8).',
    '- A court is "kortas" in Lithuanian (never "laukas") and "корт" in Russian; a football pitch is "aikštė" / "поле".',
  ].join('\n')
  // Answers to earlier questions come back with the same text; they count as the organizer's words.
  const answers = (Array.isArray(context.answers) ? context.answers : [])
    .map(item => [String(item?.question ?? '').slice(0, 140).trim(), String(item?.answer ?? '').slice(0, 200).trim()])
    .filter(([question, answer]) => question && answer)
    .slice(0, 6)
  const answered = answers.length ? `\nThe organizer's answers to your questions:\n${answers.map(([q, a]) => `- ${q} → ${a}`).join('\n')}` : ''
  return { system, user: `Tournament description:\n<<<\n${input}\n>>>${answered}\nWrite "warnings" and "questions" in ${language(context)}, not in the language of the text, and say nothing about languages.` }
}

// The open matches as the browser listed them: short references, headings, side names.
function scoreMatches(context) {
  return (Array.isArray(context.matches) ? context.matches : [])
    .slice(0, SCORE_MATCHES_MAX)
    .map(item => ({
      ref: String(item?.ref ?? '').slice(0, 8),
      heading: String(item?.heading ?? '').replace(/\s+/g, ' ').slice(0, 80),
      a: String(item?.a ?? '').replace(/\s+/g, ' ').slice(0, 120),
      b: String(item?.b ?? '').replace(/\s+/g, ' ').slice(0, 120),
    }))
    .filter(item => /^m\d+$/.test(item.ref))
}

const familyOf = context => (FAMILIES.includes(context.family) ? context.family : 'sets')

const SCORE_SHAPE = {
  sets: '"sets":[{"a":6,"b":4},{"a":7,"b":6,"tb":{"a":7,"b":5}}]',
  points: '"score":{"a":21,"b":15}',
  goals: '"score":{"a":2,"b":2},"pens":{"a":4,"b":3}',
}

export function scorePrompt(input, context) {
  const family = familyOf(context)
  const target = Number.isInteger(Number(context.target)) ? Number(context.target) : null
  const setFormat = context.setFormat === 'best_of_5' ? 'best of 5 sets' : 'best of 3 sets'
  const finalSet = typeof context.finalSet === 'string' && /^match_tiebreak_\d+$/.test(context.finalSet)
    ? ` The deciding set is a match tie-break to ${context.finalSet.split('_').at(-1)} points: give its points as the set, e.g. {"a":10,"b":8}.`
    : ''
  const rules = {
    sets: `- Tennis/padel, ${setFormat}.${finalSet} Each set is games {"a":6,"b":4}; add "tb" only when tie-break points are said ("7:6 (7:5)", "septyni šeši, tie-breakas septyni penki").`,
    points: `- Points format: the two scores of a match add up to ${target ?? 'the target'}. If only the winner\'s points or one side\'s points are said, the other side has the rest.`,
    goals: '- Football: goals per side; "pens" only for a draw decided by a penalty shootout, else null.',
  }
  const system = [
    'An organizer or a referee at the court says or types results of tournament matches, often by voice (the text can be a speech transcript with garbled names). Find the listed match each result belongs to and read its score.',
    'Reply with json only, in this shape:',
    `{"results":[{"match":"m3","candidates":[],"heard":"Petraitis Kazlauskas šeši keturi šeši trys","winner":"a",${SCORE_SHAPE[family]}}],"unmatched":[],"warnings":[]}`,
    'Rules:',
    '- "match": the reference ("m1", "m2", …) of the listed match the result belongs to. Players are named by surname, first name or nickname, in any grammatical case (Lithuanian "Petraičio", "Petraičiui" = Petraitis; Russian "Иванова", "Иванову" = Иванов), with recognition slips; match them by sound and spelling. A court or round, when said, narrows the choice. Rounds are played in order: when only a court is said, it is the earliest listed round with that court.',
    '- If a result fits two or more matches equally, "match": null and "candidates": their references. If it fits none, put that piece of text into "unmatched" instead of a result.',
    '- Numbers are given as seen from side "a" of that match as listed: the first number belongs to "a". When the text names side "b" first ("Kazlauskas beat Petraitis 6:4", with Petraitis listed as "a"), swap so each side keeps its own numbers. "winner": the side the text says won ("a" or "b"), else null.',
    '- Numbers may be words in any language ("šeši keturi", "шесть четыре", "six four") or digits with ":", "-", "/" or spaces.',
    rules[family],
    '- "heard": the piece of the text this result came from, as written.',
    '- One text may hold several results; return one item per match, in the order said. Never invent a score that is not said.',
    `- "warnings": only real doubts the person must check (a name that might be another player, a number that might be misheard), up to 3 short sentences, else []. Never explain routine steps: a missing winner, swapped sides, a computed other score, an ignored phrase. Name matches by players as listed (same spelling and alphabet), never by reference (m1, m2). Write them in ${language(context)}.`,
  ].join('\n')
  const list = scoreMatches(context).map(item => `${item.ref} | ${item.heading} | a: ${item.a} | b: ${item.b}`).join('\n')
  return {
    system,
    user: `Matches waiting for a result:\n${list || '(none)'}\n\nWhat was said:\n<<<\n${input}\n>>>\nWrite "warnings" in ${language(context)}.`,
  }
}

const POST_LANGUAGES = { ru: 'Russian', en: 'English', lt: 'Lithuanian' }
const FACTS_MAX = 12000

// The facts as the browser worked them out; too big a payload is cut to the essentials.
function postFacts(context) {
  const facts = context.facts && typeof context.facts === 'object' && !Array.isArray(context.facts) ? context.facts : {}
  const json = JSON.stringify(facts)
  return json.length <= FACTS_MAX ? json : JSON.stringify({ ...facts, results: (facts.results ?? []).slice(0, 4), next: [] }).slice(0, FACTS_MAX)
}
const postTokens = context => [...new Set(postFacts(context).match(/\bP\d{1,3}\b/g) ?? [])]

export function postsPrompt(input, context) {
  const lang = POST_LANGUAGES[context.postLanguage] ?? POST_LANGUAGES[context.locale] ?? 'Lithuanian'
  const system = [
    'You write short social media posts for an amateur sports club about its tournament: friendly, lively, never pompous.',
    'Reply with json only: {"instagram":"…","facebook":"…","whatsapp":"…"}.',
    'Rules:',
    '- Use only the facts given (and the organizer\'s note, if any). Never invent scores, players, dates, prizes, sponsors or places, and do not promise future events ("see you next year") unless the note says so.',
    '- Participants appear only as tokens P1, P2, … ("P1 / P2" is a pair). Write the tokens exactly as given; the app puts the names in later. Place each token where a name keeps its basic form: after a colon or a dash, in a list, or as the subject of a sentence ("P1 laimėjo finalą", "Чемпион — P1"), never as an object or after a preposition, because Lithuanian and Russian decline names. Wrong: "įveikęs P2", "prieš P2", "su P2", "P1 nugalėjo P2", "у P1", "против P2", "обыграл P2", "поздравляем P1". Right: "P1 — P2 6:3 6:4", "Finalas: P1 — P2", "Čempionas — P1", "Победитель — P1". When a sentence needs the other player, write the result as a dash pair or a colon list instead.',
    '- A result is "winner", "loser" and the score from the winner\'s side ("P3 — P1 6:4 6:2"); "draw" lists both sides. Opponents are joined with " — " or "vs", never with "/" (that means a pair).',
    '- Keep scores exactly as in the facts. "moment": "results" — the champion first, then the final and the highlights; "round" — that round\'s results, then what comes next ("next").',
    '- "instagram": 4–8 short lines, 2–4 fitting emoji, 3–6 hashtags on the last line (sport, city if the venue tells it, a short tag of the tournament). No link.',
    '- "facebook": 2–3 short paragraphs, thank the players, end with "{link}" on its own line.',
    '- "whatsapp": for the club chat, at most 6 lines, the first line in *bold* (WhatsApp asterisks), end with "{link}" on its own line.',
    `- Write all three in ${lang}. Keep the tournament name as written.`,
  ].join('\n')
  const note = String(input ?? '').trim()
  return {
    system,
    user: `Facts:\n${postFacts(context)}${note ? `\n\nOrganizer's note:\n<<<\n${note}\n>>>` : ''}\nWrite the posts in ${lang}. Tokens only in their basic form: "P1 — P2 6:3", never "įveikęs P2", "prieš P2" or "обыграл P2".`,
  }
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
      answered: Array.isArray(context.answers) && context.answers.length > 0,
    })),
  },
  score: {
    tournament: true,
    maxTokens: 4000,
    temperature: 0,
    prompt: ({ input, context }) => scorePrompt(input, context),
    check: (json, { context }) => checked(() => checkScore(json, {
      refs: Object.fromEntries(scoreMatches(context).map(item => [item.ref, true])),
      family: familyOf(context),
    })),
  },
  posts: {
    tournament: true,
    allowEmptyInput: true,
    maxTokens: 3000,
    temperature: 0.3,
    prompt: ({ input, context }) => postsPrompt(input, context),
    check: (json, { context }) => checked(() => checkPosts(json, { tokens: postTokens(context) })),
  },
  import: {
    tournament: true,
    maxTokens: 8000,
    temperature: 0,
    prompt: ({ input, context }) => importPrompt(input, context),
    check: (json, { context }) => checked(() => checkImport(json, { shape: shapeOf(context) })),
  },
}
