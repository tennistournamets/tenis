**Исследование проекта Tenis — 5 сентября 2026**

Ревизия: `2863c88` («Adaptive 3D scene quality + tennis tournament settings»). Общая инженерная оценка: **5/10**. Проект имеет хороший функциональный охват для MVP, однако ошибки в правах, сетках и сохранении результатов существенно ограничивают готовность к ответственным соревнованиям. Рекомендую сохранить текущий стек и провести этап стабилизации ядра.

Оценка экспертная, основана на текущем коде и перечисленных ниже проверках. Это не процент исправного кода, не оценка автора и не результат нагрузочного теста.

**Объём и границы исследования**

Изучены архитектура Vue, маршрутизация и авторизация, основные представления и редакторы, Realtime, спортивные модули, каноническая SQL-схема, зависимости, сборка и документация. Проверки фронтенда, SQL и спортивной логики дополнительно рассмотрены независимо.

Исходники приложения и рабочая БД не изменялись. Выполнена production-сборка в игнорируемый `dist/`; добавлен этот отчёт. Проверка SQL статическая; реальная PostgreSQL/Supabase не запускалась. Действующие production grants, политики, данные, резервные копии и настройки API не проверены. Проверки JS исполнялись локально с тестовыми состояниями; браузерные E2E, OAuth и реальные Realtime-соединения не проверялись. Выводы о доступе относятся к схеме из репозитория и оговаривают зависимость от deployed grants.

**Что представляет собой проект**

SPA на Vue 3, JavaScript, Pinia, Vue Router, Vue I18n и Vite. Supabase обеспечивает PostgreSQL, Auth и Realtime. Основная бизнес-логика выполняется в PL/pgSQL через RPC. Есть теннис, падел и футбол; single elimination, round robin, groups + playoff и double elimination; заявки, роли организаторов/счётчиков, публичные страницы, QR-ссылки и live-счёт. Визуализация включает опциональную 3D-сцену.

Центральная идея модели — общий результат в `matches`, а подробности теннисных сетов отдельно в `match_sets`. По этому агрегату рассчитываются таблицы и продвижение. Идея удачная, но live-путь пока не соблюдает её полностью.

| Показатель | Факт |
|---|---|
| Исходники `src/` | 55 файлов, 17 451 строка, включая CSS, шаблоны и переводы |
| Каноническая схема | 3 472 строки; 12 определений таблиц; 38 функций |
| Привилегированные SQL-функции | 32 объявления `SECURITY DEFINER` |
| Главный экран администратора | 2 549 строк |
| Глобальные стили | 3 480 строк |
| Публичный экран турнира | 814 строк |
| Локализация | RU / EN / LT, по 542 конечных ключа; пропусков относительно RU нет |
| Скрипты проекта | Только `dev`, `build`, `preview` |
| Автоматические проверки в репозитории | Тесты приложения, lint/typecheck-конфигурации и CI workflow не обнаружены |

**Оценки по направлениям**

| Направление | Оценка | Обоснование |
|---|---:|---|
| Функциональный охват MVP | 7/10 | Содержательные пользовательские сценарии и несколько форматов соревнований |
| Архитектура | 6/10 | Разумный стек, RPC и реестры спортов; размыты границы загрузки, UI и черновиков |
| Поддерживаемость | 5/10 | Небольшие полезные модули соседствуют с крупными компонентами и повторяющимися запросами |
| Корректность турнирной логики | 4/10 | Ошибки BYE, live-агрегатов, коррекции зависимых результатов и валидации |
| Контроль доступа по схеме | 3/10 | Есть RLS и проверки ролей, но привилегированные обходные пути и открытые контакты |
| Автоматизация качества | 2/10 | Сборка работает; регрессии доменной логики не защищены автоматическими проверками |
| Производительность по коду/сборке | 6/10 | Lazy loading, адаптация 3D; реальные задержки и пределы нагрузки не измерены |
| Документация и воспроизводимость | 5/10 | Подробный CLAUDE.md; устаревший README и отсутствующая актуальная цепочка миграций |

**Что сделано хорошо**

- Реестры [src/lib/sportConfig.js](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/lib/sportConfig.js>) и [src/lib/scoringEngines.js](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/lib/scoringEngines.js>) задают возможности спорта и выбор редакторов. Это хорошая основа для расширения.
- Турнирные операции собраны в транзакционные RPC; есть внешние ключи, enum/проверки статусов, уникальность матчей и активных регистраций.
- `record_point` блокирует live-запись через `FOR UPDATE` и проверяет ожидаемую `revision`: [supabase/schema.sql:3148](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:3148>). Быстрые нажатия на клиенте сериализуются: [src/components/LiveScoringModal.vue:152](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/components/LiveScoringModal.vue:152>).
- Маршруты загружаются лениво. Для 3D предусмотрены отдельные chunks, 2D fallback, учёт reduced-motion и качества сети: [src/components/LiveScoreViewerModal.vue:11](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/components/LiveScoreViewerModal.vue:11>). При скрытии вкладки рендер приостанавливается, при размонтировании освобождаются ресурсы.
- Публичная загрузка использует версию запроса для защиты от устаревших ответов при смене турнира.
- Переводы синхронизированы по ключам. Историческое замечание CLAUDE.md о неполном LT нельзя считать подтверждённым текущим дефектом.
- Ограничения double elimination и части playoff описаны явно. Их следует сохранять видимыми в продукте до реализации.

**Приоритетные проблемы**

Приоритет P1 означает «исправить до расширения реального использования»: возможны нарушение доступа, неверный результат или невозможность закончить турнир. P2 — существенный дефект рабочего сценария. Приоритеты не являются CVSS.

**1. P1 — пересоздание чужой сетки через привилегированный RPC**

`generate_single_elim` и `generate_double_elim` имеют `SECURITY DEFINER`, удаляют существующие матчи и не проверяют право пользователя на турнир. При этом выполнение явно выдано роли `authenticated`.

Доказательства: [supabase/schema.sql:1216](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1216>), начало удаления [supabase/schema.sql:1254](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1254>), grant [supabase/schema.sql:1488](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1488>), второй генератор [supabase/schema.sql:1500](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1500>) и его grant [supabase/schema.sql:1654](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1654>).

Сценарий по канонической схеме: зарегистрированный пользователь, не являющийся организатором турнира, вызывает генератор с UUID этого турнира и его участников. Авторизация внешнего `generate_bracket` не защищает отдельно доступный helper.

Дополнительно `propagate_winner`, `clear_downstream` и `generate_round_robin_matches` тоже привилегированные и не проверяют вызывающего пользователя. В схеме отсутствует отзыв их выполнения. По умолчанию функции доступны всем ролям; этот дополнительный путь зависит от действующих grants. См. [официальные правила привилегий функций Supabase](https://supabase.com/docs/guides/database/functions#function-privileges).

Решение: закрыть внешний доступ к helpers, вынести их в неэкспонируемую схему; у публичных RPC проверять права и принадлежность всех переданных сущностей турниру. Проверить отдельно anon, постороннего пользователя, counter, editor и owner.

**2. P1 — контакты регистраций доступны публичной политике**

Политика чтения `entries` разрешает все регистрации публичного турнира, включая pending/rejected: [supabase/schema.sql:3348](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:3348>). В той же таблице находится `phone_or_email`: [supabase/schema.sql:121](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:121>). Ограничений колонок в канонической схеме нет.

Публичный Vue-компонент выбирает ограниченный набор полей, но пользователь может сформировать другой API-запрос. При обычном SELECT-доступе к таблице схема позволяет получить контактные данные. RLS управляет строками, а не скрытием отдельных столбцов — это [прямо описано в документации Supabase](https://supabase.com/docs/guides/database/postgres/column-level-security).

Решение: хранить контакты в отдельной закрытой таблице либо предоставить безопасный публичный RPC с отзывом прямого чтения исходных данных. Отдельно определить, какие статусы заявок видны зрителям. Фактическая доступность production-контактов не проверялась.

**3. P1 — сетка с 5–6 участниками не приходит к финалу**

Основной `generate_bracket` заполняет слоты подряд, а BYE обрабатывает только в первом раунде: [supabase/schema.sql:776](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:776>). Продвижение победителя не умеет продолжить проход через пустую ветку: [supabase/schema.sql:337](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:337>).

Пример пяти участников: первый раунд содержит пары `[1,2], [3,4], [5,пусто], [пусто,пусто]`. Пятый участник проходит в полуфинал, но его соперник никогда не появляется. Полуфинал остаётся pending; ввести результат при пустой стороне запрещено.

Проверка Python-моделью исходного алгоритма для 2–16 участников: чемпион определяется для 2, 3, 4, 7, 8, 15, 16; финал остаётся pending для 5, 6 и 9–14. Это моделирование, а не выполнение SQL. Пользовательский путь действительно вызывает этот генератор: [src/views/AdminTournamentView.vue:1061](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/AdminTournamentView.vue:1061>). В helper для playoff повторяется тот же подход.

Решение: корректно распределять BYE по дереву посева либо рекурсивно разрешать пустые ветви с различением «ожидаем победителя» и «участника не будет». Автоматически проверять все размеры 2–64.

**4. P1 — live-финиш не сохраняет итоговый агрегированный счёт**

При завершении live-матча обновляются только `winner_entry_id` и `status`: [supabase/schema.sql:3220](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:3220>). `sync_live_match_sets` пишет подробности сетов, но не `matches.side_a_score/side_b_score`: [supabase/schema.sql:2988](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:2988>). `get_standings` читает именно агрегат и заменяет NULL на 0: [supabase/schema.sql:1032](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1032>).

Поэтому live-победа 2:1 учитывается как победа, но статистика сетов становится 0:0 или остаётся прежней. Это влияет на разницу и распределение мест в round robin/groups.

Решение: единая атомарная операция записи/финализации результата для ручного и live-ввода. Инвариант: агрегат соответствует завершённым сетам, победитель соответствует агрегату.

**5. P1 — исправление результата повреждает нижнюю ветку double elimination**

`clear_downstream` следует только по маршруту победителя: [supabase/schema.sql:373](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:373>). Маршрут проигравшего не очищается. Затем `propagate_winner` заменяет участника нижнего матча, сохраняя уже завершённый результат: [supabase/schema.sql:317](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:317>).

Пример: A проиграл B сверху, затем A выиграл матч снизу. Организатор исправляет верхний результат в пользу A. Теперь снизу вместо A стоит B, но старым победителем нижнего матча всё ещё может оставаться A.

Решение: обходить оба направления зависимости и полностью инвалидировать устаревшие результаты, сеты, пенальти и live-сессии. Альтернатива для первого этапа — явно запрещать коррекцию, когда зависимые матчи уже начались, и предоставлять контролируемую процедуру отката.

**6. P1 — ручной и live-ввод могут противоречить друг другу**

Ручной `update_match_sets` не останавливает активный live; `record_point` при существующей live-записи проверяет её статус, но не запрещает продолжение после ручного завершения `matches`: [supabase/schema.sql:1924](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1924>), [supabase/schema.sql:3126](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:3126>), [supabase/schema.sql:3194](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:3194>).

Пример: live находится в первом сете; организатор вручную сохраняет 6:0, 6:0 и продвигает победителя. Счётчик продолжает прежнюю сессию. Синхронизация live перезаписывает наборы сетов, хотя матч уже помечен завершённым с ручным результатом.

Решение: явный переход между режимами записи, общая версия результата и блокировка на уровне матча. Одних disabled-кнопок на клиенте недостаточно для нескольких устройств.

**7. P2 — сервер принимает незавершённые сеты как выигранные**

Ручное сохранение считает выигранным любой сет, в котором число A больше B: [supabase/schema.sql:1983](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:1983>). Таблица проверяет только диапазон 0–7. Два сета 1:0 завершают best-of-3 и продвигают игрока. Также не проверяются допустимая последовательность и лишние сеты после достижения победы.

Решение: серверный валидатор с учётом scoring_config и вида спорта. Промежуточный счёт можно сохранять, но он не должен автоматически становиться выигранным сетом. Проверять нормальные завершения, тайбрейки, решающий сет и прекращение матча после необходимого числа побед.

**8. P2 — Realtime стирает несохранённый ввод**

В `ScoreEditor` deep-watch всех матчей/сетов пересоздаёт все формы: [src/components/ScoreEditor.vue:69](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/components/ScoreEditor.vue:69>). Локальное выполнение реального Vue setup подтвердило: введённые 6:4 в M1 исчезают после изменения сетов другого M2.

Похожая проблема в настройках турнира: новая заявка запускает общую перезагрузку, а `loadTournament` безусловно переписывает черновик формы: [src/views/AdminTournamentView.vue:352](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/AdminTournamentView.vue:352>), подписки [src/views/AdminTournamentView.vue:577](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/AdminTournamentView.vue:577>).

Решение: отделить серверное состояние от локального черновика; обновлять только затронутые сущности; сохранять dirty-формы и явно обрабатывать конфликт изменений.

**9. P2 — публичная таблица мест устаревает после Realtime-результата**

Обработчик обновляет `matches`, но не пересчитывает `standings/groupStandings`: [src/views/PublicTournamentView.vue:484](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/PublicTournamentView.vue:484>). Таблицы загружаются при полной загрузке: [src/views/PublicTournamentView.vue:295](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/PublicTournamentView.vue:295>). Аналогичный риск есть у групповой таблицы второго организатора.

Локальный вызов исходного обработчика с тестовым состоянием подтверждает: матч finished, но played/points в standings не меняются. Это отдельная проблема от отсутствующего live-агрегата: она сохраняется и для корректного ручного результата.

Решение: после изменения результата обновлять таблицу затронутой группы/турнира с объединением частых запросов; выполнять полную синхронизацию после восстановления соединения.

**Дополнительные находки**

| Приоритет | Наблюдение и последствие | Место / действие |
|---|---|---|
| P1/P2, зависит от grants | В канонической схеме для `players` нет включения RLS; таблица содержит пользовательские данные. Фактическое содержимое и права production неизвестны | [supabase/schema.sql:64](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/schema.sql:64>). Ограничить доступ к своей записи или убрать неиспользуемую exposed-модель |
| P2 | SELECT live-записей не включает `sides_swapped/sides_auto`; после загрузки стороны отображаются с defaults | [src/views/AdminTournamentView.vue:443](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/AdminTournamentView.vue:443>), [src/views/PublicTournamentView.vue:359](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/PublicTournamentView.vue:359>). Общая проекция данных |
| P2 | Пустые футбольные поля становятся 0 из-за `Number('')`; сохранение в группе/RR засчитывает ничью 0:0 | [src/components/FootballScoreEditor.vue:45](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/components/FootballScoreEditor.vue:45>), [src/components/MatchScoreModal.vue:74](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/components/MatchScoreModal.vue:74>). Проверять заполненность до преобразования |
| P2 | DELETE с `old:{id}` отбрасывается до удаления из локального массива: ожидается `old.tournament_id` | [src/views/PublicTournamentView.vue:484](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/PublicTournamentView.vue:484>). Локальная имитация подтверждена; реальные события требуют проверки на Supabase |
| P2 | После успешной регистрации родитель включает loading и размонтирует форму вместе с её successText | [src/components/RegistrationForm.vue:88](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/components/RegistrationForm.vue:88>), [src/views/PublicTournamentView.vue:659](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/PublicTournamentView.vue:659>). Сохранить результат в родителе или обновлять данные без размонтирования |
| P2 | Переключатель языка закрывается при blur, выбор реализован только через mousedown | [src/components/LanguageSwitcher.vue:43](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/components/LanguageSwitcher.vue:43>). Native select или корректные click/focus/keyboard handlers |
| P3 | Финальный сет в live-строке дублируется: `6:3 · 6:4 · 6:4` | [src/lib/useTennisScoring.js:69](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/lib/useTennisScoring.js:69>). При winner не добавлять текущие games после sets |
| P3 | Сообщение «скопировано» появляется и при ошибке Clipboard API | [src/views/AdminTournamentListView.vue:140](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/AdminTournamentListView.vue:140>), [src/lib/shareLink.js:13](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/lib/shareLink.js:13>). Показывать реальный статус и ручное копирование |

При исправлении DELETE нужно учитывать состав old-записи и ограничения RLS/подписок, а не только добавить REPLICA IDENTITY FULL. Поведение и ограничения описаны в [документации Postgres Changes](https://supabase.com/docs/guides/realtime/postgres-changes). Сетевой сценарий сброса/пересоздания сетки необходимо проверить отдельно.

**Поддерживаемость и архитектурные советы**

Главный долг — концентрация транспорта, прав, Realtime, черновиков, заявок, пар, сетки и UI в [src/views/AdminTournamentView.vue](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/src/views/AdminTournamentView.vue>). Размер 2 549 строк сам по себе не доказывает низкое качество, но здесь смешение обязанностей уже связано с потерей ввода и повторяющимися проекциями данных.

Предлагаемое разделение в рамках текущего приложения:

- слой доступа к турнирам/матчам с общими SELECT-проекциями, обработкой ошибок и документированными RPC-контрактами;
- общий composable загрузки/Realtime турнира с точечным обновлением данных, версиями запросов и reconnect-синхронизацией;
- отдельные компоненты заявок, настроек и результатов, каждый со своим draft-state;
- единый доменный контракт результата на сервере и единый валидатор перед его сохранением;
- SQL-функции сгруппировать логически по доступу, регистрации, генерации и подсчёту; изменения доставлять последовательными миграциями.

Типизация полезна прежде всего на границе Supabase и в модели результата: поля live-сессии, sport/format, статусы и аргументы RPC. Начать можно с JSDoc/checkJs либо постепенно включать TypeScript. Типы не заменят проверку спортивных правил и прав доступа.

Ошибки запросов следует отличать от пустого результата. Сейчас несколько загрузчиков игнорируют `error` и подставляют `[]`, что может выглядеть как отсутствие ролей/данных. Нужны понятные состояния загрузки, ошибки и повторного запроса, а также сбор клиентских ошибок с контекстом турнира и RPC без контактных данных.

**Сборка, зависимости и производительность**

`npm run build` завершился успешно: 217 модулей. Есть предупреждение Vite о chunk больше 500 kB. Основной JS — 444,35 kB / 138,40 kB gzip; самый крупный `player` chunk — 587,07 kB / 148,08 kB gzip. Модель персонажа — 2 266 136 байт, около 2,27 MB.

3D загружается отдельно, поэтому некорректно приписывать весь этот объём первой загрузке каждого экрана. В коде уже есть разумная адаптация. Следующие решения по размеру bundle следует принимать после измерения загрузки публичной страницы и live-модалки на мобильном устройстве. Данных для оценки числа одновременных зрителей или допустимого размера турнира нет.

`npm audit --omit=dev --json` на дату проверки сообщил **3 зависимости с максимальной severity high**: `nanoid 3.3.11`, `postcss 8.5.8`, `ws 8.20.0`. Для всех npm указал наличие исправления. Дерево подтверждено через `npm ls`: postcss/nanoid приходят через Vue compiler/Vite, ws — через Supabase Realtime.

Это результат проверки dependency graph, а не доказательство трёх эксплуатируемых дыр в опубликованном браузерном приложении. Часть кода относится к сборке/Node и может отсутствовать в итоговом bundle. Рекомендация: обновить совместимые версии, проверить достижимость уязвимого кода и повторить проверки; не применять принудительное обновление major-версий без проверки изменений.

В БД есть полезные индексы по турниру и статусу. Потенциальные места для измерений: повторные `get_standings`, полная JSON-история каждого live-очка, массовое удаление/перегенерация сетки и авторизационные проверки Realtime. Добавлять индексы и кеширование стоит по EXPLAIN и измерениям, поскольку часть существующих индексов уже дублирует уникальные ограничения.

**Документация и выпуск изменений**

README описывает преимущественно старое теннисное приложение; CLAUDE.md точнее отражает нынешнюю структуру. Исторические migrations помечены как неприменимые. Текущая схема ориентирована на fresh database, а полноценной цепочки обновлений существующей БД нет: [supabase/migrations/README.md](</Users/dmitrijpanasiuk/Library/Mobile Documents/com~apple~CloudDocs/Projects/Tenis/supabase/migrations/README.md>).

`CREATE TABLE IF NOT EXISTS` не обновляет уже существующие определения колонок и ограничений. Поэтому повторное применение большой схемы нельзя считать гарантированным процессом обновления.

Нужны актуальный baseline, новая последовательная история миграций, проверка чистой установки и обновления, инструкция по восстановлению данных и конфигурации окружения. Исторические SQL лучше вынести из активного migration-каталога в архив после проверки процесса доставки. В репозитории также отслеживаются `supabase/.temp` и дубли локальных agent-skills/pycache: это небольшой долг гигиены, не главный риск продукта.

**Рекомендуемый порядок работы**

| Этап | Что сделать | Проверяемый результат |
|---|---|---|
| 1. Закрыть нарушения доступа | Helpers/RPC, публичные контакты, RLS players, проверка фактических production grants | Посторонний пользователь и anon не меняют турнир и не читают закрытые поля |
| 2. Стабилизировать результат соревнования | BYE, единая финализация, manual/live-переходы, валидация сетов, обе ветки double elimination | Турнир завершается на допустимом числе участников; разные способы ввода дают один результат |
| 3. Защитить ежедневную работу | Draft-state, актуальные standings, DELETE/reconnect, сохранение ориентации, подтверждение регистрации | Работа второго устройства и обновления не стирают ввод и не оставляют устаревшую сетку |
| 4. Обеспечить безопасное развитие | Минимальный CI, тестовая БД, актуальные миграции, постепенное разделение компонентов, обновление зависимостей | Изменения воспроизводимо собираются и проходят доменные/авторизационные проверки |

Минимальный набор проверок, который даст наибольшую отдачу:

- матрица доступа anon / посторонний / counter / editor / owner для публичных RPC и чтения данных;
- генерация и завершение single elimination для каждого размера 2–64, плюс запрет/обработка неподдерживаемых размеров double elimination;
- одинаковый итог после ручного и live-ввода; невозможные, промежуточные и лишние сеты;
- исправление победителя с уже сыгранными зависимыми матчами в обеих ветках;
- два редактора одновременно, конфликт revision, ручное завершение активного live-матча;
- Realtime другого матча при несохранённом вводе, DELETE, reconnect и пересоздание сетки;
- публичная регистрация с устойчивым подтверждением успеха и актуальная таблица мест.

Для этого подходят небольшие JS-тесты, интеграционные SQL-тесты на изолированном Supabase/PostgreSQL и несколько браузерных сценариев. Целевой процент покрытия менее полезен, чем защита перечисленных инвариантов.

После стабилизации продукту больше всего помогут управление ходом соревнования: расписание/корты, переносы и снятие участников, история исправлений, печать/экспорт и понятные состояния для зрителей. Эти приоритеты следуют из текущих пробелов кода; рыночное исследование и интервью организаторов в этот обзор не входили.

**Материалы локальных воспроизведений**

Временные материалы находятся в `/private/tmp` и не входят в тестовую инфраструктуру проекта:

- [BYE-модель](/private/tmp/tenis-audit-bye-check.py), [вывод](/private/tmp/tenis-audit-bye-check.txt).
- [JS/Vue-проверки счёта](/private/tmp/tenis-audit-scoring-checks.mjs), [вывод](/private/tmp/tenis-audit-scoring-checks.txt).
- [Проверки Realtime-обработчика и i18n](/private/tmp/tenis-audit-realtime-check.mjs), [вывод](/private/tmp/tenis-audit-realtime-check.txt).

Проверки фиксируют конкретные дефекты текущей ревизии. Они не являются полноценным тестированием системы и не подтверждают работоспособность развёрнутой среды.
