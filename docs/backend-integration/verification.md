# Проверка backend Moviestr

Дата: 2026-10-27. Scope: отдельный backend; frontend integration и production deployment не выполнялись.

## Проверенные сценарии

| Требования     | Реализация и доказательство                                                                                                                                     |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BE-001/002     | Nest-модули, `pg` transactions, migrations, guest ownership, validation, safe errors; HTTP/SQL integration tests                                                |
| BE-003/005     | Соло по movieId, пять кадров, won/lost/skip, refresh и попытки, duplicate/stale commands; `rules`, `integration`, `recovery` tests                              |
| BE-004/012     | RU/EN merge и max10, genre percentiles с page401, 70/30 ranking, пять w1280 backdrops, title OCR/fallback, bounded worker и caches; catalog/OCR tests           |
| BE-006/007/008 | Lobby/privacy/password/unique nicknames, last-slot/start races, 1000/+100/−50, бесплатные skip, сдача/timeout, ничья и negative scores; domain/HTTP/match tests |
| BE-008         | Полный матч четырёх независимых HTTP guests с двумя уникальными фильмами и общей победой1200; отдельно domain match50 фильмов и −11500                          |
| BE-009         | Native WS tickets/auth, room-scoped multi-socket presence, reconnect/host transfer, grace eviction и waiting roster; realtime/review regression tests           |
| BE-010         | Личные проекции без правильного ID/aliases/названия/будущих кадров/чужих попыток; строгие HTTP/WS schemas и security assertions                                 |
| BE-011         | Root locks, shared read locks, durable dedup/outbox, deadline после lock, generation/token/lease fencing; PostgreSQL concurrency/recovery tests                 |
| BE-011         | Принудительный SIGKILL дочернего backend-процесса и старт нового на той же БД сохраняют score/frame/attempts и pending outbox                                   |
| BE-011         | Настоящий scheduler interval завершает фильм без HTTP polling; отключение idle PostgreSQL backend connection не завершает API и readiness восстанавливается     |
| BE-013         | Malformed upstream, 429/backoff, timeout504, unique-pool exhaustion, OCR failure и error/retry operations; provider и recovery fixtures                         |
| BE-014         | Во frontend не записывались файлы, demo и Vercel proxy оставлены для отдельного подключения                                                                     |

Все интеграционные сценарии используют настоящий PostgreSQL17 в Compose, а не SQLite/mock repository.
Только TMDB и часы в игровых тестах подменяются. Эти fixtures не подключаются в production.

## Запуск и миграции

- Финальный `yarn validate`: PASS — TypeScript, ESLint, 11 файлов/50 тестов и Prettier.
- Финальный `yarn build`: PASS. `docker compose config --quiet`: PASS.
- TypeScript backend собран и запущен на хосте с PostgreSQL в Compose.
- Реальный HTTP smoke: live200, ready503 без TMDB token, OpenAPI200, guest201, solo202 → безопасная error SERVICE_NOT_CONFIGURED через scheduler.
- `001_initial.sql` и `002_preparation_fencing.sql` применены к новой пустой базе `moviestr_migration_test`.
  Повторный запуск не изменил схему и завершился успешно.
- Compose configuration проходит `docker compose config --quiet`.
- OpenAPI3.1 экспортируется детерминированно; `$ref` и schemas хранятся в JSON. Все WS-примеры документации проверяются client/server schemas.

## Независимое code review и исправления

Свежий reviewer проверил исходники, SQL и контракты. Все четыре существенных замечания воспроизведены RED и исправлены GREEN:

1. Socket закрывался во время await subscribe/pong и мог оставлять ghost presence. Жизненный цикл сериализован;
   presence вычисляется по живым room sockets после root lock, неуспешные disconnect writes повторяются scheduler.
2. Idle pg connection error мог завершить процесс. Добавлен безопасный pool error handler, проверено отключением
   реального PostgreSQL backend connection и повторным readiness дочернего API-процесса. Compose имеет restart policy.
3. Вышедший до старта игрок мог стать победителем. На start формируется актуальный roster; исключённые waiting rows
   удаляются из persistence. Вышедшие во время матча остаются в итоговой таблице, как требуется.
4. Временный сбой проекции удалял live subscription и подтверждал outbox delivery. Временные ошибки сохраняют
   подписку и pending batch для повторной доставки; revoke выполняется только при потере прав/закрытии комнаты.

Дополнительно тестом воспроизведено и исправлено накопление error listeners при переиспользовании OCR worker.
Отложенных замечаний reviewer не оставил. Повторное независимое ревью после исправлений не выполнялось;
исправления подтверждены регрессионными тестами и полным прогоном проверок.

## Уточнения реализации

- PostgreSQL17 вместо первоначально записанного в рабочем плане18: доступный поддерживаемый образ закреплён в Compose и реально проверен.
- Native `ws` подключён как Nest provider вместо `WsAdapter`; wire contract остаётся стандартным WebSocket `{event,data}`.
- POST games всегда202, polling game/operation; frontend adapter должен учесть эту явно описанную асинхронность.
- Relational entities/FK/unique constraints сочетаются с JSONB domain payloads; новые изменения payload schema требуют соответствующих миграций.
- Git отсутствовал изначально; репозиторий, ветки, commits, remote и PR не создавались.

## Ограничения текущей проверки

- TMDB_READ_TOKEN не предоставлен: живой поиск/Discover и OCR на реальных TMDB изображениях не проверялись.
  Проверены boundary validation, детерминированные provider fixtures и безопасный режим отсутствующей конфигурации.
- Production Docker image не удалось собрать: Docker Hub не выдал anonymous pull token из-за TLS handshake timeout
  при получении `node:24-alpine`. Это внешняя блокировка загрузки base image; host build/runtime и Compose PostgreSQL проверены.
- Физические устройства, Vue browser E2E, 360px UI, staging и production остаются отдельными этапами.
- Один backend instance; распределённые presence/доставка и горизонтальное масштабирование не заявлены.

Инструкции: корневой README. Контракты: `docs/api/openapi.json`, `websocket.schema.json`, `websocket.md`, `handoff.md`.
Итоговые команды и результаты также зафиксированы в `progress.md`.
