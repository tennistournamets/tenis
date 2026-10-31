// The line under the knockout draw mode: seeds, BYEs and the lot.
export const drawSeedingMessages = {
  ru: {
    seeds: 'Сеяные ({count}):',
    byesSeeded: 'BYE: {byes}, все получат сеяные 1–{seeds}.',
    byesSeededLot: 'BYE: {byes}. Сеяные 1–{seeds} получат по BYE, ещё {lot} достанутся по жребию.',
    byesStrict: 'BYE: {byes}, их получат номера 1–{byes} по посеву. Жребия нет.',
    byesRandom: 'BYE: {byes}, достанутся случайным участникам.',
    unseeded: 'Остальные участники ({count}) расставляются жребием.',
    editSeeding: 'Изменить посев',
  },
  en: {
    seeds: 'Seeds ({count}):',
    byesSeeded: 'BYEs: {byes}, all go to seeds 1–{seeds}.',
    byesSeededLot: 'BYEs: {byes}. Seeds 1–{seeds} get one each, {lot} more are drawn by lot.',
    byesStrict: 'BYEs: {byes}, they go to seeds 1–{byes}. No lot.',
    byesRandom: 'BYEs: {byes}, they go to whoever the lot picks.',
    unseeded: 'The other entries ({count}) are drawn by lot.',
    editSeeding: 'Change seeding',
  },
  lt: {
    seeds: 'Skirstomieji ({count}):',
    byesSeeded: 'BYE: {byes}, visus gaus skirstomieji 1–{seeds}.',
    byesSeededLot: 'BYE: {byes}. Skirstomieji 1–{seeds} gaus po BYE, dar {lot} paskirstys burtai.',
    byesStrict: 'BYE: {byes}, juos gaus skirstymo numeriai 1–{byes}. Burtų nėra.',
    byesRandom: 'BYE: {byes}, juos gaus burtų išrinkti dalyviai.',
    unseeded: 'Kiti dalyviai ({count}) išdėstomi burtais.',
    editSeeding: 'Keisti skirstymą',
  },
}
