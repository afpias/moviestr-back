# Повторная проверка backend после переноса — 28 октября 2026

Это новый отчёт. Первичная проверка от 27 октября в `verification.md` сохранена как история.

## Рабочие пути

- Backend: `C:/Users/nikip/Documents/Projects/moviestr/moviestr-back`.
- Frontend: `C:/Users/nikip/Documents/Projects/moviestr/moviestr-front` (`../moviestr-front`).
- В README уточнён каталог выполнения команд; в действующем integration plan заменена старая абсолютная ссылка на frontend.
- Все shell-команды этого прогона выполнялись с явным новым workdir. Метаданные исходного чата по-прежнему
  передают прежний `C:/Users/nikip/Documents/Projects/moviestr-back`; рабочие файлы туда не записывались.
- Source, API-контракты, SQL-миграции, package.json и yarn.lock не менялись. Исторические документы не переписывались.

## Восстановление окружения

- Node.js `24.21.0`, Yarn Classic `1.22.22`. Зависимости после переноса отсутствовали и восстановлены командой
  `yarn install --frozen-lockfile --offline --cache-folder C:/Users/nikip/AppData/Local/Yarn/Cache --ignore-scripts`.
- Docker Desktop при старте завершался с Windows error 1920 на старом AF_UNIX endpoint `run/dockerInference`.
  При полностью остановленных Docker-процессах сохранён весь runtime-каталог:
  `C:/Users/nikip/AppData/Local/Docker/run.stale-20261028145843`.
  На его месте создан пустой `run`, затем выполнен штатный старт Docker Desktop. Volumes, WSL-диски и settings не удалялись.
- Docker Engine `28.3.3`; `docker compose up -d --force-recreate db` пересоздал контейнер с прежним `pgdata` volume.
  Compose labels теперь указывают на новый backend-каталог. PostgreSQL 17 healthy на `127.0.0.1:55432`.
- Backend запущен из нового каталога командой `node dist/main.js`, PID `41392`, HTTP `http://localhost:3000`,
  API `http://localhost:3000/api/v1`, WS `ws://localhost:3000/ws`.
- В окружении только запущенного процесса включён `NODE_USE_ENV_PROXY=1`, HTTP_PROXY/HTTPS_PROXY получены
  из существующих Windows HKCU Internet Settings; `NO_PROXY=localhost,127.0.0.1,::1`.
  TLS verification не ослаблялась. Системные proxy settings и ignored `.env` не менялись; значения токена не выводились.
- Локальные PID/log files и вспомогательные smoke scripts находятся в ignored `.cache`.

## Команды и результаты

Все команды выполнены из нового backend-каталога:

- `yarn validate`: PASS — TypeScript, ESLint, 11 test files / 50 tests, Prettier.
- `yarn build`: PASS.
- `docker compose config --quiet`: PASS.
- `GET /health/live`: 200, `status=ok`.
- `GET /health/ready`: 200, `status=ready`, `tmdbConfigured=true`.
- Автоматические PostgreSQL integration/recovery tests работают только с `moviestr_test`, включая дочерние процессы.
  Runtime `moviestr` не подвергался TRUNCATE и не использовался вместо тестового подключения.

## Живой TMDB и HTTP/native WebSocket

Provider не подменялся. Проверено через runtime API на localhost:3000:

- Русский поиск `Матрица` и английский `The Matrix` возвращают фильм `tmdb-603`; каталог содержит `tmdb-catalog`.
- Соло реально подготовило фильм «Ганнибал», выдавая только открытый кадр w1280.
  Неверный movieId переместил кадр 0 → 1; повторное GET сохранило попытку и индекс.
  Skip переместил кадр 1 → 2; повтор с тем же ключом вернул тот же результат;
  устаревший frame получил 409. После исчерпания кадров status=lost и появился результат.
- Чужой гость получает 404 для соло и preparation operation. Общая cookie повторно восстанавливает того же гостя.
- Матч двух независимых гостей подготовил фильм «Джек Ричер» из TMDB.
  Оба гостя получили WS ticket, прошли session.auth и room.subscribe; snapshots проверялись runtime JSON schemas.
- После неверной попытки хост получил frame=1 и личную историю, второй гость остался на frame=0 с пустой историей.
  Чужой открытый кадр не присутствовал в его snapshot. Общая таблица score стала 950/1000.
- Refresh восстановил личные кадры/попытки; устаревшая команда получила 409.
  После завершения первым игроком второй продолжал видеть только свой кадр и не видел результат фильма.
- Матч завершён обоими игроками через skip: score=900/950, winnerIds содержит второго гостя;
  HTTP и оба WS клиента получили согласованный finished snapshot.
- HTTP mutation и WS upgrade с чужим Origin отвергнуты с 403.
  Постороннему участнику запрещены room ticket и игровая команда; не-хосту запрещён start.
- Дополнительный live smoke: 17 групп assertions PASS.
- HEAD всех пяти реальных кадров подготовленного соло: 200 и Content-Type image/*.
  Во время прогона появилось 2 свежих OCR cache entries; это подтверждает вызов OCR на реальных изображениях,
  но не гарантирует семантическую точность распознавания. Разрешённый fallback при budget/error остаётся частью контракта.

## Ограничения и границы

- Проверка выполнялась HTTP-клиентом и двумя native WS sockets на одном компьютере; физические устройства и Vue E2E не проверялись.
- Frontend не менялся и заново не подключался. Production Docker image, hosting и deployment не проверялись.
- Программных дефектов backend этот прогон не выявил, новых regression tests не потребовалось.
- Backend и PostgreSQL оставлены запущенными. Backend PID относится к этому запуску и изменится при restart.
- Push, PR, новые внешние репозитории и production-действия не выполнялись.
