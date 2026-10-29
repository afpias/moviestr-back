# Moviestr native WebSocket

Версия контракта: 0.1.0. Endpoint `/ws`, протокол стандартного browser WebSocket, без Socket.IO framing.
JSON: `{ "event": "...", "data": {...}, "requestId": "optional-client-id" }`.
`requestId` необязателен; ошибки на валидном envelope возвращают его внутри data. Snapshots сопоставляются по version.

## Вход и подписки

1. HTTP `POST /api/v1/guest-sessions {}` создаёт/восстанавливает cookie.
2. HTTP `POST /api/v1/realtime-tickets {"roomId":"code"}` выдаёт ticket для комнаты уже вошедшему участнику.
   Без roomId ticket подходит для списка лобби. Ticket живёт 30 секунд и потребляется один раз.
3. Открыть `/ws` с разрешённого Origin; за 5 секунд отправить auth.
4. После session.ready отправить подписку. Каждое переподключение требует нового ticket и полного snapshot.

```json
{ "event": "session.auth", "data": { "ticket": "opaque-value-from-http" }, "requestId": "auth-1" }
```

```json
{ "event": "session.ready", "data": { "participantId": "11111111-1111-4111-8111-111111111111", "serverTime": 1793070000000 } }
```

```json
{ "event": "room.subscribe", "data": { "roomId": "opaque-room-code" }, "requestId": "room-1" }
```

```json
{ "event": "lobbies.subscribe", "data": {} }
```

```json
{ "event": "room.unsubscribe", "data": {} }
```

```json
{ "event": "lobbies.unsubscribe", "data": {} }
```

Room subscription допускается только для комнаты ticket и актуального membership. Lobby ticket не позволяет читать
комнату. До auth другие события возвращают SESSION_REQUIRED. Повторный auth на том же socket — ALREADY_AUTHENTICATED.
Пароли и постоянный guest token не передаются через WS, URL или query. Игровые команды идут по HTTP.

## Серверные события

| Event            | Data                                        | Когда                                  |
| ---------------- | ------------------------------------------- | -------------------------------------- |
| session.ready    | participantId, serverTime                   | Ticket принят                          |
| session.error    | code, message, requestId?                   | Невалидное сообщение, права или сессия |
| lobbies.snapshot | revision, serverTime, rooms: LobbySummary[] | Подписка и изменение лобби             |
| room.snapshot    | RoomSnapshot                                | Подписка и изменение комнаты           |

RoomSnapshot всегда персонален. Пример playing:

```json
{
	"event": "room.snapshot",
	"data": {
		"view": "member",
		"id": "opaque-room-code",
		"settings": {
			"name": "Компания",
			"capacity": 4,
			"filmCount": 20,
			"difficulty": "easy",
			"genre": "all",
			"mode": "points",
			"visibility": "public"
		},
		"hostId": "11111111-1111-4111-8111-111111111111",
		"players": [
			{
				"id": "11111111-1111-4111-8111-111111111111",
				"nickname": "Игрок",
				"score": 1000,
				"status": "playing",
				"lastAnswer": null,
				"connected": true,
				"left": false
			}
		],
		"status": "playing",
		"roundId": "22222222-2222-4222-8222-222222222222",
		"roundNumber": 1,
		"deadline": 1793070090000,
		"currentFrame": { "index": 0, "url": "https://image.tmdb.org/t/p/w1280/example.jpg", "alt": "Кадр 1 из загаданного фильма" },
		"attemptedMovieIds": [],
		"winnerIds": [],
		"error": null,
		"result": null,
		"roundResult": null,
		"version": 4,
		"serverTime": 1793070000000
	}
}
```

CurrentFrame отсутствует (`null`) вне playing и у уже закончившего фильм игрока. Чужие frame indices, movie choices,
attemptedMovieIds и правильный ответ не передаются. GameResult появляется в round-result и finished и описывает текущий/последний
фильм матча, как в существующем demo. В списке игроков доступны score/status/lastAnswer без выбранного названия.

## Version, presence и ошибки

Для каждой комнаты клиент хранит последнюю version и игнорирует более старые/equal snapshots. Сервер может повторить
уведомление после сбоя: доставка at-least-once через SQL outbox. Lobby revision монотонна в пределах этой БД;
при reconnect кэш заменяется полностью. После восстановления БД из backup клиент должен сбросить прежние versions.
`serverTime` и `deadline` — Unix milliseconds; frame.index — 0–4, roundNumber — 1–N (0 в waiting).

Сервер использует native ping/pong раз в 10 секунд; браузер отвечает автоматически, JSON heartbeat не нужен.
Два sockets одного гостя в одной комнате сохраняют общее присутствие. Lobby socket или socket другой комнаты этого
не делают. Закрытие последнего room socket ставит connected=false; через 30 секунд передаётся отсутствующий host,
в waiting освобождается место, а комната без активных участников закрывается. Disconnect не равен explicit leave.

Ошибки включают INVALID_MESSAGE, UNKNOWN_EVENT, SESSION_REQUIRED, INVALID_TICKET, SESSION_EXPIRED, FORBIDDEN,
ALREADY_AUTHENTICATED, ROOM_CLOSED, RATE_LIMITED, REALTIME_UNAVAILABLE. Последняя означает временный сбой:
подписка сохраняется, outbox будет повторно обработан. Закрытие 4401 означает auth timeout/session expiry, 4429 — rate limit;
слишком большой payload закрывается стандартным ws code 1009. При HTTP upgrade с чужим Origin — HTTP 403.
Прочие сетевые закрытия требуют reconnect с новым ticket и экспоненциальной задержкой на клиенте.

JSON Schema: [`websocket.schema.json`](./websocket.schema.json). Источник: `src/contracts/contracts.ts`.

## Результат фильма и «Далее»

После общего завершения status=round-result, deadline/currentFrame=null, result содержит правильный фильм.
roundResult содержит roundId, roundNumber, личный outcome won/lost, readyPlayerIds, requiredPlayerIds,
isReady, canContinue и isLastRound. В остальных фазах roundResult=null. Пока любой участник ещё отвечает,
result и roundResult остаются null, даже у уже угадавшего игрока.

«Далее» — HTTP POST /api/v1/rooms/:roomId/ready с body `{ "roundId": "..." }`, cookie и Idempotency-Key.
WS event для команды не добавляется. Обычный room.snapshot обновляет readiness у всех участников.
После всех ready следующий loading; после последнего фильма finished/rating. Автоперехода через 5 секунд нет.
Preview не получает result/readiness. Guess/skip в round-result отклоняются без изменения score.

Required roster persisted и может только уменьшаться: explicit leave либо 30 секунд offline снимают участника
с барьера. Offline внутри grace остаётся required. Поздний reconnect не возвращает исключённого в текущий барьер;
canContinue=false. Новый roster публикуется с новой version через outbox. Restart сохраняет ready и результат,
presence получает новый reconnect grace. Точный контракт: [round results](../round-results/spec.md).

Пример персонального результата (сокращённый roster из одного оставшегося участника):

```json
{
	"event": "room.snapshot",
	"data": {
		"view": "member",
		"id": "opaque-room-code",
		"settings": {
			"name": "Компания",
			"capacity": 4,
			"filmCount": 20,
			"difficulty": "easy",
			"genre": "all",
			"mode": "points",
			"visibility": "public"
		},
		"hostId": "11111111-1111-4111-8111-111111111111",
		"players": [
			{
				"id": "11111111-1111-4111-8111-111111111111",
				"nickname": "Игрок",
				"score": 1000,
				"status": "won",
				"lastAnswer": "correct",
				"connected": true,
				"left": false
			}
		],
		"status": "round-result",
		"roundId": "22222222-2222-4222-8222-222222222222",
		"roundNumber": 1,
		"deadline": null,
		"currentFrame": null,
		"attemptedMovieIds": [],
		"winnerIds": [],
		"error": null,
		"result": {
			"title": "Матрица",
			"originalTitle": "The Matrix",
			"posterUrl": "https://image.tmdb.org/t/p/w780/example.jpg",
			"releaseYear": 1999
		},
		"roundResult": {
			"roundId": "22222222-2222-4222-8222-222222222222",
			"roundNumber": 1,
			"outcome": "won",
			"readyPlayerIds": [],
			"requiredPlayerIds": ["11111111-1111-4111-8111-111111111111"],
			"isReady": false,
			"canContinue": true,
			"isLastRound": false
		},
		"version": 4,
		"serverTime": 1793070000000
	}
}
```
