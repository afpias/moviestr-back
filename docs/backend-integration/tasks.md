# Задачи SPEC-009

Статус: backend реализован; локальная проверка и ограничения — [`verification.md`](./verification.md). [`spec.md`](./spec.md), [`plan.md`](./plan.md),
[`review.md`](./review.md). Приняты `pg`/SQL без ORM, native WS, guest cookie/ticket и локальный Docker Compose.

## Подготовка и контракт

- [x] Подтвердить native WS, guest session/ticket, title → movieId, восстановление попыток, w1280 и выдачу только текущего кадра.
- [x] Выбрать текущий `moviestr-back`, `pg`/SQL без ORM и локальный Docker Compose; hosting отложить.
- [x] Утвердить итоговое проектирование, retention и tooling; закрепить версии и локальные origins. Production topology выбрать позже.
- [x] Зафиксировать OpenAPI, event schema, DTO preview/snapshot/version/serverTime и error codes (BE-001,004,005).
- [x] Описать изменения относительно SPEC-001/002/003/005/006/007 в SPEC-009 и handoff, сохранив историю демо.

## Backend

- [x] Nest infrastructure, PostgreSQL migrations, guest ownership, validation/errors, healthchecks (BE-001,002).
- [x] TMDB client, RU/EN search, percentile catalog, пять кадров и server OCR cache (BE-004,012,013); live-token smoke отдельно.
- [x] Solo API, persistence, guess/skip и idempotency (BE-003,005,010,011).
- [x] Lobby API: list/preview/create/join/start/leave и пароль (BE-006,009).
- [x] Match domain, score, personal progress, unique movies, transactional transitions (BE-007,008,011).
- [x] Персональный WS, reconnect, presence, scheduler, host transfer, preparation lease (BE-009–011,013).
- [x] Contract tests и реальные PostgreSQL tests для гонок/restart; security projection tests для скрытого ответа.
- [x] Подготовить handoff: OpenAPI, WS fixtures, env и инструкции запуска (без отправки сообщений другим чатам).

## Frontend — только после готовности API

- [ ] HTTP client и network multiplayer adapter с snapshot cache; async guest initialization.
- [ ] Подключить solo/search/lobbies, убрать клиентскую preparation и проверку ответа.
- [ ] Сохранить локальные UI-настройки; мигрировать/очистить только старые demo session keys.
- [ ] Проверить все маршруты, resume, поиск, результаты, reconnect и личные попытки.
- [ ] Удалить заменённый demo/runtime backend и Vercel TMDB proxy, обновить config/dependencies (BE-014).

## Verify

- [x] Backend unit/integration/security/concurrency tests, contract/schema tests и code review; см. verification.md.
- [x] Матч четырёх HTTP-клиентов, native WS, hard process restart, серверный interval и provider outage fixtures.
- [ ] Собрать production Docker image после восстановления доступа к Docker Hub/npm registry.
- [ ] Live TMDB/OCR smoke с серверным токеном в локальном .env.
- [ ] Полный матч 2–4 независимых браузеров и двух устройств; server restart и TMDB outage.
- [ ] Frontend yarn validate/build, desktop/360 px E2E, отсутствие answer/token в Network/storage/dist.
- [ ] Staging, затем отдельно согласованный production cutover; обновить документацию по факту.
