# Активные миграции

`20260906175207_current_model_baseline.sql` — состояние текущей модели после
шагов 1–9, только для новой БД. Создан командой `supabase migration new`.
Если уже существует tournaments или organizations, baseline отклоняется до DDL.
Не удалять эту защиту для обновления существующего проекта.

Forward-миграции после baseline (порядок и SHA-256 — в `../database-release.json`):

| Файл | Что делает |
|---|---|
| `20260908120000_mobile_tournament_details.sql` | Контакты организатора и публикация деталей |
| `20260917203207_registration_rules.sql` | Этап A: лимит участников (триггер на одобрении), дедлайн, взнос, `registration` в снимке, `approve_pending_entries` |
| `20260917204636_waitlist_status.sql` | Этап A+: значение enum `waitlisted` (отдельный файл: новое значение нельзя использовать в той же транзакции) |
| `20260917204637_waitlist.sql` | Этап A+: лист ожидания, `register_entry` возвращает jsonb |
| `20260917205649_manual_schedule.sql` | Этап B: `courts`, `match_schedule` (черновик/публикация), проверка конфликтов, публикация |
| `20260917211146_roles_and_visibility.sql` | Этап D: роль «только результаты», защита владельцев, `visibility` + триггер синхронизации `is_public` |
| `20260917212258_ownership_and_password.sql` | Этап D+: передача владения с журналом, режим «по паролю», токены доступа, снимок по токену |
| `20260918130934_schedule_queue_drag.sql` | Перетаскивание на доске кортов: атомарная перенумерация очереди корта |
| `20260919194603_page_password_readable.sql` | Код страницы по паролю хранится читаемым рядом с хешем (вне select-grant API) |
| `20260920171949_owner_only_tournament_delete.sql` | Удалять турнир может только владелец |
| `20260920185917_feature_flags.sql` | Флаги платформы (`feature_flags`), виды спорта `sport.<enum>`, запись только супер-админом |
| `20260921192934_entry_contact_split.sql` | Телефон и email заявки как отдельные колонки `entries.contact_phone`/`contact_email`, триггер заполнения, `register_entry` с `p_phone`/`p_email` |
| `20260921210903_tournament_venue.sql` | Адрес и координаты площадки: `tournaments.venue_address/venue_lat/venue_lng`, поля в `create_tournament`, в whitelist настроек и в снимке |
| `20260924210822_entry_seed_order.sql` | Ручной посев одобренных заявок до жеребьёвки (`set_entry_seed_order`) |
| `20260926085326_groups_rr_fixes.sql` | Исправления круговой системы и групп с плей-офф (QA, поток B) |
| `20260926085610_lifecycle_access_fixes.sql` | Исправления жизненного цикла, доступа и заявок (QA, поток C) |
| `20260926085932_bracket_fixes.sql` | Исправления сеток на выбывание: ручная жеребьёвка по посеву, BYE верхним посевам |
| `20260926123704_qa_round2_fixes.sql` | Исправления второго раунда QA: старт турнира, завершение, чемпион и др. |
| `20260926200333_participant_notifications.sql` | Письма участникам: очередь `notification_outbox`, триггеры на заявках, напоминания о матчах |
| `20260926203851_padel_formats_enum.sql` | Значения enum `americano`, `mexicano`, `team_americano`, `king_of_court` (отдельный файл) |
| `20260926203853_padel_points_formats.sql` | Падел-форматы на очки: партнёры в матче, генераторы, счёт до N, таблица очков, live-счётчик |
| `20260927095123_points_format_rules.sql` | Guard'ы форматов на очки и правила как у конкурентов: отдых ⌊N/2⌋, тай-брейки, жеребьёвка раунда 1, раунды King of the Court, полный цикл Americano |

Каждая forward-миграция переигрывается без изменения данных: тесты применяют
всю цепочку повторно (`reapplyForwardMigrations` в `tests/helpers/database.mjs`).

- `../schema.sql` — каноническое состояние, не процедура обновления.
- `../database-release.json` — SHA-256 baseline, исходника, 11 обновлений и forward-миграций,
  версии TENIS и история принятия baseline (`tenisHistory`).
- `../upgrades/` — полная цепочка обновления ревизии 2863c88 без изменения SQL.
- `../archive/organizations/` — несовместимая модель 202605 и её rollback.
- [Установка, выпуск и восстановление](../../docs/RELEASE.md).

TENIS принял baseline 27 сентября 2026: его журнал `supabase_migrations` совпадает с
этой папкой (baseline и все forward-миграции), `db push --dry-run` — «Remote database
is up to date». Новые миграции выпускаются в TENIS через `npx supabase db push --db-url`
после резервной копии и `--dry-run` — см. [руководство](../../docs/RELEASE.md) и
`tenisHistory` в `../database-release.json`.
