# Moviestr backend

NestJS 11, strict TypeScript, PostgreSQL 17 через `pg` и SQL. HTTP-команды, native WebSocket, гостевые cookie,
TMDB/каталог, соло и мультиплеер. Vue-фронтенд пока не подключён и не изменён.

## Локальный запуск

Нужны Node.js 24, Yarn Classic 1.22 и запущенный Docker Desktop с Linux containers.

```powershell
Copy-Item .env.example .env
yarn install --frozen-lockfile
docker compose up -d db
yarn migrate
yarn dev
```

В локальный `.env` самостоятельно добавьте TMDB API Read Access Token в `TMDB_READ_TOKEN`.
`.env` исключён из Git и Docker build context. `moviestr_local` — открытое локальное значение для Compose,
его следует заменить для любого внешнего сервера. Другие секреты в примере отсутствуют.

API: `http://localhost:3000/api/v1`. WebSocket: `ws://localhost:3000/ws`.
`yarn dev` загружает `.env`; watch-режим не включён, после правок перезапустите процесс.
При запуске миграции применяются автоматически с advisory lock; `yarn migrate` позволяет проверить их отдельно.
Сервер не создаёт runtime mock-каталог при отсутствии токена: TMDB-запросы возвращают 503.

Полностью в контейнерах:

```powershell
docker compose up --build -d
docker compose logs -f api
```

Dockerfile собирает TypeScript, устанавливает только production dependencies в runtime image и запускает процесс
от пользователя `node`. PostgreSQL хранится в volume `pgdata`. Для сборки image нужны доступ к registry npm и
образу `node:24-alpine`. Переменные Compose читаются из `.env`.

## Проверки

Создайте отдельную тестовую базу один раз:

```powershell
docker compose exec -T db createdb -U moviestr moviestr_test
yarn test:unit
yarn test:integration
yarn validate
yarn build
```

Если база уже существует, повторять `createdb` не нужно. Все integration tests используют настоящий PostgreSQL;
TMDB и часы подменяются только в тестах. Тесты очищают свои таблицы: `TEST_DATABASE_URL` обязан указывать на базу
с именем, заканчивающимся на `_test`. По умолчанию это `localhost:55432/moviestr_test`.
Произвольный `DATABASE_URL` не используется тестами вместо тестового подключения.

`yarn test` запускает все тесты, включая recovery, WS, контракты и OCR. `yarn validate` выполняет type-check,
ESLint, тесты и проверку форматирования. `yarn openapi` обновляет опубликованные JSON-контракты.
SQL-миграции находятся в `src/database/migrations`; применённые файлы не редактируются, новые добавляются по порядку.

## Контракты и подключение фронтенда

- [OpenAPI 3.1](docs/api/openapi.json), также `GET /api/openapi.json`.
- [WebSocket JSON Schema](docs/api/websocket.schema.json), также `GET /api/websocket.schema.json`.
- [События и примеры WS](docs/api/websocket.md).
- [Передача frontend-агенту](docs/api/handoff.md).
- TypeScript DTO: `src/contracts/dto.ts`; runtime schemas: `src/contracts/contracts.ts`.
- [Проектирование](docs/superpowers/specs/2026-10-27-moviestr-backend-design.md),
  [план реализации](docs/superpowers/plans/2026-10-27-moviestr-backend.md),
  [результаты проверки](docs/backend-integration/verification.md).

Минимальная последовательность HTTP: `POST /guest-sessions {}` → сохранить cookie →
`POST /games` с `Idempotency-Key` → получить 202 с `gameId`/`operationId` → `GET /games/:id` до playing/error →
отправлять `guesses`/`skip` с ожидаемым индексом. Игра загружается серверным worker; клиент не выбирает фильм.
Повтор одного действия использует тот же ключ. Новый ключ с устаревшим frame/round получает 409 без штрафа.

## Cookie, Origin и reverse proxy

Guest cookie: `moviestr_guest`, HttpOnly, SameSite=Lax, Path=/api/v1, без Domain; в production Secure.
В БД хранится только SHA-256 hash случайного 256-bit token. Гость живёт 30 дней, HTTP-активность продлевает срок
и Max-Age cookie. Cookie сессии общая для вкладок: независимые игроки требуют отдельных браузерных контекстов/устройств.

Для будущего production подключения предпочтителен same-origin reverse proxy `/api/v1` и `/ws` к одному постоянно
работающему backend. Для WebSocket proxy должен передавать HTTP Upgrade и иметь idle timeout больше heartbeat.
`ALLOWED_ORIGINS` — точный список адресов фронтенда через запятую, без `*`; backend проверяет HTTP mutations и WS upgrade.
Браузерный HTTP transport использует `credentials: 'include'`.

Кросс-origin разработка на одном localhost поддерживается CORS credentials. При размещении на разных sites одного
CORS недостаточно из-за SameSite=Lax: потребуется same-origin proxy или отдельно согласованная cookie/CSRF схема.
Production domains/hosting ещё не выбраны; конфигурации Vercel и фронтенда не менялись.

Приложение не доверяет произвольному X-Forwarded-For. Перед внешним запуском прокси должен ограничивать запросы
на периметре; настройка доверенных proxy hops зависит от выбранной topology. Встроенные лимиты первой версии:
30 bootstrap/join запросов в минуту на IP, 180 остальных HTTP, 60 WS upgrade в минуту на IP,
120 сообщений в минуту на socket, максимум 1000 sockets и сообщение WS до 16 KiB.

## Таймеры, подготовка и хранение

Scheduler запускается независимо от HTTP-клиентов и раз в секунду обрабатывает deadline/presence/outbox/cleanup.
90 секунд начинаются после готовности фильма. Подготовка выполняется вне SQL locks, ограничивает число кандидатов,
использует lease 120 секунд, уникальный lease token и generation. Сбой подготовки не меняет очки и номер фильма.
Присутствие относится к подписке конкретной комнаты, несколько sockets одного игрока учитываются вместе.
Heartbeat ping раз в 10 секунд; после потери последнего соединения действует 30-секундный grace для reconnect/host transfer.

После restart присутствие сбрасывается с новым grace; истёкшие раунды завершаются один раз, working preparations
возвращаются в очередь. Следующий фильм получает новый deadline после своей готовности. SQL outbox сохраняет
инвалидации между commit и отправкой WS; snapshots полные, персональные и версионированные.

Завершённые/закрытые комнаты и соло без игровых действий очищаются через 7 дней. Записи dedup и preparations
удаляются вместе с родительской игрой/комнатой. Истёкшие сессии и orphaned prepared movies удаляются cleanup.
Successful provider cache — 5 минут, OCR cache — 7 дней. OCR один worker, без неограниченной очереди;
18 кандидатов и foreground budget 450 ms. Timeout/error допускает language-neutral fallback.
Порядок кадров — эвристика рейтингов, гарантированного распознавания актёров нет.

## Эксплуатация

`GET /health/live` подтверждает живой процесс, `GET /health/ready` проверяет PostgreSQL и наличие TMDB token.
Без TMDB token readiness отвечает 503; тестовый runtime с подменённым provider имеет отдельную конфигурацию.
Модель рассчитана на один backend instance. Несколько instances без доработки presence/delivery не поддерживаются.

Резервная копия в архивном формате создаётся внутри контейнера, чтобы Windows shell не перекодировал binary output:

```powershell
docker compose exec -T db pg_dump -U moviestr -Fc -f /tmp/moviestr.dump moviestr
docker compose cp db:/tmp/moviestr.dump ./moviestr.dump
```

Архив содержит игровые данные и hashes: храните его вне репозитория. Для восстановления используйте отдельную
пустую базу и `pg_restore`, предварительно остановив обслуживающий её API. Production backup/restore и deployment
не выполнялись. `docker compose down` останавливает локальные контейнеры и сохраняет volume; `down -v` удаляет данные.

Основная ветка Git — `main`; адрес репозитория — `https://github.com/afpias/moviestr-back`.
CI пока не настроен. Инструкции проекта — в `AGENTS.md`.
