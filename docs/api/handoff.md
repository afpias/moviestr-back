# Передача контрактов frontend-агенту

Backend готовится отдельно от Vue. Исходники фронтенда не изменены; его текущий runtime продолжает работать.
Подключение, удаление demo/TMDB proxy и изменение Vercel rewrites выполняются отдельным запросом.

## Совместимость и явные изменения

| Существующий контракт    | Сетевой backend                                                                          |
| ------------------------ | ---------------------------------------------------------------------------------------- |
| MovieSuggestion          | Та же форма RU/EN/year/id, максимум 10, стабильный `tmdb-<id>`                           |
| GameFrame                | index 0–4, нейтральный alt, w1280; только текущий открытый URL                           |
| GameResult               | title/originalTitle/posterUrl/releaseYear, без правильного movie ID                      |
| GameResponse             | Добавлены version/serverTime/attemptedMovieIds; loading/error содержат operationId/error |
| SubmitGuessResponse      | Сохранён correct; ответ содержит полный личный snapshot и version                        |
| SkipFrameResponse        | Полный личный snapshot вместо только частичных полей                                     |
| POST games               | Всегда 202 с gameId/operationId; затем polling GET игры или operation до ready/error     |
| Соло title matching      | Выбранный movie.id, как в мультиплеере; одноимённый другой ID неверен                    |
| listRooms/getRoom sync   | HTTP/WS async; адаптеру нужен локальный snapshot cache, без локальных игровых правил     |
| RoomSnapshot             | Добавлены view=member, version и serverTime; личные поля формируются сервером            |
| Просмотр комнаты до join | view=preview, summary/settings/status; нет players/host/кадров/ответа                    |
| participantId            | Выдаётся асинхронным guest bootstrap; никнейм не определяет полномочия                   |
| prepareMovie/heartbeat   | Удалить из будущего network adapter: сервер готовит фильм и следит за временем           |

Текущие UI сложности/жанры и режим points сохранены. Свободная смена настроек соло, next/retry/reset создают новую
игру с нужными параметрами; цикл easy → medium → hard → expert → impossible → easy остаётся тем же.
`retry-preparation` повторяет неуспешную загрузку той же игры, а не создаёт следующий фильм.

## HTTP transport

Сначала bootstrap cookie; далее `credentials: include` и точный ALLOWED_ORIGINS. Для mutations создавать UUID
Idempotency-Key и сохранять его при сетевом retry одного действия. Для нового действия — новый ключ.
Ответы 400/401/403/404/409/429/502/503/504 обрабатываются через `{code,message,requestId?}`.
Повтор ключа с другим нормализованным request body — 409 IDEMPOTENCY_CONFLICT.
Duplicate wrong movie ID с актуальным frame — no-op. Stale frame/round — 409 без штрафа.
При `now >= deadline` backend сначала сохраняет timeout, затем может вернуть DEADLINE_EXCEEDED; следует перечитать snapshot.

Первый ответ 202 фиксируется неизменно. Даже после успешной подготовки replay исходного POST даёт прежние 202 и
operationId. Retry error создаёт новую operation/generation с новым ключом; старая operation остаётся terminal error.
В snapshot loading/error нет кадра и результата. Polling можно остановить после playing/won/lost/error;
ожидание загрузки не является попыткой и не расходует игровой таймер.

## Realtime adapter

Использовать native WebSocket и [описанный ticket/auth protocol](./websocket.md). Lobby ticket и room ticket имеют
разные scope. После join получить room ticket, подписаться и дождаться snapshot; только после двух room subscriptions
host может стартовать. Сам HTTP join ещё не означает подключённого room participant.

Не отправлять client score, correct, deadline, hostId/роль. К каждому guess/skip прикладывать roundId и
expectedFrameIndex из последнего личного snapshot. После reconnect полностью обновлять список/комнату;
версии защищают от reorder между HTTP и WS. При потере связи показывать reconnect, без demo fallback.

## Хранение и приёмка

Сохранить локальные UI-настройки, тему, жанр и opaque gameId. Правильный фильм, aliases, весь массив кадров и
гостевой token в browser storage не переносить. Cookie HttpOnly недоступна JS. Попытки восстанавливаются с backend.
Две вкладки с общей cookie — один гость; multiplayer E2E использует независимые browser contexts.

Frontend-агенту проверить маршруты `/`, `/lobby`, `/lobby/:id`, сольную победу/поражение/refresh,
матч 2–4 независимых contexts, password/private preview, reconnect/host transfer и backend restart.
Затем выполнить frontend validate/build и E2E 360 px/desktop. Только после этого удалять соответствующий demo runtime.
Живая проверка на двух физических устройствах и staging/production пока не выполнялась.

Источники контрактов: [OpenAPI](./openapi.json), [WS Schema](./websocket.schema.json),
TypeScript DTO `src/contracts/dto.ts`. Production endpoints/domain scheme задаются после отдельного выбора hosting.
