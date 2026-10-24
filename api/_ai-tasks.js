// AI tasks: prompt + answer check per feature. A task is
//   { tournament: boolean,                          // needs context.tournamentId (import, score, posts)
//     allowEmptyInput?: boolean,                    // the task works from context alone (posts)
//     maxTokens?, temperature?,
//     prompt({ input, context }) -> { system, user },
//     check(json, { input, context }) -> result }   // throws AiError('ai.badResponse') when unusable
// Keys match the feature switches (`ai.<task>`) and the task check in ai_begin_call().
// Each feature adds its task here.
export const TASKS = {}
