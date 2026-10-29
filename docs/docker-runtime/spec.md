# Docker runtime и Git workflow

Статус: согласовано владельцем 28 октября 2026, реализация в текущем backend-репозитории без новых агентов.

## Решения

- `compose.yaml` в backend управляет `db`, `api`, `frontend`. Frontend build context — `../moviestr-front`,
  Dockerfile и nginx принадлежат frontend dev. HTTP `localhost:8080` проксирует `/api/v1` и `/ws` в `api:3000`.
- PostgreSQL 17 сохраняет существующий named volume `pgdata` и loopback host port `${POSTGRES_PORT:-55432}`.
  После Windows reservation 29 октября локально выбран 5433; внутри Docker остаётся db:5432.
  API debug port `127.0.0.1:3000`; перед стартом проверяется и останавливается только известный host backend.
- API readiness healthcheck проверяет БД и наличие TMDB token. Frontend стартует после healthy API, API — после healthy DB.
- Собранные production assets/runtime запускаются локально с `NODE_ENV=development`: HTTP cookie не должна получать Secure.
  Это локальная конфигурация, production HTTPS/hosting в задачу не входит.
- Compose использует отдельный `DOCKER_ALLOWED_ORIGINS`, поэтому прежний `ALLOWED_ORIGINS` из `.env` не скрывает origins 8080.
- TMDB token доступен только runtime environment API. Он не передаётся frontend или build args.
  Опциональные proxy-переменные используют `host.docker.internal`; NO_PROXY включает localhost, db, api, frontend.
  TLS проверяется, глобальные настройки Docker daemon не меняются.
- Постоянные ветки `main` и `dev`, feature/fix от dev, checks и PR в dev. После принятого merge и checks —
  annotated уникальный `dev/<feature>-pr-<number>` на merge commit; затем удаление только merged feature/fix branch.
- Принятый владельцем merge/release разрешает предусмотренные последующие шаги тегирования/очистки без повторных подтверждений.
  Все проверки и границы refs обязательны; эта задача не выполняет операции на remote.
- Release — обычный merge dev в main с сохранением ancestry, checks и annotated SemVer tag.
  Только после успешной публикации версии удаляются dev/* tags, являющиеся предками exact release commit.
  Документируем процедуру; сейчас push, PR, merge, release и tag cleanup не выполняются. По отдельному уточнению владельца
  разрешены только локальные dev от main и feature/docker-stack от dev, без потери рабочих изменений.

## Приёмка

- Реально собраны API/frontend images, три сервиса healthy, прежний volume сохранён.
- Validate/build проходят с настоящей отдельной *_test PostgreSQL базой.
- Docker runtime проходит health, реальный TMDB search/solo, HTTP/native WS, Origin и ownership checks.
- Описан один воспроизводимый compose command, env/proxy и ограничения.
