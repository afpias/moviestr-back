# Проверка result/all-ready — 29 октября 2026

## Реализовано

- Persisted `round-result` после общего завершения каждого фильма, включая последний. Правильный `result` и личный
  `roundResult.outcome` доступны только после all done/deadline. Ранний won/lost не раскрывает ответ другим/себе до общего reveal.
- POST `/api/v1/rooms/:roomId/ready`, строго `{roundId}`, cookie и Idempotency-Key. Гость подтверждает только себя.
  Барьер сохраняет roundId/roundNumber, result, score/outcome, ready/required player IDs в PostgreSQL JSONB.
- Все required ready → следующий loading/preparation ровно один раз; последний фильм → finished/rating после ready.
  Нет искусственного timeout авто-continue. Guess/skip в result не изменяют состояние/score.
- Explicit leave и 30-секундный offline grace сужают required roster. Late reconnect не возвращает waived участника.
  Presence сначала учитывает истёкшую eligibility, затем отмечает reconnect; изменения сохраняются и публикуются с новой version.
- Новая migration `003_round_result.sql` расширяет SQL status CHECK. `001`/`002` не изменялись.
  Старые JSON без новых полей читаются с безопасными пустыми массивами; новые поля заполняются при новом reveal.
- Обновлены строгие Zod HTTP/native WS schemas, OpenAPI JSON, WS JSON schema и примеры, frontend handoff/spec/design/tasks.
  Поля/endpoint совпадают с переданным frontend контрактом, после handshake не менялись.

## RED → GREEN и проверки

1. Два первоначальных RED теста получили `loading` и `finished` вместо ожидаемого `round-result`.
2. После реализации оба GREEN; расширенные domain tests покрывают all-ready, last film, deadline, no auto-timeout,
   no-score mutation, stale/foreign ready, grace boundary, late reconnect, explicit leave и abandoned close.
3. Настоящий PostgreSQL HTTP/WS integration проверяет:
   - cached replay и разные ключи без лишней версии/очков;
   - одновременные acknowledgements/duplicate last-ready без второго перехода/preparation;
   - scheduler deadline и ready/grace races;
   - outsider/left/preview, body spoofing, stale round и ready вне result;
   - refresh/new application, новые WS tickets и reconnect;
   - versioned WS публикацию required roster shrink;
   - старые persisted JSON payloads без новых массивов.
4. Hard-process test убивает собственный дочерний API после reveal и ready первого гостя, запускает новый процесс,
   проверяет тот же результат/round/ready/score и продолжение после второго ready.
5. Прежние 50-film, multi-film, server interval, race/recovery и winner tests обновлены на явный ready.
6. `yarn validate` 29 октября, начало 08:50: PASS — type-check, ESLint, 13 files / 69 tests, Prettier.
7. `yarn build`: PASS. Отдельный `yarn test:unit`: 5 files / 34 tests PASS.
8. Контракты экспортированы `yarn openapi`; deterministic JSON и все WS-примеры проверены contract tests.
9. Координатор передал результат read-only core review: существенных дефектов не обнаружено;
   reviewer не запускал БД/Docker. БД/restart проверки перечислены выше и выполнены backend dev.

## Восстановление окружения после перерыва

Первый свежий validate не прошёл из-за выключенного Docker Engine/ECONNREFUSED 55432; это не было заявлено как PASS.
Перед этим прогон 28 октября прошёл 69 tests, но остановился на форматировании service; форматирование исправлено.

Docker Desktop повторил Windows AF_UNIX runtime socket crash на dockerInference. При подтверждённо остановленных
Docker-процессах сохранён только runtime directory под резервным именем:
`C:/Users/nikip/AppData/Local/Docker/run.stale-20261029084425`, затем штатно запущен установленный Desktop скрыто.
Volumes/WSL disks/settings не удалялись, factory reset/prune/down-v не применялись.

Windows зарезервировала диапазон 55418–55517, включающий прежний 55432; listener не был причиной.
По отдельному согласованию проверен свободный bind 127.0.0.1:5433 и параметризован Compose mapping
`${POSTGRES_PORT:-55432}`. В ignored `.env` согласованы POSTGRES_PORT=5433 и host DATABASE_URL/TEST_DATABASE_URL;
секреты не выводились. `.env.example`/README обновлены. Test helper читает `.env`, но сохраняет обязательный `_test` guard.
API внутри Docker по-прежнему использует `db:5432`.

Только DB контейнер пересоздан разрешённым исключением для тестов: `docker compose up -d --no-deps --wait db`.
`moviestr-back-db-1` healthy, host `127.0.0.1:5433`, volume прежний `moviestr-back_pgdata`.
В `moviestr_test` подтверждены все три schema migrations. Тесты не очищали runtime `moviestr`.

## Handshake и финальный Docker этап

Координатор передал отдельный frontend freeze: frontend dev подтвердил validate PASS (96 tests), build PASS,
reviewer findings закрыты. Backend dev единолично выполнил финальную сборку API/frontend и запуск всех сервисов.
Из корня `C:/Users/nikip/Documents/Projects/moviestr` реально выполнено:

```powershell
docker compose -f moviestr-back/compose.yaml up --build -d --wait --wait-timeout 120
```

Команда завершилась exit 0. API и Vue действительно скомпилированы внутри Linux Docker build stages;
frontend включает новый show-round-result chunk. API автоматически применил migration003 в runtime `moviestr`;
SQL SELECT подтвердил 001/002/003. Это runtime migration, а не очистка runtime DB тестами.

| Service  | Exact image ID                                                          | Endpoint              |
| -------- | ----------------------------------------------------------------------- | --------------------- |
| api      | sha256:44ac5df38bb749b5ff594abd8eefbbfcd76e0d93a105f9106f1498b87c56efe8 | http://localhost:3000 |
| frontend | sha256:47f3987f3a4bae64ef7074fe5fea7182f63456fc8898317d65e6c3d9118a6970 | http://localhost:8080 |
| db       | sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609 | localhost:5433        |

Все три контейнера healthy, web8080 HTTP200; точные IDs и готовность переданы координатору в commentary
до browser E2E. После этого API не перезапускался. Named volume остался `moviestr-back_pgdata`.
API внутри Docker по-прежнему использует `db:5432`, локальные env URLs — 5433.

## Живой финальный result/all-ready smoke

Prepared script `.cache/verify-round-results.cjs` запущен только на новом runtime через nginx8080;
предыдущий runtime этим скриптом не проверялся. Provider не подменялся. 11 групп assertions PASS:

- Фильм 1 «Прометей»: пока второй гость отвечал, первый видел playing без result/roundResult.
- После общего завершения оба HTTP/native WS клиента получили round-result, правильный фильм и личный lost.
  Deadline/currentFrame=null, required IDs обоих гостей, ready IDs пусты, рейтинг ещё не финальный.
- Проверка ожидания более 5 секунд подтвердила отсутствие auto-continue.
- Guess/skip, outsider ready, spoofed playerId и stale round отвергнуты без изменения версии/score.
- Первый ready сохранился после HTTP refresh и нового WS ticket/reconnect; повтор того же ключа воспроизвёл ответ,
  новый ключ того же уже ready игрока не создал лишнюю version/готовность.
- Только ready второго гостя начал loading второго фильма; replay последнего ready не повторил переход.
- Фильм 2 «Секреты Лос-Анджелеса»: повторно проверены private early outcome, общий reveal, guards и refresh/reconnect.
- После последнего ready открыт finished/rating, winnerIds содержит второго гостя, score=850/900.
  Готовность не добавила и не списала очки. Оба WS клиента получили final snapshot.
- `roundId` различался между фильмами и сохранялся во время каждого результата.

Smoke room `Dk5e48CSIpda`, round IDs `f3b4e70a-cf5b-48a1-9d06-ffe160b306c2` и
`f1a877a6-dfa1-414c-bd8c-e913ecdfb952`; эти идентификаторы не являются session/ticket credentials.

## Security и границы

22 actual frontend runtime assets просканированы на действующий backend TMDB token: отсутствует.
Frontend runtime environment не содержит TMDB_READ_TOKEN. Runtime OpenAPI содержит ready endpoint и новую фазу/поле.
`.env` и локальные smoke/cache остаются ignored; token не выводился в config/log и не передавался frontend build.
TLS/proxy protections не ослаблялись. DB volume сохранён, системные Windows exclusions и WinNAT/HNS не изменялись.

Backend implementation/API tests/build/Docker/live smoke завершены. Ручной browser E2E принадлежит frontend dev/координатору;
этот отчёт подтверждает HTTP/native WS и не подменяет визуальную проверку экранов или физических устройств.
Дополнительный результат frontend browser E2E передан координатором после его фактических проверок:
won/lost, общий all-ready, refresh/reconnect и последний рейтинг 1200/1000 — PASS;
solo stable DOM и styled paints — PASS; 90 snapshots без leaks/errors.
Это отдельный browser-сценарий frontend dev/координатора, а не повтор собственного HTTP smoke со счётом 850/900.
Backend dev browser E2E не запускал; сведения здесь явно атрибутированы координатору.
Runtime restart новой result-фазы покрыт настоящим hard-process тестом на PostgreSQL; дополнительный Docker restart
во время browser E2E не выполнялся. Source/frontend code backend dev не менял.
Production/deploy и новые агенты не создавались. Во время реализации накопленные изменения сохранялись без Git операций.
29 октября владелец разрешил локальный коммит всех релевантных изменений на feature/docker-stack;
push, PR, merge, tags и удаление веток выполняет координатор отдельным этапом.
Контейнеры оставлены запущенными.

## Независимое ревью перед локальным коммитом, 29 октября

Координатор передал завершённое независимое ревью полного backend diff от `7a150bd`, выполненное reviewer_back
по согласованной reviewer роли с адаптацией к NestJS. Подтверждённых замечаний P0–P3 нет.
Накопленные исходники, migration, контракты, тесты и документация подготовлены к разрешённому локальному коммиту.
Последние проверки: validate 69/69, build, Docker/runtime/live smoke и secret scan — результаты выше;
после них код не менялся. Повторные дорогие прогоны для документального checkpoint не выполнялись.
