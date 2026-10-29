# Moviestr backend: проектирование

Дата: 2026-10-27. Статус: проектирование утверждено владельцем; backend реализован, итоговая проверка описана в `docs/backend-integration/verification.md`.

Основание: текущий запрос, SPEC-009 в `docs/backend-integration`, связанные SPEC-001/002/003/004/005/006/007,
проверка фактических контрактов соседнего `moviestr-front`. Замечания собраны в `docs/backend-integration/review.md`.

## Цель и ограничения

Отдельный NestJS backend обслуживает существующий Vue-интерфейс. Источник истины для фильмов, ответов, кадров, очков,
дедлайнов, membership и host role — PostgreSQL. Фронтенд подключается отдельным этапом; сейчас его не изменяем.

В scope: TMDB/каталог/поиск, соло, лобби, мультиплеер, HTTP/WS контракты, миграции, тесты и локальный запуск.
Без аккаунтов, чата, голоса, новых режимов, платного AI, runtime mock-каталога, Redis, микросервисов и внешнего deployment.
Успех: восстановление игры и матча, независимый прогресс 2–4 игроков, безопасные гонки, работа server timer без HTTP polling,
restart recovery, отсутствие секретов и скрытого ответа в активных DTO.

## Рассмотренные подходы

1. **Один NestJS instance, HTTP + native WS, PostgreSQL + pg/SQL.** Выбран владельцем: достаточно для первой версии,
   явные транзакции и блокировки, минимальная инфраструктура. Самостоятельно реализуются WS reconnect protocol и SQL repositories.
2. **Socket.IO и Redis с несколькими instances.** Потребовали бы другого frontend transport и распределённой presence;
   для текущего scope не выбраны.
3. **ORM поверх PostgreSQL.** Обсуждены Prisma и TypeORM; владелец выбрал отсутствие ORM и прямой SQL.

Развёртывание: Docker Compose локально; подготовка к одному постоянно работающему серверу, hosting позже.
Docker Compose содержит API и PostgreSQL с persistent volume, healthchecks и отдельной test database.
Версии зависимостей закрепляются при реализации после проверки совместимости; Node 24 доступен локально.

## Подтверждённые решения владельца

- Native WS; HTTP-команды; одноразовый ticket в первом WS auth message.
- Opaque guest token в HttpOnly cookie, в БД только hash. Две вкладки с cookie — один игрок.
- Проверка соло и матча по `tmdb-<id>`, без title matching.
- `attemptedMovieIds` восстанавливаются после refresh.
- Backdrops минимум 1280 px и игровые URL `w1280`. Клиенту выдаётся только текущий кадр.
- OCR сохраняет fallback на языково нейтральные backdrops при ошибке/исчерпании бюджета.

## Модули

- `common`: clock, validation, errors, request IDs, Origin policy, rate limits.
- `database`: pg pool, SQL migrations, unit of work, repositories, outbox.
- `sessions`: guest bootstrap, cookie guard, expiry, одноразовые tickets.
- `tmdb`: фиксированный upstream, параметризованные запросы, unknown validation, retry/timeout/cache.
- `catalog`: collection, жанры/процентили/ранжирование, пять кадров, bounded OCR workers/cache.
- `solo`: чистые переходы игры, ownership, persistence, API.
- `rooms`: waiting lobby, passwords, membership, чистые правила матча, API.
- `realtime`: auth/subscriptions, heartbeat, персональные проекции, version handling.
- `scheduling`: deadlines, presence/grace, preparation leases, reconciliation, retention cleanup.

Domain не зависит от HTTP, Nest, pg или TMDB. Транспорт не определяет бизнес-правила.

## Данные и транзакции

SQL-миграции создают:

- `guest_sessions`: participant UUID, unique token hash, created/last activity/expires timestamps.
- `solo_games`: owner, difficulty/genre/status, prepared movie reference, frame index, attempted IDs, version, timestamps.
- `rooms`: opaque code/ID, settings, password hash, host membership, status, round number/current round, version, timestamps.
- `room_players`: room/session, join order, normalized nickname, score, left flag, presence timestamps/process epoch.
- `room_rounds`: room, number, opaque round ID, private movie reference, deadline, preparation state/lease/generation.
- `player_round_progress`: player/round, frame index, status, attempted IDs, last answer status.
- `prepared_movies` и `prepared_frames`: внутренние названия/aliases/TMDB ID, poster, пять URL; недоступны напрямую из API.
- `room_used_movies`: unique room/movie для предотвращения повторов.
- `command_deduplication`: session, operation scope, key, normalized request hash, outcome, expiry.
- `preparation_operations`: operation ID, owner/target, generation, lease, state и безопасный failure code.
- `realtime_tickets`: только hash, session/scope, expiry, consumed flag.
- `event_outbox`: aggregate ID/version/type, без персональных snapshot/секретов, delivery marker.
- `provider_cache` и `ocr_cache`: versioned keys, bounded retention, успешные результаты.

Ограничения проверяют диапазон frame index, настройки, уникальность номера раунда/фильма/членства и никнейма без регистра.
SQL использует параметры. Repository загружает aggregate и сохраняет изменения внутри одной транзакции.

Lock order: dedup reservation → root game/room → дочерние строки в стабильном порядке. Scheduler блокирует ту же root
перед дочерними строками. При deadlock/serialization failure — ограниченный retry всей команды.
Dedup ключ scoped по гостю, HTTP method/path и ключу; другой payload даёт 409. Проверка прав не обходится через replay.

При принятом действии атомарно сохраняются aggregate, новая version, dedup outcome и outbox invalidation.
Серверное время для deadline берётся после root lock. `now >= deadline` означает timeout; его commit не откатывается
из-за возвращаемого вызывающей команде конфликта. Неизвестный или некорректный input не становится неверной попыткой.

## Подготовка фильма

Сначала короткая транзакция резервирует operation/lease/generation и состояние loading; затем TMDB/OCR выполняются
вне транзакции. Публикация требует совпадения operation, generation и актуального loading round. Старый worker не
может перезаписать новый результат. По истечении lease scheduler продолжает работу; ошибки переходят в error без штрафов.

Создание соло сохраняет стабильный game/operation ID до внешнего I/O. Основной успех POST /games — GameResponse;
если подготовка не закончилась в ограниченное время HTTP-запроса, возвращается 202 с operationId/gameId и Location.
GET operation возвращает pending/ready/error; повтор POST с тем же ключом использует прежнюю operation.
GET loading/error игры использует отдельный явно описанный preparation DTO; готовые GameResponse сохраняют frontend shape.
Retry preparation не меняет difficulty/genre/game identity и не открывает новый фильм в уже готовой игре.
Первая transport response фиксируется в dedup неизменно: если исходный POST вернул 202, его повтор возвращает те же
202/operationId даже после завершения; актуальный результат читается через GET operation/game. Retry после terminal
error требует нового Idempotency-Key, создаёт новую operation и generation той же игры. Старая operation остаётся
terminal error. Одновременные retries не создают две подготовки; ready-игра не готовится повторно.

В комнате start/next-round переводит в loading и возвращает snapshot; фильм готовит сервер. Публикация назначает
общий deadline now + 90 секунд. `retry-preparation` разрешён хосту в error для того же номера фильма.

## TMDB, поиск и OCR

TMDB_READ_TOKEN только в backend env; upstream host и разрешённые endpoints фиксированы. Нет универсального proxy URL.
RU/EN поиск параллелен, объединяется по ID, максимум 10 suggestions. Query trim и минимум два символа.
Discover: vote_count.desc, adult/video=false, максимум 500 страниц. Процентили 0–10 / 10–30 / 30–55 / 55–80 / 80–100
считаются внутри жанра. 70/30 log-normalized vote count/popularity ранжируют страницу, не весь загруженный каталог.

Фильм должен иметь пять разных горизонтальных backdrops нужного размера без language tag; данные фильма и aliases
загружаются bundle-запросом. Ограниченный перебор кандидатов и страниц не выходит за жанр/процентиль, исключает used IDs.
Исчерпание возвращает безопасную ошибку, без повторов в матче и подмены сложности.

OCR сравнивает текст со всеми названиями, сохраняет лимит 18 кандидатов и 450 ms foreground budget как исходное
поведение. Node worker pool/очередь ограничены; task timeout освобождает/заменяет worker. Подтверждённые title cards
исключаются, непроверенные language-neutral кадры допускаются согласно согласованному fallback. Это эвристика,
а не семантическое распознавание актёров. Кэши ограничены по TTL/размеру, ошибки не становятся вечными cache entries.

## HTTP API и безопасность

Префикс `/api/v1`; JSON без обёртки data; ошибки `{code,message,requestId}`. Liveness/readiness имеют отдельные public endpoints.
Маршруты SPEC-009 сохраняются: guest-sessions, collections, movies/search, games/create/get/guesses/skip,
rooms/list/create/get/join/start/guesses/skip/leave/retry-preparation, realtime-tickets.
Добавляются явно описанные operation polling/retry endpoints для подготовки соло.

GET комнаты до join возвращает `view: preview` и безопасные summary/settings/status. Участнику возвращает
`view: member` и персональный snapshot. OpenAPI задаёт oneOf/discriminator, auth и все error statuses.
Все success projections игровых команд содержат version/serverTime; полный GET соло содержит личную историю попыток.
Активные DTO не содержат правильного movie ID, названий, aliases, poster результата и будущих кадров.
Комната раскрывает GameResult только при finished, без промежуточного answer screen.

Session cookie: HttpOnly, SameSite=Lax, Secure в production; ограниченный Path, без широкого Domain.
Origin allowlist/CSRF policy на изменяющие запросы, CORS с credentials и точными origins. Production origin и reverse
proxy ещё не выбраны; локальные настройки конфигурируемы. Same-origin `/api/v1` — предпочтительная схема для будущего подключения.
Session creation, search, create/join, password attempts, tickets и WS messages ограничены по частоте/размеру.
Password hashing использует salted scrypt через Node crypto, bounded password length и постоянное сравнение hash.
Секреты не пишутся в логи, generic 500 не раскрывает upstream body или SQL.

## WS-протокол и доставка

Сообщение `{event,data}`, client requestId для correlation. Socket принимает только auth до проверки ticket.
Client events: `session.auth`, `lobbies.subscribe`, `lobbies.unsubscribe`, `room.subscribe`, `room.unsubscribe`.
Server events: `session.ready`, `lobbies.snapshot`, `room.snapshot`, `session.error`.
Игровые команды отправляются по HTTP. Ticket выдаётся через защищённый HTTP, живёт кратко и атомарно потребляется один раз.
Guest token и ticket не попадают в URL. Origin проверяется при upgrade; membership проверяется при subscribe и при доставке.

Snapshots полные и персональные; никаких общих broadcast objects с чужим currentFrame/attemptedMovieIds.
Outbox сообщает только об изменении aggregate: dispatcher заново строит проекцию для каждого актуального подписчика.
At-least-once delivery допускает дубликаты; version защищает клиент от старого состояния. Lobby list имеет собственную revision.
Reconnect требует нового ticket, затем полного списка/room snapshot. Presence heartbeats обеспечиваются сервером.
У гостя может быть несколько sockets; закрытие одного не снимает presence до закрытия остальных.
Presence учитывается отдельно по комнате: её поддерживают только authenticated sockets с подпиской на эту комнату.
Открытый список лобби или socket другой комнаты не сохраняет здесь присутствие. Create/join дают начальные 30 секунд
на WS handshake; дальнейшее присутствие подтверждается room subscription и pong. После закрытия последнего room socket
connected становится false; срок передачи хоста и выселения waiting member отсчитывается отдельно от disconnect.
Для старта нужны два текущих подключённых room participants; один HTTP join без подписки не подтверждает готовность.

## Правила игры и восстановление

Соло: пять кадров, свободная смена жанра/сложности, skip на кадрах 0–3, surrender на 4, верный ID = won, неверный ID
продвигает кадр или даёт lost на последнем. Повтор неверного ID не двигает кадр. Очков/таймера нет.
Next/retry/reset frontend сможет выполнять через создание новой игры с выбранными настройками; цикл сложности сохраняется в контракте.

Лобби: настройки SPEC-006, вместимость 2–4, имена 2–24 и 2–60 после trim, filmCount 1–50 по умолчанию 20.
Старт только хостом при двух подключённых; гонка последнего места разрешается root lock. Private комнаты не перечисляются.
После старта разрешено только восстановление существующего membership.

Матч: 1000 стартовых очков, +100 за верный ID, −50 за каждый новый неверный ID. Ошибка на пятом кадре не даёт второго
штрафа. Skip 0–3 бесплатен, surrender/timeout −50 один раз. Личные попытки независимы. Все закончили или deadline →
следующий уникальный фильм; после N фильмов finished и все участники с максимальным score — победители.

Grace reconnect 30 секунд. После него отсутствующий хост заменяется первым активным по join order; без активных
участников комната закрывается. Явный leave освобождает waiting slot; в матче сохраняет участника в таблице и завершает
текущий фильм как surrender. Offline участники получают timeout по общему deadline.
В waiting отключённое membership после grace помечается left: слот и nickname освобождаются. Вернувшийся гость может
войти заново, пока комната waiting, но прежнее место и роль хоста не резервируются. Во время матча offline membership
сохраняется для восстановления; явный leave запрещает повторный вход в уже начавшийся матч. Явный leave хоста
передаёт роль следующему подключённому участнику без ожидания grace.

Scheduler использует БД, не client intervals: overdue rounds, presence, истёкшие leases, outbox и cleanup.
На старте новый process epoch инвалидирует старые socket presence и даёт grace для reconnect; overdue deadlines
разрешаются транзакционно. Не происходит автоматического проигрывания всех будущих фильмов за время простоя:
следующий deadline начинается только после фактической готовности следующего фильма.
При restart сначала помечаются старые sockets offline и назначается startup reconnect grace; затем просроченный
игровой deadline разрешается с прежними очками/штрафами. До истечения startup grace отсутствие сокетов само по себе
не закрывает комнату. Если deadline завершил последний фильм, finished сохраняется для результата. Если до grace
никто не вернулся в ещё активную комнату, она закрывается и поздний preparation result отбрасывается.

## Проверки и приёмка

- Unit/domain: процентили, ranking, RU/EN merge, frame selection/OCR fallback, solo transitions, scoring/ties.
- Security projections: active snapshots не содержат answer/aliases/правильный ID, будущие кадры и чужие попытки;
  preview не раскрывает membership и private поля; чужая сессия не читает игру и не выполняет команды.
- HTTP/WS integration с независимыми cookies: lobby/password/start, персональные кадры, replay/stale/version,
  auth ticket, Origin, rate limits, два sockets одного гостя.
- Настоящий PostgreSQL: last-slot race, simultaneous start/skip, guess versus deadline, stale loader fencing,
  crash/restart с тем же volume, outbox recovery, cleanup/FK и миграции с пустой БД.
- TMDB adapter fixtures: malformed upstream, 429/backoff, timeout, недоступный OCR, исчерпание уникальных фильмов.
- Build/type-check/lint/format, OpenAPI validation, WS JSON schema fixtures, проверка отсутствия секретов в артефактах.

Поставляемые файлы: исходники, SQL-миграции, Compose/Dockerfile, `.env.example`, README с запуском/тестами/backup,
OpenAPI JSON, WS schema/examples, handoff с mapping frontend DTO и отчётом по требованиям/ограничениям.
Физические устройства, интеграция Vue и staging/production — отдельные этапы, их не подменяют backend tests.

## Дополнительные решения, утверждённые владельцем

- Retention: 30 дней гостевой сессии с продлением активности, 7 дней завершённых соло/комнат и неактивного соло,
  dedup на срок жизни родительской сущности. Waiting без подключений закрывается после 30 секунд.
- Yarn Classic и оформление инструментов как у фронта.

Уточнения реализации: PostgreSQL 17; native `ws` подключён как Nest provider с тем же протоколом;
создание соло всегда возвращает 202 со стабильными ID, затем используется GET игры/operation.
Relational entities содержат JSONB domain payloads; FK, unique nickname/room movie и frame-index constraints остаются в PostgreSQL.

## Решения, оставленные исполнителю

Точные совместимые версии пакетов, лимиты cache/retry/worker pool, heartbeat intervals, ticket TTL, password limits,
структура SQL indexes и организация тестовых fixtures. Все значения документируются и проверяются; они не меняют
согласованные продуктовые правила. Hosting/origins позже задаются конфигурацией без создания внешних ресурсов.

## Результат независимой проверки

Ревьюер не нашёл дополнительных важных пробелов в скрытии ответа, lock order и расширениях DTO. Три уточнения
исполнителя внесены выше: room-scoped presence, освобождение waiting membership после grace и неизменяемый lifecycle
preparation operations/dedup replay. Они явно фиксируются здесь до реализации.

## Дополнение 2026-10-28: persisted round results

Немедленный переход фильма заменяется общей фазой round-result с личным outcome и persisted all-ready barrier.
Точный новый контракт и правила grace/restart: [spec](../../round-results/spec.md).
