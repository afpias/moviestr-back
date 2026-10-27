# SDD ledger — plan: docs/superpowers/plans/2026-10-27-moviestr-backend.md

- 2026-10-27: владелец утвердил проектирование, retention и Yarn Classic; разрешена реализация всех этапов.
- Execution: inline, без повторного согласования уже утверждённого scope.
- Ruling: каталог пока без .git — работаем в согласованном отдельном moviestr-back, Git/worktree/external repository не создаём.
- Pre-flight: Database/CommandStore используются Solo/Rooms/Scheduler; Catalog.prepare используется worker;
  projections едины для HTTP и WS. Контракты фиксируются до подключения frontend.

- Task1: complete — Nest modules, sessions, pg repositories/transactions, SQL migrations; реальные HTTP/PG tests проходят.
- Task2: complete — TMDB adapter, cache, поиск, процентили, кадры и OCR engine; provider/catalog/OCR tests проходят.
- Task3: complete — solo, operation/retry, dedup и ownership; PostgreSQL concurrency/recovery tests проходят.
- Task4: complete — lobby и матч, password/privacy/гонки, уникальные фильмы и рейтинг; match4 clients/2 movies и domain50 movies проходят.
- Task5: complete — WS, scheduler, outbox, grace/restart; hard process kill/restart и timer interval проходят.
- Task6: complete — OpenAPI/WS schemas/docs, README/env/Compose, code review и регрессионные исправления.
- Ruling: PostgreSQL17 вместо рабочего предложения18 — используем доступный поддерживаемый образ и проверяем его; риск несовместимости с будущим hosting требует его отдельной проверки.
- Ruling: native ws как Nest provider вместо WsAdapter — wire protocol и права сохранены; жизненный цикл поддерживается собственным gateway и покрывается WS regression tests.
- Ruling: solo create всегда202 — стабильный operation ID и durable replay без удержания HTTP; цена — polling в будущем frontend adapter, описан в handoff.
- Ruling: JSONB payloads внутри relational entities — domain evolution не раздувает столбцы; цена — изменения JSON schema должны сопровождаться миграциями.
- Final review: четыре существенных замечания; все воспроизведены RED→GREEN (`test/review-regressions.spec.ts` и waiting-grace test).
- Final review: idle pg disconnect дополнительно проверен настоящим дочерним API-процессом; ошибок с процессом после отключения нет.
- Final: deferred minors — none.
- External: Docker image build блокируется Docker Hub TLS timeout; live TMDB/OCR smoke требует пользовательский серверный token.
- Final verification: `yarn validate` PASS (type-check, ESLint, 11 test files/50 tests, Prettier); `yarn build` PASS; `docker compose config --quiet` PASS.
- Final verification: fresh SQL migration + replay PASS; host HTTP/scheduler smoke PASS; Docker Hub pull TLS timeout remains an external limitation.
- Final review rulings: disclosed PostgreSQL17/native-ws/202 choices приняты как реализационные уточнения; OCR fallback разрешён владельцем;
  left-during-match roster сохранён по требованиям; physical devices, frontend/production и registry access остаются отдельными проверками.
