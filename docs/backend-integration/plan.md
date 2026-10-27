# План реализации SPEC-009: backend Moviestr

> Для другого агента: сначала прочитать [`spec.md`](./spec.md) и [`tasks.md`](./tasks.md).
> Это план, не выполненная реализация. Принятые решения и найденные пробелы: [`review.md`](./review.md).
> Итоговое проектирование: [`backend design`](../superpowers/specs/2026-10-27-moviestr-backend-design.md).
> Владелец утвердил проектирование; реализация выполнена. Актуальные контракты и проверки: `docs/api`, `verification.md`.

**Goal:** заменить браузерную серверную логику настоящим backend и подключить существующий Vue-интерфейс без редизайна.
**Architecture:** отдельный NestJS API, PostgreSQL, server-authoritative игровые модели; HTTP-команды и персональные WS snapshots.
**Tech Stack:** Node 24, NestJS 11, TypeScript 5.9, PostgreSQL 17 через `pg`/SQL без ORM, native `ws` Nest provider, guest cookie/ticket.
Локально Docker Compose, затем один backend instance; hosting позже.
**Spec:** SPEC-009 и существующие SPEC-001/002/003/005/006/007 из скопированной frontend-документации.

## 1. Что существует на frontend

| Источник                                                                                                | Текущая ответственность                                           | Что нужно backend                                                  |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/shared/types/game.ts`                                                                              | DTO соло, кадра, поиска, результата                               | сохранить форму ответов, расширять явно                            |
| `src/shared/types/multiplayer.ts`                                                                       | LobbySettings, RoomSnapshot, MultiplayerApi                       | основа DTO, но не готовый сетевой протокол                         |
| `src/shared/api/games.api.ts`, `game-session.ts`                                                        | выбор фильма, проверка title, Map/sessionStorage с полным ответом | серверные соло-сессии                                              |
| `src/shared/api/multiplayer/room-model.ts`                                                              | чистые правила матча                                              | перенести с тестами в backend domain                               |
| `src/shared/api/multiplayer/demo-adapter.ts`                                                            | localStorage, Web Locks, загрузка, heartbeat                      | заменить БД и серверными командами/таймерами                       |
| `src/shared/api/tmdb/*`                                                                                 | TMDB client, каталог, поиск, OCR/кадры                            | перенести в backend modules                                        |
| `src/shared/lib/game-difficulty.ts`, `game-genres.ts`, `movie-knownness.ts`, `movie-title-detection.ts` | диапазоны, жанры, ранжирование, текст                             | переиспользовать правила, убрать Vue/browser зависимости           |
| `server/tmdb-proxy.ts`, `server/vite-tmdb-plugin.ts`, `api/tmdb.ts`                                     | настоящий Vercel/dev TMDB-прокси                                  | перенести защиту token/allowlist/errors, позже удалить из frontend |
| `src/shared/stores/game.store.ts`, `multiplayer.store.ts`                                               | клиентское состояние и координация                                | оставить на фронте, адаптировать к HTTP/WS                         |

Сейчас `/api/v1/games` и `/api/v1/rooms` **не существуют**: функции вызываются локально. Пути ниже — проект нового API.
Frontend находится в `C:/Users/nikip/Documents/Projects/moviestr-front`; backend — текущий `moviestr-back`.
Документация фронта скопирована в `docs/`, каталога `reference/frontend-docs` сейчас нет.

## 2. Глобальные ограничения

- Никаких аккаунтов, чата, OAuth, новых игровых режимов, Top 250 и runtime mock-фильмов.
- Не принимать клиентский score/роль/ответ как истину. IDs других участников не дают права действовать от их имени.
- `GameFrame.index` — 0–4, отображаемый номер фильма — 1–N. `deadline` и `serverTime` — Unix milliseconds.
- Не отдавать `CatalogMovie`, aliases или массив будущих кадров в игровой API; публичный поиск не сообщает связь с раундом.
- Использовать текущие enum-like string unions difficulty/genre и префикс `tmdb-` для внешних movie IDs.
- Backend scope — модули ниже; миграция Vue выделена в раздел 8. Не переписывать компоненты backend-агентом без доступа и задачи.

## 3. Структура backend и хранение

```text
src/
  common/          # validation, error filter, request IDs, clock, rate limits
  sessions/        # opaque guest sessions, HTTP guard, realtime tickets
  tmdb/            # provider client, RU/EN, cache, timeout, unknown validation
  catalog/         # difficulty/genre selection, frame preparation, OCR cache
  solo/            # game controller, pure rules, repository, ownership
  rooms/           # lobby commands, room domain, PostgreSQL transactions
  realtime/        # native WS gateway, subscriptions, personalized snapshots
  scheduling/      # round deadlines, presence, preparation leases, cleanup
  database/        # migrations, repositories, transaction boundary
test/              # HTTP/WS integration, concurrency and restart scenarios
```

Не переносить frontend FSD в NestJS. Controllers/gateway валидируют транспорт, services координируют, domain считает
переходы, repositories отвечают за PostgreSQL. Все внешние данные валидируются на границе, без `any`.

Сущности БД: guest_sessions (хеш opaque token, expiry), solo_games, rooms, room_players, room_rounds,
player_round_progress, command_deduplication, prepared_movies/frames. Отдельная unique связь room/movie исключает повторы.
Внутренние поля фильма и password hash никогда не сериализуются общим ORM-to-JSON.
Связать session с solo и членством в room; nickname не является ключом доступа. Никнеймы unique в комнате без регистра.
Пароль комнаты хешировать серверным password-hashing алгоритмом с солью и ограничением длины; демо-SHA256 не переносить
как production-защиту. Подбор пароля, создание комнат, guest sessions и поиск ограничивать по частоте запросов.

Изменение комнаты и dedup выполняются одной транзакцией с блокировкой строки комнаты; для соло — строки игры.
Все пути (HTTP, scheduler, worker) используют один lock order. Сеть/TMDB/OCR не выполняются под DB lock.
Подготовку резервировать lease с roundId/generation, публиковать только при совпадении reservation.
Каждое изменение увеличивает `version`; WS-сообщения отправлять после commit. При reconnect всегда полный snapshot.
Первая версия — один instance; масштабирование и межпроцессная доставка событий не объявляются реализованными.

## 4. HTTP-контракт для согласования и OpenAPI

Префикс `/api/v1`. JSON responses без неожиданной обёртки `data`; ошибки `{code, message, requestId?}` совместимы с `ApiError`.
Зафиксировать схемы в OpenAPI и экспортировать TypeScript DTO или сгенерированный клиент для frontend.

| Method / path                           | Request                                         | Response                                                                                    |
| --------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `POST /guest-sessions`                  | пустой объект                                   | `{participantId, expiresAt}` + opaque HttpOnly cookie; существующая сессия переиспользуется |
| `GET /collections`                      | —                                               | `MovieCollectionSummary[]`, `tmdb-catalog`                                                  |
| `GET /movies/search?q=`                 | 2+ символа                                      | `MovieSuggestion[]`, RU/EN, unique ID, максимум 10                                          |
| `POST /games`                           | `{collectionId, difficulty, genre}`             | `GameResponse`                                                                              |
| `GET /games/:gameId`                    | guest session                                   | `GameResponse` своей игры                                                                   |
| `POST /games/:gameId/guesses`           | `{movieId, expectedFrameIndex}`                 | `SubmitGuessResponse`                                                                       |
| `POST /games/:gameId/skip`              | `{expectedFrameIndex}`                          | `SkipFrameResponse`                                                                         |
| `GET /rooms`                            | —                                               | публичные waiting `LobbySummary[]`                                                          |
| `POST /rooms`                           | `{settings: LobbySettings, nickname, password}` | `{roomId, snapshot}`; создатель входит как хост                                             |
| `GET /rooms/:roomId`                    | guest session                                   | персональный `RoomSnapshot` участнику; безопасный preview до входа                          |
| `POST /rooms/:roomId/join`              | `{nickname, password}`                          | персональный snapshot                                                                       |
| `POST /rooms/:roomId/start`             | guest session                                   | snapshot; только хост, 2+ подключённых                                                      |
| `POST /rooms/:roomId/guesses`           | `{roundId, movieId, expectedFrameIndex}`        | snapshot после команды                                                                      |
| `POST /rooms/:roomId/skip`              | `{roundId, expectedFrameIndex}`                 | snapshot; пятый кадр = сдача                                                                |
| `POST /rooms/:roomId/leave`             | guest session                                   | `{left: true}`                                                                              |
| `POST /rooms/:roomId/retry-preparation` | guest session                                   | snapshot; только хост в error                                                               |
| `POST /realtime-tickets`                | `{roomId?}`                                     | `{ticket, expiresAt}` для авторизованного WS-подключения                                    |
| `GET /health/live`, `GET /health/ready` | —                                               | liveness; readiness БД/конфигурации без секретов                                            |

`RoomSnapshot` расширить `version` и `serverTime`; для списков/preview определить отдельный DTO без личных полей.
Preview по коду должен работать для приватной комнаты, но не раскрывать участников, фильм, ответы или пароль до join.
Форма preview предлагается: `LobbySummary & {status: RoomStatus}`; точную схему утвердить вместе с frontend adapter.
`GameResponse` при восстановлении дополнить личными `attemptedMovieIds` и version либо согласовать отдельный snapshot DTO:
история неверных вариантов не должна теряться после refresh.

Все изменяющие команды используют `Idempotency-Key`: повтор с тем же телом возвращает прежний результат без эффекта,
тот же ключ с другим телом — 409. Новый ключ со старым round/frame — 409 без штрафа; повтор уже неверного movieId — no-op.
Клиент сохраняет ключ при retry одного действия. Команды проверяют deadline на сервере внутри транзакции.
Предложенные коды: VALIDATION_ERROR (400), SESSION_REQUIRED (401), FORBIDDEN (403), GAME_NOT_FOUND/ROOM_NOT_FOUND (404),
GAME_FINISHED/ROOM_FULL/ROOM_STARTED/NICKNAME_TAKEN/STALE_ROUND/FRAME_CONFLICT (409), WRONG_PASSWORD (403),
RATE_LIMITED (429), UPSTREAM_ERROR (502), SERVICE_NOT_CONFIGURED (503), TIMEOUT (504).
Неизвестные внутренние ошибки — безопасный 500, никогда не неправильная попытка.

## 5. Realtime, сессия и серверное время

Реализован native browser WebSocket через `ws` Nest provider, без Socket.IO. Это уточнение реализации относительно
предложения `WsAdapter`; wire protocol сохранён, lifecycle проверяется native WS tests.
URL WS задаётся отдельно от HTTP API. В первом сообщении передавать одноразовый короткоживущий ticket, не постоянный
guest token в query. До успешной аутентификации никакие subscribe/игровые действия не разрешены; guard проверяет каждое сообщение.
Проверять Origin, размер/формат сообщений, членство и права. Не писать cookies, пароли или ticket в логи.

HTTP cookie: HttpOnly, Secure в production, ограниченный Path/domain, CSRF/Origin-защита команд.
Предложенная схема HTTP — same-origin `/api/v1` через reverse proxy; WS может идти напрямую на backend по ticket.
Если выбран другой origin, явно настроить credentials/CORS и проверить cookie в целевых браузерах, а не ставить `*`.

Сообщение: `{event, data}`. Серверные события `session.ready`, `lobbies.snapshot`, `room.snapshot`, `session.error`.
Snapshots персональны; запрещено broadcast одного объекта всем, если он содержит currentFrame/attemptedMovieIds.
При subscribe, reconnect и пропуске version отдавать полный snapshot. Frontend игнорирует более старые versions.
WS disconnect сам по себе не leave; при нескольких сокетах гостя закрытие одного не делает игрока offline.
Ping/pong и `lastSeen` определяет сервер. После 30 секунд отсутствия всех соединений игрока применяются reconnect/host правила.

Scheduler читает deadline из PostgreSQL, а не доверяет setInterval клиента. Deadline обрабатывается ровно один раз
с теми же транзакциями, что и guesses. После restart просроченные раунды согласованно завершаются.
Если после 30-секундного reconnect grace не осталось активных участников, комната закрывается по MP-023;
таймер без клиентских команд проверять при наличии подключённого участника, а не обещать продолжение пустой комнаты.
Подготовка следующего фильма запускается сервером, без `prepareMovie()` от участника; ошибки и retry не начисляют штраф.

## 6. TMDB, кадры и поиск

Перенести TMDB_READ_TOKEN в backend env; браузер не получает token, raw movie bundle или correct movieId.
Начать с существующих catalog/client/frame-selection и соответствующих тестов, но заменить window/Image/worker на Node-адаптеры.
Кэшировать discover по жанру/странице, movie bundle по ID/языку и OCR по image+версии правил. Дедуплицировать запросы;
ошибки не кэшировать навсегда. Ограничивать число кандидатов, retry/backoff и timeout; не делать бесконечный подбор.

Сохранить доступный пул Discover с лимитом 500 страниц, sort `vote_count.desc`, adult/video=false, жанровые процентили;
70/30 log-normalized известность сортирует кандидатов внутри страницы, а не весь заранее загруженный каталог.
RU/EN поиск выполняется параллельно и объединяется по TMDB ID. При недостаточном пуле уникальных фильмов — безопасная
ошибка подготовки, без повторов, изменения сложности или выдуманных кадров.

Расхождения, которые нельзя скрыто «исправить» при переносе:

- SPEC-002 упоминает 780 px / w780, но текущий код отбирает width >=1280 и выдаёт w1280. Владелец подтвердил сохранение
  1280 px / w1280. API выдаёт только текущий открытый кадр; preload будущих кадров исключён.
- OCR сейчас ограничен 18 кандидатами и общим бюджетом 450 ms; fallback допускает непроверенные кадры без language tag.
  Перенести вычисление на сервер и кэшировать; строгий fail-closed OCR или семантическое распознавание сцен — отдельное решение.
- Первый «атмосферный» кадр сейчас лишь эвристика рейтингов backdrops; не обещать реальное распознавание актёров.
- В старом SOL-001 тексте ошибки ещё упомянут VITE_TMDB_READ_TOKEN: это устарело, секрет должен быть только серверным.

Одинаковый подготовленный фильм в комнате выбирается один раз сервером. CDN изображений может остаться публичным TMDB:
это не обещание криптографически защитить кадр от внешнего распознавания.

## 7. Этапы backend и тестируемые результаты

1. **Контракт и инфраструктура:** подтвердить решения, Nest skeleton, миграции, PostgreSQL test environment, OpenAPI,
   guest session, единый error filter. Тест: чужая сессия не читает игру/комнату, поддельный participantId не даёт прав.
2. **TMDB/catalog/search:** provider client и подготовка фильма на сервере. Тесты: RU/EN, ID-дедуп, процентили, пять кадров,
   title OCR/fallback, некорректный upstream, 429/timeout, исчерпание пула без раскрытия ответа.
3. **Solo:** серверные games и ownership, replay-safe guess/skip. Тесты: победа/пятый кадр/refresh, два одновременных skip,
   одинаковое название разных фильмов, неверный ID, истёкшая сессия; в playing DTO нет answer/aliases.
4. **Lobby:** create/list/preview/join/start/leave. Тесты: приватность, пароль, 2–4 места, один победитель гонки последнего
   места, регистронезависимый ник, старт не хостом и повторный start, новые игроки после старта запрещены.
5. **Match:** pure domain + PostgreSQL transactions. Тесты: 1000/+100/−50, пять кадров, личные попытки, бесплатные skip,
   один штраф surrender/timeout, duplicate/stale команды, ничья, N уникальных фильмов, atomic next round.
6. **WS и scheduler:** authentication, персональные snapshots, deadlines, host transfer/reconnect, restart reconciliation.
   Тесты: нет доступа до auth, чужая подписка запрещена, закрытие одного из двух sockets, таймер без браузера,
   одновременный timeout/guess, смерть loader и поздний результат старого lease не публикуется.
7. **Передача frontend-агенту:** OpenAPI, WS-примеры, env example, локальные команды, миграции, healthchecks и contract fixtures.
   Только после этого выполнять раздел 8, не удалять рабочий frontend заранее.

На каждом этапе: failing domain/integration test → минимальная реализация → green tests → атомарный коммит.
Для concurrency/restart использовать настоящий PostgreSQL, а не SQLite/mock repository. API provider можно подменять в тестах,
но в production никакой mock-каталог не подключается.

## 8. Подключение frontend — отдельный этап после готовности backend

Изменить HTTP transport в `src/shared/api`, `games.api.ts`, `collections.api.ts`, `features/search-movie/api/movies.api.ts`.
Сохранить `ApiError` и UI DTO; все HTTP JSON проверять как unknown. Соло переключить на выбранный movie.id через
`pages/game/model/useGameConsole.ts`, `shared/stores/game.store.ts`, затем согласованный API adapter.

В `shared/api/multiplayer/index.ts` подключить network adapter. Текущие listRooms/getRoom синхронные:
новый adapter хранит локальный кэш последних серверных snapshots, читает его синхронно и обновляет через HTTP/WS;
его subscribe callback уведомляет store. Это клиентский кэш, не второй игровой движок.
Создание guest session асинхронно: сначала initialize/connect transport, потом открывать зависящие от participantId действия.
В `shared/types/multiplayer.ts` явно изменить lifecycle контракта и удалить клиентский prepareMovie; `prepare()` из
`shared/stores/multiplayer.store.ts` убрать. Heartbeat не должен готовить фильмы или двигать таймер на клиенте.
При потере WS показывать reconnect/error, не подменять snapshot локальным демо. После reconnect получать список/комнату заново.

Проверить `/`, `/lobby`, `/lobby/:roomId`, форму пароля, список и waiting screen; до join UI использует безопасный preview DTO.
Сохранить темы, размеры, RU/EN поиск, неверные варианты, Result, переключения сложности/жанра и защиту от stale responses.
Предзагрузка изображений остаётся клиентской оптимизацией, но нельзя заранее получать все закрытые кадры матча:
предзагружать только разрешённый URL; прежнюю CAT-017 формулировку согласованно обновить для серверной модели.

После E2E удалить runtime `shared/api/game-session.ts`, demo-adapter/room-model/storage-schema, браузерные catalog/OCR
и их неактуальные runtime imports; полезные чистые правила/тесты перенести на backend, UI fixtures оставить в тестах.
Из frontend удалить `server/`, `api/tmdb.ts`, `api/tsconfig.json`, Vite TMDB plugin и только относящиеся к ним config/tests.
`TMDB_READ_TOKEN` и tesseract runtime больше не нужны frontend; зависимости/lock обновлять менеджером пакетов.
В `vercel.json` и Vite настроить новый API rewrite/proxy и SPA fallback. Старый `/api/tmdb` удалить после переключения всех callers.
Браузерные env могут содержать публичный HTTP/WS URL, но не token; секреты из Vercel удалять только после переключения production.

## 9. Приёмка и handoff

Backend-агент передаёт: исходники отдельного проекта, миграции, env example без секретов, команды запуска и тестов,
OpenAPI JSON, WS event schema/examples, описание cookie/proxy/origins, отчёт по requirement IDs и известным ограничениям.
Сначала локально пройти соло и матч 2–4 независимых браузерных контекстов; затем staging и отдельное разрешение на production.
Frontend остаётся на Vercel, backend hosting ещё не выбран; ему нужны HTTP, WS и независимо работающие deadlines/preparation.
Не подключать платные платформы, новые GitHub repos или deployment без решения владельца.

Готовность: пять кадров, RU/EN, соло-resume, полный матч N фильмов с двух устройств, личные кадры/попытки,
1000/+100/−50, reconnect/host transfer, restart backend, недоступный TMDB и отсутствие секретов/ответов в browser storage.
Во frontend после миграции выполнить `yarn validate`, `yarn build` и browser E2E; до миграции приложение должно оставаться рабочим.

Источники выбранных механизмов: [NestJS WsAdapter](https://docs.nestjs.com/websockets/adapter),
[guards и lifecycle gateways](https://docs.nestjs.com/websockets/gateways),
[PostgreSQL row locks](https://www.postgresql.org/docs/current/explicit-locking.html).
