# Moviestr backend

NestJS 11, strict TypeScript, PostgreSQL 17 через `pg` и SQL. HTTP-команды, native WebSocket, гостевые cookie,
TMDB/каталог, соло и мультиплеер. Vue-клиент собирается из соседнего frontend-репозитория и обслуживается nginx.

## Запуск всего приложения в Docker

Нужен запущенный Docker Desktop с Linux containers. Оба репозитория лежат рядом:

```text
C:/Users/nikip/Documents/Projects/moviestr/
  moviestr-back/
  moviestr-front/
```

Текущий рабочий каталог backend: `C:/Users/nikip/Documents/Projects/moviestr/moviestr-back`.
Frontend находится в `../moviestr-front`. Из корня `moviestr` подготовьте backend env, не перезаписывая существующий:

```powershell
if (-not (Test-Path moviestr-back/.env)) { Copy-Item moviestr-back/.env.example moviestr-back/.env }
# Добавьте TMDB API Read Access Token в moviestr-back/.env: TMDB_READ_TOKEN=...
docker compose -f moviestr-back/compose.yaml up --build -d --wait
```

Адрес приложения: `http://localhost:8080`. Nginx проксирует `/api/v1` и `/ws` на `api:3000`, включая WebSocket Upgrade.
Debug API: `http://localhost:3000/api/v1`; PostgreSQL: `localhost:5433` с текущим `.env.example` (`POSTGRES_PORT`, fallback без настройки — 55432). Все опубликованные порты привязаны к 127.0.0.1.
Перед стартом освободите 3000 от своего host backend; не завершайте неизвестный процесс.

Compose ждёт healthy PostgreSQL, затем API readiness с БД и token configuration, затем запускает frontend.
Пустой `TMDB_READ_TOKEN` оставляет API unhealthy; проверьте `.env` и `/health/ready`.
Readiness подтверждает наличие token, а действительность доступа к TMDB проверяется поиском/подготовкой игры.
Миграции выполняются API автоматически с advisory lock. PostgreSQL использует прежний named volume `pgdata`.

```powershell
docker compose -f moviestr-back/compose.yaml ps
Invoke-RestMethod http://localhost:3000/health/live
Invoke-RestMethod http://localhost:3000/health/ready
# Остановка сохраняет volume:
docker compose -f moviestr-back/compose.yaml stop
```

Это локальный HTTP Compose: `NODE_ENV=development` задан явно, хотя API и Vue собираются как production assets.
Так HttpOnly/SameSite cookie работает на HTTP `8080`; production требует HTTPS и Secure cookie, согласуется отдельно.
`DOCKER_ALLOWED_ORIGINS` по умолчанию включает `http://localhost:8080`, `http://127.0.0.1:8080`, `http://localhost:5173`, `http://127.0.0.1:5173`.
Прежний `ALLOWED_ORIGINS` из `.env` относится к host dev и не перекрывает Docker origins.

Секрет TMDB передаётся только runtime API, не frontend и не build args. `.env`, зависимости, cache и Git исключены
из backend build context. `moviestr_local` — открытое локальное значение; для внешнего сервера его заменяют.
Не использовать `down -v`, `volume rm` или prune для обычного restart.

### Proxy в локальной Windows среде

Если выход к TMDB/npm требует существующего Windows proxy, добавьте в ignored `moviestr-back/.env` только локальные
proxy endpoints, например для уже настроенного HTTP proxy на Windows port 10808:

```dotenv
DOCKER_HTTP_PROXY=http://host.docker.internal:10808
DOCKER_HTTPS_PROXY=http://host.docker.internal:10808
DOCKER_BUILD_HTTP_PROXY=http://host.docker.internal:10808
DOCKER_BUILD_HTTPS_PROXY=http://host.docker.internal:10808
```

Без proxy оставьте значения пустыми. Контейнерный localhost относится к контейнеру, поэтому Windows proxy доступен
через `host.docker.internal`. API включает `NODE_USE_ENV_PROXY=1`; `NO_PROXY` содержит localhost, db, api, frontend.
Те же DOCKER_* переменные можно задать только в текущем PowerShell процессе, не меняя `.env` или системные настройки.
Не помещайте proxy credentials в build args. TLS verification остаётся включённой.

Build proxy относится к RUN-командам сборки, а загрузка base images выполняется Docker Engine отдельно.
Для неё также нужен рабочий registry access. Если Engine не может скачать официальный image, исправьте его сетевой
доступ без отключения TLS; детали обхода локального сбоя и фактической проверки записаны в `docs/docker-runtime`.

Подробности: [design](docs/docker-runtime/spec.md), [plan/tasks](docs/docker-runtime/plan.md),
[результаты Docker-проверки](docs/docker-runtime/verification.md).

### Host-порт PostgreSQL и Windows reservations

Host port задаётся `POSTGRES_PORT` в backend `.env`; Compose fallback — 55432. Текущий пример использует 5433,
поскольку 29 октября Windows зарезервировала диапазон 55418–55517. Внутри Docker всегда используется `db:5432`.
При смене host port обновите POSTGRES_PORT, порт DATABASE_URL и TEST_DATABASE_URL в ignored backend `.env`,
затем пересоздайте только db через `docker compose up -d db`. Существующий volume сохраняется.
Тестовый helper читает `.env` и по-прежнему требует имя БД с суффиксом `_test`.
Проверить резервирование Windows можно `netsh interface ipv4 show excludedportrange protocol=tcp`.
Системные exclusions, WinNAT/HNS и Docker data для смены локального порта не сбрасываются.

## Разработка на хосте

Нужны Node.js 24 и Yarn Classic 1.22. Команды выполняются из backend-каталога при остановленном контейнере api:

```powershell
yarn install --frozen-lockfile
docker compose up -d db
yarn migrate
yarn dev
```

`yarn dev` загружает `.env`; watch-режим не включён, после правок перезапустите процесс.
Без TMDB token сервер не подставляет mock-каталог. Host API использует `ALLOWED_ORIGINS`.
Для host runtime с Windows proxy нужны process-only HTTP_PROXY/HTTPS_PROXY, NODE_USE_ENV_PROXY=1 и NO_PROXY localhost.

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
с именем, заканчивающимся на `_test`. В `.env.example` это `localhost:5433/moviestr_test`; TEST_DATABASE_URL должен соответствовать POSTGRES_PORT.
Без TEST_DATABASE_URL тестовый helper сохраняет исходный fallback `localhost:55432/moviestr_test`.
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
  [первичная проверка](docs/backend-integration/verification.md),
  [проверка после переноса 28 октября](docs/backend-integration/verification-2026-10-28.md).

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

Постоянные ветки — `main` и `dev`; разработка ведётся в `feature/*` и `fix/*` от `dev`.
[Git workflow](docs/git-workflow.md): checks/PR в dev, annotated уникальные dev-теги на принятых merge commits,
release обычным merge в main с сохранением ancestry. Только после успешной публикации vSemVer удаляются dev-теги,
достижимые из exact release commit. Публикация refs выполняется по этому workflow; backend CI пока не настроен.
Репозиторий: `https://github.com/afpias/moviestr-back`. Инструкции — в `AGENTS.md`.

## Общий результат фильма в мультиплеере

После общего завершения фильма комната переходит в `round-result`: всем участникам виден правильный `result`,
а `roundResult.outcome` сообщает личное won/lost. Пока другие отвечают, ответ остаётся скрыт.
«Далее» — POST `/api/v1/rooms/:roomId/ready` со строгим `{roundId}`, cookie и Idempotency-Key.
Следующий фильм готовится только после всех required ready; после последнего фильма открывается общий рейтинг.
Произвольного auto-continue timer нет. Explicit leave/30-секундный offline grace снимает участника с текущего барьера;
поздний reconnect не добавляет его обратно. Result/ready восстанавливаются из PostgreSQL после refresh/restart.
[Контракт и правила](docs/round-results/spec.md), [plan/tasks](docs/round-results/plan.md).
