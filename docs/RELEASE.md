# Установка, выпуск и восстановление Tenis

Проверено 6 сентября 2026: Node **24.20.0**, PostgreSQL **17**, Supabase CLI
**2.116.0**. Используйте `nvm install && nvm use`, затем `npm ci`.
Версии зависимостей фиксированы в package.json и package-lock.json (lockfile v3).

## Файлы выпуска

| Путь | Назначение |
|---|---|
| `supabase/migrations/` | Baseline новой БД и будущие миграции |
| `supabase/schema.sql` | Каноническое состояние; не процедура обновления |
| `supabase/upgrades/pre-stabilization.sql` | Исходная схема ревизии 2863c88 для тестирования upgrade |
| `supabase/upgrades/202609*.sql` | Все 11 обновлений шагов 1–8 без изменения SQL |
| `supabase/database-release.json` | Порядок, SHA-256 файлов, серверные версии TENIS |
| `supabase/archive/organizations/` | Несовместимые миграции 202605 и rollback |

Baseline отказывается работать поверх существующей таблицы tournaments или
organizations. Повторное применение schema.sql или старых патчей не является
откатом: оно может вернуть прежние RPC и права. Архив организаций не применять.

## Новая БД и фронтенд

1. `npm ci`. Для локального Supabase нужен Docker: `npx supabase start`, затем
   `npx supabase db reset --local`. Seed выключен, реальные участники не загружаются.
   Никогда не выполнять `db reset --linked` на рабочем проекте.
2. Для нового hosted-проекта сначала явно привязать нужный проект:
   `npx supabase link --project-ref <NEW_PROJECT_REF>`. Проверить
   `npx supabase migration list --linked` и
   `npx supabase db push --linked --dry-run --skip-vault`.
   В пустом проекте должен планироваться только baseline; затем применить
   `npx supabase db push --linked --skip-vault`. Старый `.temp` не доказывает,
   что выбран нужный проект; служебные файлы CLI не переносить между средами.
3. Настроить Google OAuth, Site URL и Redirect URLs для нужного origin в Auth.
   Эти настройки и провайдерные секреты не входят в SQL.
4. Скопировать `.env.example` в `.env`: клиенту нужны только URL и
   publishable/anon key. Пароль БД, service_role/secret keys не должны иметь
   префикс `VITE_`: они предназначены для закрытого окружения администратора.
   Сборка отклоняет такие имена переменных и не печатает их значения.
5. `npm run build`. Публиковать `dist/` с SPA fallback на index.html;
   `vercel.json` содержит rewrite текущего хостинга. Проверить публичную ссылку,
   Google-вход, роли, регистрацию, ручной/LIVE-счёт и обновление зрителя.

`tests/helpers/supabase-bootstrap.sql` — тестовый shim Auth/ролей/Realtime,
не выполнять его в managed Supabase. В шаге 10 проверена установка через CLI
на локальном PostgreSQL с shim; полный стек Supabase отдельно не запускался.

## Обновление текущей модели

Перед DDL нужны проверенная резервная копия и установленная исходная версия.
Ревизия 2863c88 поддерживается всей цепочкой manifest. Для промежуточного
состояния применяются только недостающие патчи после подтверждённого шага.
Историческую модель организаций этот путь не конвертирует.

1. Сверить фактические функции/ACL и журнал `supabase_migrations.schema_migrations`.
   В TENIS шаг 1а применялся без записи в журнале; остальные локальные даты
   отличаются от серверных. Соответствие сохранено в manifest. Одного имени
   миграции недостаточно для определения состояния.
2. Сначала выполнить недостающую цепочку на копии. Каждый патч атомарен.
   Не выполнять `pre-stabilization.sql` в существующей БД.
3. Сравнить каталог и данные, проверить роли и RPC. Каталог проверяется через
   `tests/helpers/catalog.sql`: функции, ACL, колонки, ограничения, индексы,
   политики, триггеры и публикация. Старые SQL-проверки с хешами описывают
   исторические выпуски, а не определения всех текущих RPC.
4. Применить только проверенные недостающие патчи в выбранную среду и записать
   фактические версии. Выпускать фронтенд после требуемых RPC. Клиент до шага 5
   не умеет передавать ожидаемые версии счёта; для него нельзя откатывать
   серверную защиту. При возврате клиента выбрать совместимую сборку и
   перезагрузить старые вкладки.

### Принятие baseline существующим TENIS

На 6 сентября 2026 TENIS имеет актуальную модель и 23 прежние записи журнала.
Рабочие таблицы и журнал в шаге 10 не менялись. Baseline SQL там выполнять
не требуется. Переход к обычному `db push` требует отдельного выпуска метаданных
истории после сравнения живой схемы с baseline и резервной копии.

Экспортировать `supabase_migrations.schema_migrations`, фактическую схему и
перечень версий. Только после подтверждённого совпадения выполнить
`npx supabase migration repair --status reverted <OLD_VERSIONS> --linked`
для проверенного перечня, затем
`npx supabase migration repair --status applied 20260906175207 --linked`.
Repair меняет журнал, а не применяет DDL. Не использовать его, чтобы скрыть
несовпадение схемы. Исторический журнал хранить вместе с резервной копией.

После этого `migration list --linked` должен показывать baseline с обеих
сторон, а `db push --linked --dry-run --skip-vault` — отсутствие неожиданных
изменений. До принятия baseline новые изменения TENIS применяются точечно,
как в шагах 1–8. Автоматического развёртывания БД в CI нет.

Новые миграции создавать `npx supabase migration new <name>`, затем обновлять
schema.sql и `forwardMigrations` в manifest. Выпущенный baseline и исторические
патчи остаются неизменными. Проверки должны проходить для fresh и upgrade.

## Резервная копия и восстановление

Для согласованной копии использовать транзакционный/платформенный backup либо
приостановить запись на время копирования. Проверять фактическую дату и
успешность последней копии, а не только наличие расписания.
Для логического переноса Supabase описывает отдельные роли, схему и данные:
[официальная процедура backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore).

Сохранить вне репозитория, с ограниченным доступом:

- `npx supabase db dump --linked --role-only -f roles.sql`;
- `npx supabase db dump --linked -f schema.sql`;
- `npx supabase db dump --linked --data-only --use-copy -f data.sql`;
- отдельный экспорт `supabase_migrations.schema_migrations`;
- настройки Auth, Redirect URLs, провайдеров, Realtime и frontend environment;
- идентификатор проекта, время, версии клиента/БД и контрольные суммы файлов.

CLI исключает управляемые схемы и некоторые объекты. Логическая копия сама по
себе не означает полного восстановления проекта и Auth-сессий. Проверить,
какие Auth-данные включает выбранный способ. Для полного аварийного
восстановления использовать платформенный backup/PITR по официальной процедуре.
Объекты Storage, если появятся, потребуют отдельной копии.

Сначала восстановить в отдельный проект/БД: роли → схема → данные с
`ON_ERROR_STOP`, по инструкции для выбранного способа копирования. Не применять
baseline поверх восстановленной схемы. Проверить данные, роли, публичную
приватность, LIVE, места, затем Auth/Realtime и браузерные ссылки; только после
этого переключать приложение. Ключи и настройки нового проекта сверить отдельно.

`npm run test:postgres` создаёт три собственные БД на loopback, выполняет
upgrade заполненной схемы, сравнивает все исходные значения, делает настоящий
`pg_dump -Fc` / `pg_restore` и проверяет восстановленные RPC. Тестовые БД
удаляются в finally. Это проверка SQL-приложения, не hosted Auth/PITR.

## Проверки выпуска и CI

```sh
npm ci
npm run test:sql
TENIS_TEST_INSTALL_MODE=fresh npm run test:sql
TENIS_TEST_INSTALL_MODE=upgrade npm run test:sql
npm run build
npm audit --audit-level=moderate
npm audit --omit=dev
```

Для локального PostgreSQL 17 задать PGHOST=127.0.0.1, PGPORT, PGUSER, PGPASSWORD
и запустить `npm run test:postgres`. `TENIS_TEST_CLI=1` добавляет применение
baseline через Supabase CLI и повторный запуск. В CI psql/pg_dump/pg_restore
берутся из того же контейнера через `TENIS_PG_CONTAINER`; PostgreSQL-клиент
не зависит от версии пакетов Ubuntu runner.

`.github/workflows/ci.yml` на push/PR запускает три режима SQL, чистую сборку,
audit с отказом от moderate и выше, PostgreSQL fresh/upgrade/restore и CLI.
Actions и образ PostgreSQL фиксированы SHA/digest; рабочие секреты и deploy
отсутствуют. После публикации workflow проверить результаты GitHub и сделать
jobs обязательными в branch protection выбранного репозитория.

Локально: **172/172** в каждом режиме, чистый `npm ci` и build на Node 24.20.0.
Аудит зависимостей: [DEPENDENCIES.md](DEPENDENCIES.md).
Основание порядка миграций и принятия истории:
[Supabase Database Migrations](https://supabase.com/docs/guides/deployment/database-migrations).
