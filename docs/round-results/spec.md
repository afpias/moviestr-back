# Результат фильма и общее «Далее»

Решение владельца от 28 октября 2026: после каждого общего завершения фильма показать правильный ответ и личный исход;
продолжать только после ready всех участников. Автопереход через произвольный timeout не нужен.

## Контракт

- Комната: waiting → loading → playing → round-result → loading … → round-result → finished.
- Результат открывается только после завершения всех не вышедших игроков или общего 90-секундного deadline.
- В round-result сохраняются текущие roundId, roundNumber, movie и личные won/lost/score; deadline=null, currentFrame=null.
- Существующий result содержит правильный фильм в round-result и finished; до общего завершения null.
- Новый nullable roundResult в member HTTP/WS snapshot:
  `{roundId,roundNumber,outcome:'won'|'lost',readyPlayerIds:string[],requiredPlayerIds:string[],isReady:boolean,canContinue:boolean,isLastRound:boolean}`.
  Вне round-result поле null. Preview не получает result/roundResult/ready state или личные данные.
- POST /api/v1/rooms/:roomId/ready строго `{roundId}`, guest cookie и Idempotency-Key, response RoomSnapshot.
  Один игрок отмечает только себя; canContinue=true только пока он required и ещё не ready.
- Последний required ready запускает следующий loading/preparation ровно один раз; после последнего фильма — finished/rating.
  Готовность не меняет score. Guess/skip вне playing отвергаются без изменений.
- Новый ключ с чужим/устаревшим roundId: 409 STALE_ROUND; не result phase: 409 ROUND_NOT_IN_RESULT;
  outsider/left: 403 FORBIDDEN; уже исключённый из барьера: 403 READY_NOT_REQUIRED; чужой playerId в body: 400.
  Тот же успешно выполненный ключ воспроизводит сохранённый ответ без нового перехода; текущие права перепроверяются.

## Барьер и disconnect

Требуемый roster фиксируется при reveal: не left и connected либо внутри существующего GRACE_MS=30000.
До всех ready барьер только сужается при explicit leave или истечении grace; поздний reconnect не возвращает игрока
в барьер текущего результата. В следующем фильме он участвует по прежним membership rules. Временный offline внутри grace
остаётся required. Если живых/в grace участников нет, применяется прежнее закрытие комнаты; это не запуск нового фильма.
После backend restart membership presence получает прежний новый grace; readiness/required roster и результат не сбрасываются.

## Хранение и совместимость

Room JSONB хранит roundReadyPlayerIds и roundRequiredPlayerIds. Старые payloads без полей читаются с пустыми массивами.
Новая SQL migration расширяет rooms_status_check; применённые миграции не изменяются. Репозитории/команды/scheduler
блокируют корневую строку комнаты, сохраняют версию, preparation и outbox атомарно. Сеть TMDB под SQL lock не вызывается.
