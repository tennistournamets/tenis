// Counted nouns by Intl.PluralRules category (ru: one/few/many, lt: one/few/other, en: one/other).
// Used through src/lib/plural.js; `{n}` is the number.
export const pluralMessages = {
  ru: {
    participants: { one: '{n} участник', few: '{n} участника', many: '{n} участников', other: '{n} участника' },
    matches: { one: '{n} матч', few: '{n} матча', many: '{n} матчей', other: '{n} матча' },
    rounds: { one: '{n} раунд', few: '{n} раунда', many: '{n} раундов', other: '{n} раунда' },
    groups: { one: '{n} группа', few: '{n} группы', many: '{n} групп', other: '{n} группы' },
    byes: { one: '{n} проходит первый раунд без игры', few: '{n} проходят первый раунд без игры', many: '{n} проходят первый раунд без игры', other: '{n} проходят первый раунд без игры' },
  },
  en: {
    participants: { one: '{n} entry', other: '{n} entries' },
    matches: { one: '{n} match', other: '{n} matches' },
    rounds: { one: '{n} round', other: '{n} rounds' },
    groups: { one: '{n} group', other: '{n} groups' },
    byes: { one: '{n} bye in round one', other: '{n} byes in round one' },
  },
  lt: {
    participants: { one: '{n} dalyvis', few: '{n} dalyviai', many: '{n} dalyvio', other: '{n} dalyvių' },
    matches: { one: '{n} rungtynės', few: '{n} rungtynės', many: '{n} rungtynių', other: '{n} rungtynių' },
    rounds: { one: '{n} raundas', few: '{n} raundai', many: '{n} raundo', other: '{n} raundų' },
    groups: { one: '{n} grupė', few: '{n} grupės', many: '{n} grupės', other: '{n} grupių' },
    byes: { one: '{n} praeina pirmą raundą be žaidimo', few: '{n} praeina pirmą raundą be žaidimo', many: '{n} praeina pirmą raundą be žaidimo', other: '{n} praeina pirmą raundą be žaidimo' },
  },
}
