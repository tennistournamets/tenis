// AI tasks: prompt + answer check per feature. A task is
//   { tournament: boolean,                          // needs context.tournamentId (import, score, posts)
//     allowEmptyInput?: boolean,                    // the task works from context alone (posts)
//     maxTokens?, temperature?,
//     prompt({ input, context }) -> { system, user },
//     check(json, { input, context }) -> result }   // throws AiError('ai.badResponse') when unusable
// Keys match the feature switches (`ai.<task>`) and the task check in ai_begin_call().
// Each feature adds its task here.
import { checkImport } from '../src/lib/aiSchemas.js'
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
    `- "warnings": up to 5 short sentences about doubtful places, or []. Write them in ${language(context)}, whatever the language of the list.`,
  ].join('\n')
  // Repeated after the list: the model otherwise answers in the list's language.
  return { system, user: `Participant list:\n<<<\n${input}\n>>>\nWrite "warnings" in ${language(context)}, not in the language of the list.` }
}

export const TASKS = {
  import: {
    tournament: true,
    maxTokens: 8000,
    temperature: 0,
    prompt: ({ input, context }) => importPrompt(input, context),
    check: (json, { context }) => checked(() => checkImport(json, { shape: shapeOf(context) })),
  },
}
