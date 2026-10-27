# Moviestr Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Реализовать отдельный сервер Moviestr и передать проверенные HTTP/WS-контракты фронтенду.

**Architecture:** Один NestJS instance, HTTP-команды и native WS, PostgreSQL через pg и параметризованный SQL.
Чистые игровые переходы, транзакционные repositories, подготовка вне locks, leases, outbox и серверный scheduler.

**Tech Stack:** Node 24, NestJS 11, TypeScript strict, PostgreSQL 17, pg, ws, Zod, Vitest, Yarn Classic.

**Spec:** `docs/superpowers/specs/2026-10-27-moviestr-backend-design.md`, `docs/backend-integration/spec.md`.

## Global Constraints

- Фронтенд не менять; hosting и внешние ресурсы не создавать.
- SQL без ORM; native WS без Redis; пять кадров; соло без очков и таймера.
- Матч: 1000/+100/−50, 90 секунд, 30 секунд reconnect grace, 1–50 разных фильмов, 2–4 места.
- Backend не раскрывает скрытый ответ/будущие кадры/чужие попытки; токены не логируются.
- Сессии 30 дней с продлением, завершённые игры/комнаты и неактивное соло 7 дней; dedup живёт с родительским aggregate.
- Использовать текущий отдельный каталог: `.git` пока отсутствует, worktree не создаётся.

## Review Focus

- Рестарт между commit и WS delivery: outbox восстанавливает уведомление и выдаёт свежую проекцию.
- Повтор ключа с другим телом и два разных ключа одного frame: только одна мутация, остальные conflict/no-op.
- Фоновый loader умер/вернулся поздно: lease/generation не допускает старую публикацию.
- Последний socket игрока исчез, но другой room/lobby socket остался: presence исходной комнаты прекращается.
- Deadline наступил во время ожидания DB lock: решение по времени после lock, timeout commit не откатывается из-за HTTP conflict.

## Task 1: Runtime, SQL и гостевые сессии

**Files:** package.json, tsconfig.json, Dockerfile, compose.yaml, src/common/_, src/database/_,
src/sessions/*, src/app.module.ts, src/main.ts, test/infrastructure.spec.ts.

**Interfaces:** Database.query/transaction; CommandStore.run(owner,scope,key,input,callback); session guard
устанавливает request.guest; Clock.now(); AppError(status,code,message); API schemas принимают unknown.

- [x] Создать tooling/config и тесты миграций, bootstrap cookie reuse, expiry, ownership, idempotency conflict и safe errors.
- [x] Запустить тесты до реализации и убедиться в ожидаемом RED.
- [x] Реализовать SQL migrations, pg transactions/locks, sessions/tickets, validation/Origin/rate limits, healthchecks.
- [x] Запустить тесты на реальном PostgreSQL, type-check и build; записать результат в progress.md.

## Task 2: TMDB/catalog/search

**Files:** src/tmdb/_, src/catalog/_, test/catalog.spec.ts.

**Interfaces:** Catalog.prepare(difficulty,genre,excludedIds): Promise<PreparedMovie>;
Catalog.search(query): Promise<MovieSuggestion[]>; PreparedMovie содержит приватные id/aliases/frames/result.

- [x] Тесты RU/EN merge/max10, Discover percentiles, w1280/min5, OCR title/fallback, malformed data, timeouts и исключённых фильмов.
- [x] RED → реализация fixed-host provider, bounded cache/retry/OCR pool и выбора кадров → GREEN.
- [x] Проверить отсутствие runtime mock-провайдера и сохранить результаты.

## Task 3: Соло и preparation

**Files:** src/solo/*, src/scheduling/preparation.service.ts, test/solo.spec.ts.

**Interfaces:** SoloService.create/get/guess/skip/retry; PreparationService.tick(); персональный GameResponse
с version/serverTime/attemptedMovieIds; pending/error DTO с operationId.

- [x] Тесты победы по ID, одинакового title другого ID, пятого кадра, двойного skip, refresh и чужого доступа.
- [x] Тесты 202/dedup replay, retry operation и позднего lease результата.
- [x] RED → pure rules, persistence, operation worker и HTTP → GREEN с PostgreSQL.

## Task 4: Лобби и матч

**Files:** src/rooms/model.ts, src/rooms/rules.ts, src/rooms/projections.ts, src/rooms/rooms.service.ts,
src/rooms/rooms.controller.ts, test/rooms.spec.ts, test/rules.spec.ts.

**Interfaces:** RoomsService.create/list/get/join/start/guess/skip/leave/retry; персональный RoomSnapshot;
room root lock общий с scheduler; result только finished.

- [x] Тесты score 1050 после ошибки+победы, пятого кадра, timeout/surrender без двойного штрафа, ничьей и distinct movies.
- [x] Тесты приватного preview, password, unique nickname, last slot race, simultaneous start, stale round/frame.
- [x] RED → domain/repositories/services/controllers → GREEN с PostgreSQL.

## Task 5: WS, scheduler и restart

**Files:** src/realtime/*, src/scheduling/scheduler.service.ts, test/realtime.spec.ts, test/restart.spec.ts.

**Interfaces:** Native gateway auth/subscriptions; Presence.roomConnected(room,guest); outbox invalidation;
scheduler.tick() обрабатывает presence/deadlines/preparation/cleanup без клиента.

- [x] Тесты single-use ticket, auth-before-subscribe, foreign membership, personalized frames, two sockets,
      room-scoped presence, host transfer, outbox replay, deadline/guess race и restart на той же БД.
- [x] RED → gateway/scheduler/reconciliation → GREEN.

## Task 6: Контракты, инструкции и итоговая проверка

**Files:** docs/api/openapi.json, docs/api/websocket.schema.json, docs/api/websocket.md, docs/api/handoff.md,
README.md, .env.example, test/contracts.spec.ts, docs/backend-integration/tasks.md.

- [x] Тест соответствия HTTP/WS fixtures контрактам; RED → schemas/export → GREEN.
- [x] Экспорт OpenAPI, README запуска/миграций/тестов/backup и описание cookie/proxy/origins.
- [x] Type-check, lint, format, unit/integration tests, build, Compose config и свежая SQL migration.
- [x] Свежий code review; существенные замечания воспроизвести тестом и исправить.
- [x] Обновить задачи и отчёт проверки, отдельно указать внешние блокировки и непроверенные физические устройства.
