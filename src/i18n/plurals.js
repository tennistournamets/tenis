// Counted nouns by Intl.PluralRules category (ru: one/few/many, lt: one/few/other, en: one/other, lv: zero/one/other).
// Used through src/lib/plural.js; `{n}` is the number.
export const pluralMessages = {
  ru: {
    tournaments: { one: '{n} турнир', few: '{n} турнира', many: '{n} турниров', other: '{n} турнира' },
    participants: { one: '{n} участник', few: '{n} участника', many: '{n} участников', other: '{n} участника' },
    matches: { one: '{n} матч', few: '{n} матча', many: '{n} матчей', other: '{n} матча' },
    rounds: { one: '{n} раунд', few: '{n} раунда', many: '{n} раундов', other: '{n} раунда' },
    groups: { one: '{n} группа', few: '{n} группы', many: '{n} групп', other: '{n} группы' },
    byes: { one: '{n} проходит первый раунд без игры', few: '{n} проходят первый раунд без игры', many: '{n} проходят первый раунд без игры', other: '{n} проходят первый раунд без игры' },
  },
  en: {
    tournaments: { one: '{n} tournament', other: '{n} tournaments' },
    participants: { one: '{n} entry', other: '{n} entries' },
    matches: { one: '{n} match', other: '{n} matches' },
    rounds: { one: '{n} round', other: '{n} rounds' },
    groups: { one: '{n} group', other: '{n} groups' },
    byes: { one: '{n} bye in round one', other: '{n} byes in round one' },
  },
  lt: {
    tournaments: { one: '{n} turnyras', few: '{n} turnyrai', many: '{n} turnyro', other: '{n} turnyrų' },
    participants: { one: '{n} dalyvis', few: '{n} dalyviai', many: '{n} dalyvio', other: '{n} dalyvių' },
    matches: { one: '{n} mačas', few: '{n} mačai', many: '{n} mačo', other: '{n} mačų' },
    rounds: { one: '{n} raundas', few: '{n} raundai', many: '{n} raundo', other: '{n} raundų' },
    groups: { one: '{n} grupė', few: '{n} grupės', many: '{n} grupės', other: '{n} grupių' },
    byes: { one: '{n} dalyvis praeina pirmą raundą be žaidimo', few: '{n} dalyviai praeina pirmą raundą be žaidimo', many: '{n} dalyvio praeina pirmą raundą be žaidimo', other: '{n} dalyvių praeina pirmą raundą be žaidimo' },
  },
  lv: {
    tournaments: { zero: '{n} turnīru', one: '{n} turnīrs', other: '{n} turnīri' },
    participants: { zero: '{n} dalībnieku', one: '{n} dalībnieks', other: '{n} dalībnieki' },
    matches: { zero: '{n} maču', one: '{n} mačs', other: '{n} mači' },
    rounds: { zero: '{n} kārtu', one: '{n} kārta', other: '{n} kārtas' },
    groups: { zero: '{n} grupu', one: '{n} grupa', other: '{n} grupas' },
    byes: { zero: '{n} dalībnieku iekļūst otrajā kārtā bez spēles', one: '{n} dalībnieks iekļūst otrajā kārtā bez spēles', other: '{n} dalībnieki iekļūst otrajā kārtā bez spēles' },
  },
}
