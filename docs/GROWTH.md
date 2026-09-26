# Продвижение: превью ссылок, SEO, аналитика, домен

Что есть в коде и что нужно сделать руками владельцу.

## Что работает само

| Что | Где | Как устроено |
|---|---|---|
| Превью ссылки на турнир (WhatsApp, Telegram, Facebook, Viber, Slack, Discord, LinkedIn, VK) | `vercel.json` → `api/preview.js` → `src/lib/seo.js` | Боты мессенджеров не запускают JavaScript. `vercel.json` по User-Agent отправляет их на функцию, которая читает турнир через Supabase REST с anon-ключом (RLS отдаёт только `public`/`link`) и возвращает HTML с Open Graph: название, «Падел · Круговая · адрес», статус. Закрытые и парольные турниры получают общее превью Bracketa. Люди и поисковики (Googlebot) получают обычное SPA. |
| Главная как готовый HTML | `scripts/prerender.mjs` | После `vite build` главная рендерится (Vue SSR) в `dist/index.html` (lt), `dist/en.html`, `dist/ru.html`: текст страницы, `<title>`, описание, `canonical`, `hreflang`, Open Graph. Её видят поисковики и ИИ-ассистенты, которые не выполняют JavaScript. Остальные маршруты получают пустую оболочку `dist/app.html`. |
| Язык в адресе | `src/lib/localeRoute.js`, `vercel.json` | `/` — литовский (язык по умолчанию, `DEFAULT_LOCALE`), `/en`, `/ru`. Первый визит без сохранённого выбора — на литовском. Переключатель языка на главной меняет адрес; внизу главной есть обычные ссылки на все языки. Повторный визит на `/` ведёт на сохранённый язык. Автоперехода по языку браузера нет специально: Googlebot заходит с английским и тогда не увидел бы литовскую версию. Нужную версию в выдаче Google выбирает по `hreflang`. |
| Теги главной | `src/lib/seo.js` | Один источник для пре-рендера и браузера (`applyLandingHead`), чтобы Google после выполнения JS видел то же, что в HTML. |
| Картинка превью | `public/og-image.png` (1200×630) | Исходник `scripts/og-image.html`, перерисовать: `npm run og:image` (нужен Google Chrome). |
| `robots.txt` | `api/robots.js` | Прод: закрыты `/admin` и `/api/`, указан sitemap. Preview-деплои Vercel закрыты целиком. |
| `sitemap.xml` | `api/sitemap.js` | Три языковые версии главной (с `hreflang`) + все турниры с видимостью «Публичный». Турниры «по ссылке» в карту не попадают и помечены `noindex`. |
| Картинка превью турнира | `api/og.js`, `api/_og-card.js` | PNG 1200×630: название, статус (Регистрация открыта / LIVE / Завершён), спорт, формат, даты (первый и последний матч опубликованного расписания в часовом поясе турнира), место. Язык — как у превью. Закрытые турниры получают общую картинку. |
| Schema.org | `src/lib/seo.js` | Главная: Organization + WebSite + WebApplication (бесплатно). Турнир: SportsEvent — только если есть дата в опубликованном расписании и адрес площадки (без них Google разметку события не принимает). Проверка: https://search.google.com/test/rich-results |
| Виджет для сайта клуба | `public/embed.js`, `/embed/:slug`, кнопка «Код для сайта» в админке | Код = обычная ссылка + скрипт. Ссылка остаётся в HTML клуба (её учитывает Google), скрипт ставит iframe с автовысотой. Виджет не индексируется, админка запрещена для встраивания (`frame-ancestors 'none'`). |
| 404 | `vercel.json`, `dist/404.html`, `NotFoundView.vue` | Приложение отдаётся только на свои адреса, остальное — HTTP 404 со страницей «не найдено». |
| Иконки и установка | `public/manifest.webmanifest`, `public/*.png`, `favicon.*` | «Добавить на экран» открывает список турниров организатора (`utm_source=pwa`). |
| Скорость | `scripts/vite-locale-messages.js`, `vercel.json` | Скачивается только нужный язык (общий JS 196 → 128 КБ gzip), шрифты грузятся параллельно, файлы `/assets` кэшируются навсегда. |
| «Сделано в Bracketa» | `src/components/MadeWithBracketa.vue` | Внизу каждой публичной страницы турнира. Ссылка на главную с `utm_source=bracketa&utm_medium=tournament_page&utm_campaign=made_with`. |
| Аналитика | `src/lib/analytics.js` | Umami без cookies, поэтому баннер согласия не нужен. Выключена, пока не задан `VITE_UMAMI_WEBSITE_ID`. |

## Блог (статьи для поиска)

- Статья — файл `content/blog/<язык>/<адрес>.md` (язык `lt`, `ru`, `en`; адрес — латиница, цифры и дефисы).
- В начале файла:
  ```
  ---
  title: Заголовок (до 90 символов)
  description: Описание для поиска (до 170 символов)
  key: padel-tournament        # одинаковый у переводов одной статьи
  date: 2026-09-26
  ---
  ```
- Дальше обычный Markdown (`##` подзаголовки, списки, таблицы, ссылки). Ссылки на сайт — `/`, `/ru`, `/en`.
- `npm run build` превращает статьи в готовые страницы: `/blog/…` (литовский), `/ru/blog/…`, `/en/blog/…`, списки статей и `/blog/sitemap.xml`. Переводы связаны `hreflang`, есть разметка BlogPosting.
- Тест требует, чтобы у каждой статьи были все три перевода. Литовские тексты стоит показать носителю языка.

## «Поделиться» и постер

- После создания публичного турнира и после старта открывается окно «Поделиться»: WhatsApp, Telegram, Viber, почта, системное меню, ссылка, QR, постер. У каждой кнопки свой `utm_source`.
- Постер A4: `/tournaments/<slug>/poster` (кнопка в окне QR и «Поделиться»). QR ведёт на страницу турнира с `utm_source=poster`.

## Письма участникам

Письма: «заявка получена», «вы в листе ожидания», «заявка одобрена», «заявка отклонена», «матч через 30 минут» (для матчей с точным опубликованным временем). Язык — тот, на котором человек регистрировался. В каждом письме ссылка на турнир и «Создайте свой турнир бесплатно».

Как устроено: триггеры в БД кладут строки в `notification_outbox` (адреса там не хранятся), раз в минуту `pg_cron` в Supabase вызывает `/api/notifications`, если есть что отправить; функция отправляет через Resend и отмечает результат (до 5 попыток).

Включение:
1. Применить миграцию `supabase/migrations/20260926200333_participant_notifications.sql` к TENIS (после резервной копии, как в `docs/RELEASE.md`).
2. https://resend.com → аккаунт → подтвердить домен (DNS-записи) → создать API key. Бесплатно: 3 000 писем в месяц, 100 в день.
3. Vercel → Environment Variables (Production), **без** префикса `VITE_`:
   - `RESEND_API_KEY` — ключ Resend;
   - `EMAIL_FROM` — например `Bracketa <turnyrai@ваш-домен>` (домен из шага 2);
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API Keys → secret key;
   - `NOTIFICATIONS_SECRET` — любая длинная случайная строка (`openssl rand -hex 32`).
4. Supabase → SQL Editor (подставить домен и секрет):
   ```sql
   create extension if not exists pg_net;
   create extension if not exists pg_cron;
   select cron.schedule('bracketa-notifications', '* * * * *', $$
     select net.http_post(
       url := 'https://<домен>/api/notifications',
       headers := jsonb_build_object('Authorization', 'Bearer <NOTIFICATIONS_SECRET>', 'Content-Type', 'application/json'),
       body := '{}'::jsonb
     ) where public.notifications_due();
   $$);
   ```
5. Проверка: зарегистрироваться на свой тестовый турнир со своим email → письмо «заявка получена» в течение минуты. Состояние очереди: `select kind, status, attempts, last_error from notification_outbox order by created_at desc limit 20;`
6. Отключить: `select cron.unschedule('bracketa-notifications');`

## События аналитики

Персональные данные (имена, контакты) не отправляются. Адрес страницы очищается: остаётся путь (id турнира в админке заменяется на `:id`) и только `utm_*`.

| Событие | Когда | Данные |
|---|---|---|
| (просмотр страницы) | каждая смена маршрута | путь, имя маршрута, внешний источник перехода |
| `sign_in_start` | нажали «Войти через Google» | `method` |
| `sign_up` | регистрация по email | `method` |
| `create_started` | открыт мастер создания | `step` |
| `create_step` | перешли на следующий шаг мастера | `step` (2–6) |
| `tournament_created` | турнир создан | `sport`, `format`, `category`, `visibility` |
| `draw_generated` | первая жеребьёвка / сетка / группы | `format`, `mode` |
| `share_link_copied` | скопировали ссылку на турнир | — |
| `registration_submitted` | участник отправил заявку | `sport`, `status` |
| `made_with_click` | клик по «Сделано в Bracketa» | — |
| `embed_code_copied` | скопировали код виджета | — |
| `share_channel` | нажали кнопку в окне «Поделиться» | `channel`, `moment` (created / started) |

Главная воронка для Umami (Reports → Funnel): `/` → `sign_in_start` → `create_started` → `create_step` → `tournament_created` → `draw_generated`.

## Что сделать руками

### 1. Аналитика (10 минут)
1. Зарегистрироваться на https://cloud.umami.is (бесплатный тариф).
2. Add website → домен сайта → скопировать **Website ID**.
3. Vercel → Project → Settings → Environment Variables (Production):
   - `VITE_UMAMI_WEBSITE_ID` = Website ID
   - `VITE_UMAMI_DOMAINS` = домен сайта (например `bracketa.lt`), чтобы не считались preview-деплои и localhost.
4. Redeploy. Проверить: открыть сайт → в Umami в разделе Realtime появится посетитель.

### 2. Домен
1. Купить домен (например, у Namecheap, Cloudflare или локального регистратора `.lt`).
2. Vercel → Project → Settings → Domains → Add → следовать подсказкам DNS.
3. Vercel → Environment Variables: `SITE_URL=https://<домен>` (Production) → Redeploy.
4. Supabase → Authentication → URL Configuration: Site URL = `https://<домен>`; в Redirect URLs добавить `https://<домен>/**`.
5. Google Cloud Console → OAuth consent screen: добавить домен в Authorized domains; в OAuth client разрешённые origins/redirects должны вести на Supabase, как сейчас.
6. Старый `*.vercel.app` продолжит работать; ссылки, которые разошлись раньше, не сломаются.

### 3. Google Search Console
1. https://search.google.com/search-console → добавить ресурс (домен) → подтвердить через DNS.
2. Sitemaps → отправить `https://<домен>/sitemap.xml`.

### 4. Проверить языковые версии
- `curl -s https://<домен>/ | grep -o '<title>.*</title>'` — литовский заголовок, `/ru` — русский.
- Google Search Console → URL Inspection → `https://<домен>/` и `https://<домен>/ru` → «Проверить URL на сайте» → скриншот и HTML.
- Bing Webmaster Tools (https://www.bing.com/webmasters) — импортировать сайт из Search Console: Bing используют ChatGPT и Copilot.

### 5. Проверить превью
- https://www.opengraph.xyz/ или https://developers.facebook.com/tools/debug/: вставить ссылку на турнир.
- Telegram кэширует превью: для обновления отправить ссылку боту @WebpageBot.
- Вручную: `curl -A "TelegramBot (like TwitterBot)" https://<домен>/tournaments/<slug>`: в ответе должен быть `og:title` с названием турнира.
