# Конкуренты: как продукты решают 5 вопросов по Americano / Mexicano / Team Americano / King of the Court

Исследование: 2026-09-27. Дополняет `docs/PADEL_RULES_RESEARCH.md` (разделы 1, 3.3–3.5, 4.2–4.6, 6.1). Там собраны
правила из всех источников, включая блоги. Здесь считаются **только продукты** (приложения и платформы) и то, как
они ведут себя на самом деле.

## Методика

- Сильнее всего засчитываются данные, где видно реальное поведение продукта:
  - 20 публичных турниров Americano Padel (Perkodar) разобраны скриптом: сыгранные матчи, колонка бонуса, порядок строк;
  - формы создания турнира в Padelution открыты в браузере;
  - справка Playtomic Manager прочитана через Zendesk API;
  - справки PadelCup, Ligaspel, Padel Fast, PadelOS и Reclub прочитаны напрямую.
- Слабее засчитываются описания в App Store: это заявления разработчика, логику по ним не проверить. Такие продукты
  отмечены **[AS]**.
- Руководства на сайте самого продукта (например, `americano-padel.app/en/blog/…`) засчитаны как описание продукта.
  Они помечены **[гайд]**, потому что это может быть совет, а не логика приложения.
- **Не засчитаны:**
  - наш PR (github.com/tennistournamets/tenis) и блог bracketa;
  - сторонние блоги;
  - PR `evhg/padel-matchup` на GitHub (его текст поиск приписывал Reclub);
  - хобби-проекты с открытым кодом — они упомянуты отдельно.
- Общий порядок: вопрос → таблица «продукт → что делает → доказательство» → подсчёт → рекомендация и как это
  делает Playtomic.

---

## 1. Продукты

### Уровень A: крупные или документированные продукты (поведение подтверждено)

| # | Продукт | Страна | Источник доказательств |
|---|---|---|---|
| A1 | **Playtomic Manager** | ES | https://helpmanager.playtomic.com/hc/en-gb/articles/44129657203985 (через `/api/v2/help_center/en-gb/articles/44129657203985.json`, обновлено 2026-09-15) |
| A2 | **Americano Padel** (Perkodar AB, «Originalet») | SE | https://americano-padel.com/ , App Store id1536633475, **20 публичных турниров** `americano-padel.com/r/<id>` (список ниже) |
| A3 | **PadelCup.se** | SE | https://www.padelcup.se/cup_americano.php , /cup_mexicano.php , /cup_mexicano_med_udda_antal.php , /vinnarbana_americano.php , /faq.php |
| A4 | **Ligaspel.se** | SE | https://docs.ligaspel.se/administrator/quickstart-guide/americano |
| A5 | **Padel Fast** (GAVA Group) | SE | https://www.padelfast.com/guides/creating-a-tournament , /guides/running-a-tournament , /formats/mexicano , /formats/winnerslane , App Store id1607589873 |
| A6 | **Padelution** (Padelution Oy; сайт работает и с локацией «Lithuania») | FI/LT | https://www.padelution.com/americano/americano и /americano/mexicano (формы открыты в браузере; «375 Americanos created in the last 24 hours») |
| A7 | **PadelMix** (RSApps Nordics OÜ) | EE | https://padelmix.app/how-to-organize-americano-padel-tournament [гайд], /mexicano-padel, App Store id6505054587 |
| A8 | **Americano Padel Manager** (americano-padel.app) | FR | https://americano-padel.app/en/ (FAQ), /en/blog/… [гайд], App Store id6747935961 |
| A9 | **americanopadel.app** (генератор) | — | https://americanopadel.app/ (раздел «M+ points») |
| A10 | **PadelMake** (Kansu Labs, есть приложение) | — | https://www.padelmake.com/padel-classic-americano , /padel-classic-mexicano [гайд], App Store id6759991321 |
| A11 | **Padel Clash** (инструменты) | FR | https://www.padel-clash.fr/en/tools/generateur-americano-padel , /en/tools/montante-descendante-padel |
| A12 | **PadelOS** | — | https://support.padelos.co/en/articles/11018524-tournament-americano |
| A13 | **Reclub** (частично) | SG/VN | https://help.reclub.co/hc/reclub-help/articles/1769552961-match-generator , /1765846345-change-the-order-of-tiebreakers-in-tournament |

### Уровень B: небольшие приложения [AS] (только описание в App Store)

- Rallyo (id6756277672)
- Americano: Padel & Pickleball, Onat Cipli (id6790185591)
- Padel Tournament, Adam McLean (id6786222387)
- PadelSwap (id6784726004)
- Padel Rondas (id6809469287)
- Padelino (id6766866882)
- SKORSETS (id6777351195)
- Ronda (id6801933811)
- Padel Social (id6788789939)
- Padero (id6793126709)
- Loop Padel (id6754602480)
- PadelZone (id6748815530)
- Start Padel (id6787149320)
- Padel Americano & Mexicano, Maxim Solovev (id6755082870)

Ссылки имеют вид `https://apps.apple.com/app/id<ID>`.

### Проверены, но доказательств по нашим вопросам нет

- **Tournify:** Americano не поддерживается. В их FAQ сказано: «Americano formats are not supported at this time»
  (https://help.tournifyapp.com/en/articles/8970419-faq-format).
- **Padelboard by MATCHi:** правила публично не описаны (https://padelboard.app/about).
- **Padel Mates, Nettla, Court22, MATCHi (бронирование), Kourts, Padel Rank:** функции Americano/Mexicano публично
  не описаны.
- **Pistas365:** только страницы с правилами, инструмента нет.
- Балтийские игроки: из местных нашлись только **Padelution** (FI, выбор локации Lithuania) и **PadelMix** (EE).
  Литовских продуктов с этими форматами не найдено.

### Открытый код (не засчитан, для справки)

- `ptzimmerman/Padel-Americano`: «Sorted by total points → match wins → point differential», раунды добавляются
  кнопкой «+».
- `VytautasP/padel-tournament-hub`: рейтинг по очкам за сыгранный матч; «Ties break by total points and then by a
  head-to-head mini-league … declared joint position»; число раундов не фиксировано.

### Разобранные публичные турниры Perkodar (A2)

| Турнир | Формат | Игроки/корты | N | Что показывает |
|---|---|---|---|---|
| [15/2 elgen](https://americano-padel.com/r/3157A9E7-A501-4EB8-ADE5-AC5F42EBF9C716) | Americano | 6 / 1 | 21 | 7 раундов; у кого 4 матча вместо 5, стоит **(+10)** |
| [WAKEY WAKEY … MEXICANO](https://americano-padel.com/r/29A6FF76-F011-405D-98DC-3C745031DD1E3) | Mexicano | 15 / 2 | 21 | у кого 5 матчей вместо 6, стоит **(+10)** |
| [Monday Gancho Royal Padel Mexicano](https://americano-padel.com/r/A14BAE77-EB7E-45C0-AF59-D49C5FF828FC16) | Mexicano | 12 / 2 | 5 | **(+2)** = floor(5/2); 9-й раунд создан, но не сыгран; тай-брейк «победы до разницы» |
| [Mixicano](https://www.americano-padel.com/r/A795119A-266C-4C73-8C5E-55186FBC17B88) | Mixicano | 12 / 2 | 16 | **(+8)** |
| [Americano Damas C](https://americano-padel.com/r/a26705f3-dfa4-48ea-b634-de40cf0a56fd34) | Americano | 8 / 1 | 24 | 14 раундов (полный цикл партнёров); после 5 раундов у кого 2 матча вместо 3, стоит **(+12)**, хотя реальные суммы матчей 21–28 |
| [APT FIX MIX MEXICANO](https://www.americano-padel.com/r/00B07423-6BB3-496F-B4CD-38F8AA2B62CC3) | Mexicano | 14 / 4 | 21 | **(+10)** |
| [Gruppe A](https://americano-padel.com/r/4ddffb51-4358-4d50-947c-1bea778e817b17) | Team | 11 пар | 16 | **(+8)** у пар с 9 матчами вместо 10 |
| [26.03](https://americano-padel.com/r/fd5287cc-2a93-46b5-9a2b-dca01147070956) | Americano | 8 / 2 | 8–11 | тай-брейк «ничьи до разницы» |
| [De 5 jugadores](https://americano-padel.com/r/12299166-5da6-4c03-91f6-3820d910b28e3?ln=es) | Americano | 5 / 1 | 5 | 5 раундов, каждый отдыхает 1 раз, бонуса нет; полное равенство показано как «3.» и «4.» |
| [9 jugadores](https://americano-padel.com/r/ebdc4873-ba59-467f-a2f7-885c2cf15fcc83?ln=es), [10 jugadores](https://americano-padel.com/r/ebdc4873-ba59-467f-a2f7-885c2cf15fcc82?ln=es), [2 pistas 13 jugadores](https://americano-padel.com/r/439f1eab-547b-4b38-ab4f-edc871edd7956?ln=es) | Americano | 9/1, 10/1, 13/2 | — | 18, 22 и 19 раундов = ⌊n(n−1)/2 ÷ (2·корты)⌋, то есть полный цикл партнёров |
| [Mexicano](https://americano-padel.com/r/572C134C-98BC-40B7-BE6D-EDB6A7EB87ED15), [Mexicano tirsdag](https://americano-padel.com/r/e3554086-f69f-4b65-8034-9afc34e953d628), [Team Mexicano](https://americano-padel.com/r/83726564-4681-4DBC-8F7B-3C19A9D53F2584), [Couples Team Americano](https://americano-padel.com/r/B65BCE9C-B7A8-411F-820B-41805D53E42D10), [Adict](https://americano-padel.com/r/00B0E917-63CE-4E5A-9B26-01CB7317155119), [Mix Mexicano](https://www.americano-padel.com/r/69495198-0A76-498E-8C5F-955902DD023E77) | разные | — | — | порядок строк при равных очках (см. Q3) |

---

## Q1. Компенсация отдыха (Americano/Mexicano при составе не кратном 4 или нехватке кортов)

| Продукт | Что делает | Доказательство |
|---|---|---|
| A1 Playtomic | Компенсация **автоматическая**, отключить нельзя, формула не опубликована | «Resting players automatically receive compensation points… This is intended behavior and can't currently be disabled. If you'd rather have actual wins carry more weight… prioritize victories» |
| A2 Perkodar | **(b) фиксированно ⌊N/2⌋ за каждый матч, которого не хватает до максимума сыгранных.** Целое число с округлением вниз (21→10, 5→2). Показано **отдельной колонкой «(+ x)»** рядом с итогом. Пересчитывается по ходу турнира. Настройки не видно | Турниры выше: (+10) при N=21, (+2) при N=5, (+8) при N=16, (+12) при N=24, хотя фактические суммы 21–28. Колонки таблицы: «W-L-T \| Diff \| (+ x) \| P» |
| A3 PadelCup | **(e) без компенсации, равное число матчей.** Americano доступен только для 4, 5, 8, 9, 12, 16, 20, 24 и спецверсий 6, 7, 10 с равными матчами. В Mexicano есть таблица «сколько раундов нужно, чтобы у всех было поровну матчей». Для жеребьёвки используется скрытый рейтинг с учётом числа матчей | «Antalet spelare måste vara delbart med fyra för att skapa ett matematiskt rättvist schema. Undantagen är 5 och 9»; «Vid 6 och 7 spelare får varje spelare spela 4 matcher»; «Dold ranking som tar hänsyn till antal spelade matcher»; «Klas och Olle har rasat i tabellen då de bara har spelat en match» |
| A4 Ligaspel | **(e) равное число матчей** при любом составе | «Vilket antal spelare man än väljer så får varje spelare spela lika många matcher» |
| A5 Padel Fast | **(d) настраиваемо:** организатор включает отдых и сам задаёт очки | «Enable resting to let players sit out a round, and choose how many points a resting player is awarded» |
| A6 Padelution | Настройки компенсации в форме нет. Число матчей выравнивается, где это возможно (6 игроков / 1 корт → по 4 матча), иначе разброс ±1 (11 / 2 → 9–10) | Форма создания Americano (наблюдение в браузере) |
| A7 PadelMix | **(b) среднее раунда** | «Bye system: Player sitting out receives the average score from that round» [гайд]; в описании приложения: «compensation for players sitting out» |
| A8 Americano Padel Manager | **(b) среднее раунда** | «The resting player receives the average points of the round so they're not penalised» [гайд] |
| A9 americanopadel.app | **(b) «M+» = среднее очков в пропущенном матче**, отдельная колонка M+, выравнивание до максимума матчей | «if 4 out of 6 players played 5 matches and the remaining 2 players played 4, those 2 players would be granted the average number of points scored in the match that they missed as extra M+ points» |
| A10 PadelMake | **(b) среднее всех остальных в раунде.** Для Mexicano компенсация влияет на следующую жеребьёвку | «Players who sit out typically receive the average score of all other players that round» [гайд] |
| A11 Padel Clash | Отдыхающие перечислены в листе, компенсация не упоминается | «In each round one or more players rest (listed under "Rest" on the sheet)» |
| B Rallyo [AS] | (d) опция | «Sit-out compensation — award points to players waiting between rounds» |
| B Onat Cipli [AS] | Автоматически, формула не указана | «Sit-outs rotate and are compensated automatically» |
| B Adam McLean [AS] | Автоматически, формула не указана | «automatically tracks and rewards balanced bye-round points fairly» |
| B PadelSwap, Padel Rondas, Padelino, Padero, Ronda [AS] | Упоминают только равномерный отдых, про очки ничего | «Resting players are rotated fairly…», «Whoever has rested least plays next» |

**Подсчёт (15 продуктов с данными):**

- (b) N/2 или «среднее раунда» — **5**: Perkodar, PadelMix, Americano Padel Manager, americanopadel.app, PadelMake.
  Сюда же Playtomic: компенсация автоматическая, формула не раскрыта.
- (d) настраиваемые фиксированные очки — **2**: Padel Fast, Rallyo.
- (e) без компенсации, равное число матчей — **2–3**: PadelCup, Ligaspel, частично Padelution.
- Автоматически, формула неизвестна — **3**: Playtomic, Onat, Adam McLean.
- (c) собственное среднее за сыгранный матч — **0 продуктов.** Встречается только в блоге Host A Tourney, и там для
  другого случая («ghost player … average of their previous rounds»).

**Детали:**

- **Округление.** Единственный продукт, где его видно, — Perkodar: целое число, вниз (⌊21/2⌋ = 10, ⌊5/2⌋ = 2).
  Дробей (.5) нигде не показывают.
- **Отдых до первого сыгранного матча.** При N/2 проблемы нет, поэтому продукты этот случай не описывают. У Perkodar
  бонус считается по ходу турнира и зависит от разницы с максимумом сыгранных.
- **Отдельная колонка.** Есть у Perkodar («(+ x)») и americanopadel.app («M+»). У остальных не видно.
- **Переключатель.** У Playtomic нельзя отключить, у Padel Fast и Rallyo — настройка, у Perkodar переключателя нет.
- **Mexicano.** Компенсация входит в очки, по которым строится следующий раунд (PadelMake, таблица Perkodar).
  PadelCup вместо этого нормирует скрытый рейтинг на число матчей.

**Рекомендация (самая частая практика):**

- Компенсация **N/2 за каждый отдых**, целым числом с округлением вниз при нечётном N.
- Начисляется автоматически и показывается отдельной колонкой или пометкой «+x за отдых».
- Включена по умолчанию. Переключатель необязателен: у лидера (Playtomic) его нет.
- Текущее правило спеки «своё среднее за матч» не использует ни один продукт. Кроме того, у него нет ответа на
  отдых до первого матча.

**Как у Playtomic:** автоматически и без отключения. Альтернатива — настройка «победы важнее очков».

---

## Q2. Раунд 1 в Mexicano и King of the Court

| Продукт | Формат | Что делает | Доказательство |
|---|---|---|---|
| A1 Playtomic | Mexicano, KotC | **Выбор организатора из 3 вариантов.** Значение по умолчанию в справке не указано | «Strongest players in initial courts / Evenly matched teams / Random allocation. This matters most for King of the Court and Mexicano» |
| A3 PadelCup | Mexicano | **По порядку ввода игроков**; при нечётном составе последние в списке отдыхают | «Första omgången bestäms av ordningen som spelarna anges» |
| A3 PadelCup | Vinnarbana (KotC) | **Случайно** | «Spelarna lottas i spelomgång 1 och det är slumpen som avgör tilldelning av bana, med- och motspelare» |
| A5 Padel Fast | Mexicano, Winner's Lane | Описание формата: **жеребьёвка**. App Store: **посев по рейтингу** | «A draw — the opening lottery — decides who you play with and against»; «Rating-based seeding builds fairer, closer first rounds in Mexicano, Mixicano, Beat the Box and Winner's Lane» |
| A7 PadelMix | Mexicano | **Случайно** | «The tournament begins with randomly assigned matchups» |
| A8 Americano Padel Manager | Mexicano | **Случайно** | «the teams and matchups for the first round are drawn at random» [гайд] |
| A10 PadelMake | Mexicano | **Выбор: случайно или по посеву** | «round one pairings are either random or seeded» [гайд] |
| A11 Padel Clash | King of the Hill | **Случайно** | «randomly placed across courts in round 1» |
| A6 Padelution | Mexicano | Настройки раунда 1 в форме нет | форма создания |
| B Padelino [AS] | Mexicano | **Случайно** | «Mexicano — round 1 is random; after that, top players face top players» |
| B Padel Social [AS] | все | Ручная настройка первого раунда | «Custom first-round pairings» |

**Подсчёт (10 продуктов с данными):**

- Случайно по умолчанию или единственный вариант — **6**: PadelMix, Americano Padel Manager, Padelino, PadelCup
  (KotC), Padel Clash (KotC), Padel Fast (по описанию формата).
- Выбор организатора — **3**: Playtomic, PadelMake, Padel Social.
- По порядку или рейтингу — **2**: PadelCup Mexicano (порядок ввода), Padel Fast (рейтинг, если он есть).

**Рекомендация:**

- **По умолчанию — случайная жеребьёвка** для Mexicano и KotC.
- Опционально — «по посеву». Посев у нас уже есть, так что это совпадает с вариантом Playtomic «сильнейшие на
  первых кортах».
- Посев по умолчанию не используется ни в одном продукте.

**Как у Playtomic:** организатор выбирает один из трёх вариантов (сильные на первых кортах / ровные пары / случайно).

---

## Q3. Тай-брейки после суммы очков

| Продукт | Порядок после очков | Равные места | Правило видно игрокам? | Доказательство |
|---|---|---|---|---|
| A1 Playtomic | По умолчанию только очки. Опция «приоритет побед» (победы выше очков) | не указано | Выбирается при создании | «By default, leaderboards prioritize accumulated points over wins. For Americano and Mexicano, you can choose to prioritize wins instead» |
| A2 Perkodar (по данным турниров) | **победы → ничьи (меньше поражений) → разница** | **Нет**: полное равенство получает соседние номера (3., 4.) | Колонки W-L-T и Diff видны, правило не написано | Monday Gancho: David Gun 3-3-0, −4 выше Robert 2-3-0, −3 при 13 очках → победы раньше разницы. 26.03: 2-1-1, +3 выше 2-2-0, +5 при 21 очке → ничьи раньше разницы. Mexicano: 7-4-1 выше 5-7-0 при 152. De 5 jugadores: одинаковые 1-3-0, −4, 8 очков показаны как «3.» и «4.» |
| A3 PadelCup | **победы → ничьи** (Mexicano и Americano одинаково; Team Americano — те же колонки) | не указано | Написано в справке | «först efter poäng, i andra hand efter Vunna matcher, i tredje hand efter Oavgjorda matcher» |
| A5 Padel Fast | **победы → ничьи → разница** (так описана таблица лиг; для одиночного турнира не описано) | не указано | Написано в справке | «equal rows are separated by wins, then draws, then score difference» (guides/league-leaderboard) |
| A8 Americano Padel Manager | **победы → ничьи → число матчей → разница** (второй гайд: победы → ничьи → golden point) | не указано | Советуют объявить заранее | «the number of wins, then draws. If still tied: the number of matches played, then the points differential» [гайд] |
| A9 americanopadel.app | «иногда» победы; разница показана колонкой | — | — | «sometimes the number of wins … can be taken into account» |
| A10 PadelMake | Americano: победы → лучший матч → личная встреча. Mexicano: победы → разница → личная встреча | — | — | [гайд] |
| A7 PadelMix | Личная встреча, разница или матч-плей-офф — решить заранее | — | — | «Decide your tiebreaker method before the tournament starts» [гайд] |
| A13 Reclub | Порядок тай-брейков настраивает организатор (для соревнований): победы, личная встреча, геймы, разница | — | Организатор задаёт | help.reclub.co, статья о порядке тай-брейков |
| B Rallyo [AS] | Выбор: очки, процент побед или разница | — | — | «rank by total points, win rate, or point difference» |
| B PadelSwap, Padel Rondas, Padelino, SKORSETS [AS] | Показывают колонки очков, побед/ничьих/поражений и разницы, порядок не указан | — | — | описания в App Store |

**Подсчёт:**

- Первый критерий после очков — **победы**: Perkodar, PadelCup, Padel Fast, Americano Padel Manager, PadelMake,
  americanopadel.app, плюс опция Playtomic — **6–7**. Личная встреча первой: PadelMix (одна из опций) — 1.
  Разница первой: нет ни одного продукта (у Rallyo это одна из опций).
- Второй критерий — **ничьи**: Perkodar, PadelCup, Padel Fast, Americano Padel Manager — **4**. Разница: PadelMake
  (Mexicano) — 1.
- Третий — **разница**: Perkodar, Padel Fast, Americano Padel Manager.
- Личная встреча в индивидуальных форматах — редкость (PadelMake на 3-м месте, PadelMix как опция, Reclub как опция).
- **Равные места:** ни один продукт не показывает общее место. У Perkodar при полном равенстве идут соседние номера.
- **Правило для игроков:** явно написано только в справках PadelCup и Padel Fast (для лиг). Playtomic и Reclub дают
  выбор организатору.
- **Team Americano:** у Perkodar и PadelCup то же правило, что в индивидуальном формате (Couples Team Americano:
  5-1-2 выше 4-0-4 при 76 очках, то есть по победам).

**Рекомендация:**

- Порядок: **очки (с компенсацией) → победы → ничьи → разница очков**. Одинаково для Americano, Mexicano и Team
  Americano.
- Что делать при полном равенстве, продукты не описывают. Самое частое — соседние номера в произвольном порядке.
  Предлагаю показывать **общее место** ради прозрачности. Это осознанное отступление от «самого частого»,
  уверенность низкая.
- Опция Playtomic «победы важнее очков» — по желанию. Её нет ни у кого, кроме Playtomic.

**Как у Playtomic:** только очки по умолчанию, опционально победы выше очков. Порядок тай-брейков не публикуется.

---

## Q4. Число раундов в Mexicano и King of the Court

| Продукт | Формат | Раунды | Завершение | Доказательство |
|---|---|---|---|---|
| A1 Playtomic | все три | **Фиксированы при создании** | **Вручную**: «Mark the competition as finished» | «The tournament continues for as many rounds as you configure»; «Final summary when you mark the competition as finished» |
| A2 Perkodar | Mexicano | **Без ограничения**: следующий раунд создаётся после ввода результатов | вручную | Monday Gancho — 9-й раунд создан, сыграно 8; Mixicano — создано 15, сыграно 14; APT — 12 и 11 |
| A3 PadelCup | Mexicano | **Без ограничения**, кнопка «Ny spelomgång». Для нечётных составов есть таблица числа раундов, дающих равное число матчей | вручную | «När alla matcher är färdigspelade, så klicka på knappen Ny spelomgång» |
| A3 PadelCup | Vinnarbana (KotC) | **Решить до старта**, но программа не ограничивает. Минимум зависит от числа кортов: 2 корта → 3–4, 3 → 5, 4 → 6, 5 → 7, 6 → 8 | по последнему раунду | «Bestäm antal omgångar innan turneringen startar. (Programmet har inga begränsningar...)» |
| A5 Padel Fast | Mexicano | Кнопка «Continue» создаёт следующий раунд. Есть длительность турнира (60–240 мин) | **Вручную**: «Finish» | «a Continue button generates the next round using the current standings»; «Finish becomes available once all rounds are complete» |
| A5 Padel Fast | Winner's Lane (KotC) | **Фиксированы до старта** | — | «The number of rounds is decided before play begins» |
| A6 Padelution | Mexicano | **Без ограничения** | — | «Play as many rounds as you wish» (форма) |
| A11 Padel Clash | King of the Hill | Организатор выбирает, рекомендация **5–10** | по корту 1 в последнем раунде | «between 5 and 10 rounds» |
| A13 Reclub | Mexicano | Можно задать число раундов; есть «continuous play» | — | «Set the number of Rounds and Courts»; «hosts no longer have to wait for all matches to finish» |
| B PadelSwap [AS] | Mexicano | **Фиксированы** | **Автоматически** | «Set how many rounds to play»; «A champion is crowned automatically when the last round is done» |
| B Padel Rondas [AS] | Mexicano, Winners Court | **Без ограничения** | — | «for as many rounds as you like» |
| B Loop Padel [AS] | все | Можно добавлять раунды | — | «Add another round to your tournament» |
| B PadelZone [AS] | все | Задаются в настройках | — | «full control … number of courts, points per match, and rounds» |
| B SKORSETS, Maxim Solovev [AS] | все | **По времени** (раунды под длительность брони) | — | «Tell SKORSETS how long you have on court…»; «Always finish on time» |

**Подсчёт:**

- **Mexicano:**
  - без ограничения, с кнопкой «следующий раунд» — **6**: Perkodar, PadelCup, Padelution, Padel Fast, Padel Rondas,
    Loop Padel;
  - фиксированы при создании — **3**: Playtomic, PadelSwap, PadelZone;
  - по времени — **2**: SKORSETS, Maxim Solovev;
  - Reclub — гибрид.
- **KotC:** фиксированы или «решить до старта» — **4 из 4** (Playtomic, Padel Fast, PadelCup, Padel Clash). Причина:
  победитель — пара на корте 1 **в последнем раунде**, поэтому последний раунд должен быть известен.
- **Завершение:** вручную — **3** (Playtomic, Padel Fast, по факту Perkodar); автоматически — **1** (PadelSwap).
- **«Раунд X из Y»:** явных упоминаний не найдено (Padel Social пишет «Round progress»).
- **Типичное число раундов:**
  - Padel Clash — 5–10;
  - PadelMake — 5, на выходных 7 [гайд];
  - Americano Padel Manager — 6–8 [гайд];
  - PadelCup (KotC) — число кортов + 2…3.

**Рекомендация:**

- **Mexicano** — открытое число раундов: кнопка «следующий раунд» плюс ручное «Завершить турнир». Если хотим
  показывать «раунд X из Y», пусть плановое число будет необязательной подсказкой (по умолчанию 6), которую можно
  превысить.
- **KotC** — число раундов **задаётся при создании** (по умолчанию: корты + 3, минимум 5). Показывать «раунд X из Y».
  Итог по последнему раунду считается автоматически, но статус «завершён» ставит организатор (как у Playtomic и
  Padel Fast).

**Как у Playtomic:** число раундов задаётся при создании для всех трёх форматов, завершение вручную.

---

## Q5. Americano, когда не все играют каждый раунд

| Продукт | Как строится расписание | Формулировка для пользователя | Доказательство |
|---|---|---|---|
| A2 Perkodar | **Полный цикл партнёров**: ⌊n(n−1)/2 ÷ (2·корты)⌋ раундов (6/1 → 7, 9/1 → 18, 10/1 → 22, 13/2 → 19, 8/1 → 14, 8/2 → 7). Число матчей может различаться — это закрывает компенсация (Q1) | «The tournament is finished when everyone has played with everyone»; «Everyone plays with everyone (as much as possible)»; «For odd numbers, Americano works best up to around 9 players» | публичные турниры, главная, App Store |
| A6 Padelution | **Около полного цикла**, раунды считаются автоматически; где возможно — равное число матчей (5/1 → 5 матчей по 4; 6/1 → 6 по 4; 10/2 → 20 по 8), иначе ±1 (7/1 → 10 матчей по 5–6; 11/2 → 27 по 9–10). Число раундов не выбирается | «Every player plays with all other participants across the rounds» | форма (наблюдение) |
| A3 PadelCup | **Полный цикл Wh(v)** только для 4, 5, 8, 9, 12, 16, 20, 24. Спецверсии 6, 7, 10 — равное число матчей (4, 4, 6). Для 11 расписания нет | «Varje spelare möter varje motspelare i två olika matcher»; «Varför finns det inget spelschema för 11 spelare?» | faq, cup_americano |
| A4 Ligaspel | **Равное число матчей** при любом составе; для 4x и 4x+1 — полный цикл | «spelar med alla andra spelare exakt 1 gång, och mot alla andra spelare exakt 2 gånger … För övriga antalet spelare … antal matcher är lika för alla» | docs |
| A5 Padel Fast | Полный цикл, фиксированное расписание | «Everyone plays with and against everyone»; «Americano — everyone plays with everyone once» | guides, App Store |
| A12 PadelOS | Полный цикл | «The competition concludes after everyone has had the opportunity to play with everyone else» | help |
| A9 americanopadel.app | Полный цикл, при неравенстве M+ | «Everyone plays with and against everyone, and every player has the same number of matches» | главная |
| A1 Playtomic | **Число раундов задаёт организатор** | «rotates partners and opponents so everyone mixes»; «continues for as many rounds as you configure» | help |
| A8 Americano Padel Manager | Рекомендованное число меньше полного цикла: 8 → 7, 12 → 8, 16 → 8, 20 → 8 | «don't play all possible rounds. 7 to 10 rounds are enough»; в App Store: «Partners and opponents rotate so everyone plays everyone» | [гайд], App Store |
| A10 PadelMake | Организатор выбирает, 5–7 раундов | — | [гайд] |
| A11 Padel Clash | Организатор выбирает, **рекомендация 6** («about 6 matches per player») | «Recommended: 6 rounds» | tool |
| A7 PadelMix | В гайде: 8 → 7 (полный цикл), 16 → 8 (неполный) | «7 rounds for complete rotation» | [гайд] |
| B Adam McLean, Start Padel, PadelSwap [AS] | Организатор задаёт число раундов | «requested rounds», «Choose courts, rounds…», «Set how many rounds» | App Store |
| B Ronda [AS] | Без повторов партнёров, пока это возможно; дальше ограничивает число раундов | «nobody is handed the same partner twice while a fair schedule still exists» | App Store |

**Подсчёт:**

- **Полный цикл «каждый с каждым», раунды считаются автоматически** — **7**: Perkodar, Padelution, PadelCup,
  Ligaspel, Padel Fast, PadelOS, americanopadel.app. Это большинство среди продуктов уровня A.
- **Число раундов выбирает организатор** — **4 уровня A** (Playtomic, Americano Padel Manager, PadelMake, Padel Clash)
  и **3 уровня B**.
- При отдыхах внутри «полного цикла» есть два подхода:
  - Perkodar и americanopadel.app: полный цикл партнёров, разница в матчах закрывается компенсацией;
  - PadelCup, Ligaspel, Padelution: равное число матчей, если возможно.
- **Формулировка:** почти везде «everyone plays with everyone». У Perkodar и americanopadel.app оговорка «as much as
  possible» / «ideally».
- **Число раундов по умолчанию:** для 4k — n−1 (8 → 7, 12 → 11, 16 → 15). Для неровных составов:
  - у Perkodar ⌊n(n−1)/4c⌋;
  - у Ligaspel 4x+1, 4x+2, 4x+3.

**Рекомендация:**

- **По умолчанию — полный цикл партнёров** («каждый сыграет в паре с каждым»). Там, где это невозможно без
  неравенства, писать «насколько возможно» и компенсировать недостающие матчи по Q1 (как Perkodar).
- Для больших составов (12+ игроков, где 11+ раундов — 2,5+ часа) дать организатору сократить число раундов или
  завершить раньше. Так делают Playtomic, Padel Clash и Americano Padel Manager.

**Как у Playtomic:** число раундов задаёт организатор, формулировка «so everyone mixes».

---

## Дополнительно замеченная практика

- **Компенсация влияет на жеребьёвку Mexicano:** PadelMake прямо это указывает, у Perkodar бонус входит в очки
  таблицы. Альтернатива PadelCup — скрытый рейтинг с учётом числа матчей.
- **Кто отдыхает:** равномерно, «кто отдыхал меньше, тот играет» (Perkodar, Padel Rondas, Padero, Padelino). PadelCup
  в Mexicano после раунда 1 выбирает отдыхающих жребием.
- **Поздние игроки и снятия** поддерживают многие: Padel Fast («Late participation»), Padelino, Ronda, Vamos, Padero.
  Для нас это отдельная тема.
- **Playtomic пока не показывает игрокам таблицу в приложении**, только сообщения в чате турнира («players don't yet
  see live matchups or leaderboards directly in the Playtomic app»). Живая публичная таблица есть у Perkodar, PadelMix,
  Padel Fast, PadelCup и Americano Padel Manager.

---

## Итог: 5 рекомендаций

| # | Вопрос | Рекомендация (самая частая практика) | Подсчёт | Playtomic | Уверенность |
|---|---|---|---|---|---|
| Q1 | Компенсация отдыха | Автоматически **N/2 за каждый отдых** («среднее раунда»), целым числом с округлением вниз, отдельной пометкой «+x». Включена по умолчанию, переключатель необязателен. От «своего среднего» отказаться | (b) 5 (+ Playtomic авто); (d) 2; (e) 2–3; (c) 0 | авто, не отключается, формула скрыта | **Высокая** (что не «своё среднее»); средняя (округление вниз: видно только у Perkodar) |
| Q2 | Раунд 1 Mexicano/KotC | **Случайно по умолчанию**, опция «по посеву» | random 6; выбор 3; порядок/рейтинг 2 | выбор из 3 вариантов | **Высокая** |
| Q3 | Тай-брейки | **Очки → победы → ничьи → разница**, одинаково во всех форматах. При полном равенстве — общее место (наш выбор; продукты просто нумеруют подряд) | победы первыми 6–7; ничьи вторыми 4 | очки; опция «победы выше очков» | **Средняя** (порядок); **низкая** (общее место) |
| Q4 | Число раундов | **Mexicano: открыто** («следующий раунд» + ручное «Завершить»), плановое число — необязательная подсказка (6). **KotC: задаётся при создании** (корты + 3, минимум 5), «раунд X из Y», статус «завершён» ставит организатор | Mexicano: открыто 6, фикс. 3, время 2; KotC: фикс. 4/4; финиш вручную 3, авто 1 | фикс. при создании, финиш вручную | **Средняя** |
| Q5 | Americano с отдыхами | **Полный цикл партнёров по умолчанию** («каждый с каждым, насколько возможно»), неравенство матчей закрывать компенсацией из Q1; организатор может сократить или завершить раньше | полный цикл 7 (уровень A); выбор организатора 4 A + 3 B | выбор организатора | **Средняя** |
