# Tenis Championship App

Vue 3 + Supabase: турниры по теннису, паделу и футболу.

## Возможности

- Главная страница `/` — только вход организатора (Google OAuth)
- Панель `/admin` → `/admin/tournaments`: вкладки «Турниры» и «Настройки», фильтр списка, отдельная страница создания, страница управления турниром; публичная **ссылка** для зрителей
- Публичная страница `/tournaments/:slug` — только по ссылке от организатора: вкладки «Регистрация» и «Сетка», без логина
- Создание турнира (`singles` / `doubles`)
- Роли:
  - `owner` / `editor`: управление своим турниром и результатами
  - `counter`: ведение LIVE-счёта в назначенном турнире
  - зритель: публичная страница и регистрация по ссылке без входа
- Саморегистрация участников с модерацией
- Форматы: single/double elimination, round robin и группы с плей-офф. Жеребьёвка:
  - авто-рандом
  - ручной порядок
- Авто-BYE до ближайшей степени 2
- Ведение счёта по сетам (`best_of_3` / `best_of_5`)
- Live-обновления сетки через Supabase Realtime
- Интерфейс: RU / EN / LT

## Стек

- Frontend: Vite, Vue 3, Vue Router, Pinia, Vue I18n
- Backend: Supabase (Postgres, Auth, Realtime, RLS)

## Запуск

1. Используйте Node из `.nvmrc` (24.20.0) и установите зафиксированные зависимости:

```bash
npm ci
```

2. Скопируйте `.env.example` в `.env` и заполните:

```bash
cp .env.example .env
```

3. Подготовьте новую БД или обновите существующую по [руководству выпуска](docs/RELEASE.md).
   В `supabase/migrations/` находится baseline только для новой БД; исходные
   обновления сохранены в `supabase/upgrades/`, модель организаций — в архиве.
   Не применять schema.sql повторно к рабочей БД. Настройте Google OAuth
   и Redirect URLs своего origin. Пароли и secret/service_role keys не помещать
   в переменные `VITE_`.

4. Запустите dev-сервер:

```bash
npm run dev
```

## Ключевые SQL-функции

- `register_entry(p_slug, p_entry_type, p_phone_or_email, p_member_one, p_member_two, p_display_name)`
- `generate_bracket(p_tournament_id, p_mode, p_manual_order)`
- `rebuild_bracket(p_tournament_id, p_mode, p_manual_order)`
- `update_match_sets(p_match_id, p_sets, p_expected_revision)`
- `get_tournament_sync_state(p_tournament_id)` — согласованный снимок с учётом RLS
- LIVE: start/point/undo/stop с ожидаемой версией; коррекции результатов с preview

## Проверки и выпуск

`npm run test:sql` запускает 189 проверок без сети и рабочего `.env`.
`TENIS_TEST_INSTALL_MODE=fresh` проверяет baseline, `upgrade` — полную цепочку.
`npm run test:postgres` проверяет отдельный локальный PostgreSQL и восстановление.
GitHub Actions выполняет три режима, сборку, audit и PostgreSQL/CLI-проверку.
Команды, ограничения и backup/restore: [RELEASE.md](docs/RELEASE.md).
Версии и достижимость advisory: [DEPENDENCIES.md](docs/DEPENDENCIES.md).
Архитектура чтения/форм, мобильные замеры и их ограничения: [PERFORMANCE.md](docs/PERFORMANCE.md).

## Структура

- `src/views/HomeView.vue` — страница входа организатора
- `src/views/PublicTournamentView.vue` — публичная страница турнира (по ссылке)
- `src/views/AdminLayout.vue` — каркас админки (вкладки, кнопка «Создать турнир»)
- `src/views/AdminTournamentListView.vue` — список турниров с фильтром
- `src/views/AdminTournamentCreateView.vue` — форма создания турнира
- `src/views/AdminSettingsView.vue` — настройки (язык, аккаунт)
- `src/views/AdminTournamentView.vue` — заявки, сетка, счёт, админы, ссылка для зрителей
- `supabase/schema.sql` — схема БД, RLS, функции
