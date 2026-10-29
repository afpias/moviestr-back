# Проверка Docker runtime — 28 октября 2026

## Изменения backend

- `compose.yaml`: db/api/frontend, healthchecks и порядок запуска, frontend context `../moviestr-front`,
  локальные порты 8080/3000/55432 на 127.0.0.1. Существующий `moviestr-back_pgdata` сохранён.
- Docker origins выделены в `DOCKER_ALLOWED_ORIGINS`; прежний `ALLOWED_ORIGINS` в ignored `.env` не мешает 8080.
- Локальный Compose задаёт `NODE_ENV=development` для HttpOnly/Lax cookie на HTTP, используя собранный runtime.
- Optional proxy endpoints добавлены в `.env.example` и ignored локальный `.env`; TMDB token не выводился и не передавался build/frontend.
  Node env proxy используется только процессами API; NO_PROXY включает внутренние service names, TLS включён.
- `docs/git-workflow.md`, Git-раздел AGENTS и README закрепляют согласованный workflow.
  Локальные ветки `dev` и `feature/docker-stack` созданы без stash/reset; исходные незакоммиченные документы сохранены.
  Remote default main не менялась, commits/push/PR/merge/tags/releases/deletions не выполнялись.
  Принятый владельцем merge/release в будущей работе разрешает следующие предусмотренные lifecycle шаги без повторных разрешений.
- Design/plan находятся рядом в `spec.md` и `plan.md`.

## Реальная сборка API

Первая сборка воспроизвела `auth.docker.io` TLS handshake timeout в Docker Engine.
Глобальные настройки daemon и TLS не менялись. Официальный публичный `library/node:24-alpine` linux/amd64
получен через существующий Windows proxy в host-процессе; проверены SHA-256 manifest, compressed blobs и rootfs layers.
Image импортирован `docker load`, затем обычный Dockerfile успешно установил Linux dependencies и собрал TypeScript.
Вспомогательные downloads/scripts находятся только в ignored `.cache/public-images` и `.cache`.

Первичная API сборка: `moviestr-back-api:latest`, manifest ID `6d23d443a677`, runtime Node `24.22.1`.
Финальная совместная сборка переэкспортировала cache; актуальные полные image IDs приведены ниже.
Контейнер работает с UID 1000 (`node`); `.env`, TypeScript compiler и Vitest отсутствуют в runtime image, 2 SQL migrations присутствуют.
Проверенный host backend PID 41392 остановлен; порт 3000 обслуживается Docker API. Чужие процессы не останавливались.

## Проверки

- `yarn validate`: PASS — type-check, ESLint, 11 files / 50 tests, Prettier.
- `yarn build`: PASS. Автоматические PostgreSQL tests используют только `moviestr_test`.
- После возобновления 28 октября в 20:52 повторный полный `yarn validate` снова прошёл 50/50 tests; build, Compose config и diff check — PASS.
  Три сохранённых контейнера оставались healthy; backend readiness повторно подтвердился HTTP 200.
- `docker compose config --quiet`: PASS; полный config с token не выводился.
- `docker compose build api`: PASS с process-only build proxy.
- `docker compose up -d --wait db api`: PASS, оба healthy.
- Docker API `/health/live` и `/health/ready`: 200.
- Реальный поиск «Матрица» и `The Matrix` непосредственно из API container: 200, найден `tmdb-603`.
- Origin localhost:8080 и 127.0.0.1:8080, HttpOnly/Lax cookie без Secure по HTTP, CORS credentials: PASS.
- Добавлен Vite Origin `http://127.0.0.1:5173`: воспроизведено 403 до настройки, после пересоздания API — 201.
  Frontend depends_on.api.restart=true позволяет Compose управлять зависимым nginx при обновлении API.
- 17 групп живого HTTP/native WS smoke на Docker API: гостевые cookie, Origin rejection HTTP/WS,
  реальная подготовка соло, ownership, неверный ответ, refresh persistence, skip/replay/stale-frame,
  room membership/host rights, два независимых WS guests, персональные frames/attempts,
  согласованные scores, завершение матча и WS result.
- Соло подготовило «Адвокат дьявола»; матч — «Хеллбой: Герой из пекла». Итог score 900/950, победитель второй гость.
  Правильный результат не раскрывался до завершения, чужие кадры/попытки отсутствовали в snapshot.

## Инфраструктурная проверка frontend

- Frontend dev создал Dockerfile, nginx.conf и .dockerignore. Backend dev эти файлы не менял.
- Точный официальный `nginx:stable-alpine` linux/amd64 загружен тем же проверенным способом, без подмены tag.
- `docker compose build frontend`: PASS. Vue TypeScript/Vite действительно собрали assets внутри Linux build stage.
- `docker compose up -d --wait frontend`: PASS. Все три сервиса healthy.
- `http://localhost:8080`: 200, Server `nginx/1.30.6`, HTML с compiled `/assets/*.js`.
- Повторные 17 групп HTTP/native WS smoke через nginx8080: PASS, включая реальные TMDB solo/match и personal snapshots.
- Сканирование runtime frontend assets не обнаружило действующий backend TMDB token. `.env*` исключены frontend build context.
- Первоначальный infrastructure image был промежуточным; затем frontend dev сообщил об успешных validate (74 tests) и build,
  координатор зафиксировал исходники и отдельно разрешил финальную сборку. Финальный результат приведён ниже.
  Controlled restart уже проверен на инфраструктурном stack: `docker compose restart api` дождался healthy API и
  автоматически перезапустил frontend благодаря depends_on.api.restart=true. Старые sockets закрылись,
  HTTP сохранил round/frame/attempts/score, новые tickets восстановили оба WS через nginx. Матч завершился 900/950.

## Финальный stack

После отдельного сигнала координатора о готовности frontend выполнена реальная сборка из frozen исходников.
Frontend исходники, Dockerfile/nginx и его тесты принадлежат frontend dev; backend dev их не менял.

Из корня `C:/Users/nikip/Documents/Projects/moviestr` реально выполнено:

```powershell
docker compose -f moviestr-back/compose.yaml up --build -d --wait --wait-timeout 120
```

Команда завершилась exit 0. Три контейнера healthy, PostgreSQL volume `moviestr-back_pgdata` сохранён.
Выполнение запускалось с явным существующим backend workdir и дочерним Docker-процессом в указанном корне.
Токен в expanded compose config не выводился. README содержит ту же команду без необязательного timeout.

| Service  | Container                | Exact image ID                                                          | URL/port              |
| -------- | ------------------------ | ----------------------------------------------------------------------- | --------------------- |
| api      | moviestr-back-api-1      | sha256:7074a734cf89042340420e31fb35b39f0ba255763fc5041c3aacf25516a14c16 | http://localhost:3000 |
| frontend | moviestr-back-frontend-1 | sha256:d4375ae40397ff87e814481e6b5337030300d7f70fc7d2f6c934f63cf9b4b69c | http://localhost:8080 |
| db       | moviestr-back-db-1       | sha256:c7526c0f6c3f30260a563d7bcf8ad778effac59a44f8ffa86678c35418338609 | localhost:55432       |

Финальный frontend image действительно выполнил `vue-tsc --build && vite build` внутри Linux build stage,
а nginx получил новые dist assets. API успешно собран ранее и переиспользовал проверенный build cache.
На финальном `up` API/frontend пересоздались до сигнала готовности для browser E2E; после сигнала API не перезапускался.

### Проверки финального runtime

- API readiness: HTTP 200. Все три сервиса healthy.
- Контрольные 17 групп HTTP/native WS smoke через `http://localhost:8080` и `ws://localhost:8080/ws`: PASS.
- Настоящее TMDB соло: «Дежавю», неверный ответ/skip/refresh persistence, idempotent replay и stale frame rejection.
- Настоящий матч двух гостей: «Маяк», личные frames/attempts, публичные score и согласованный finished snapshot.
  Итог 900/950, победитель второй гость. Ownership, права хоста и чужие HTTP/WS Origin отклонены.
- RU/EN поиск через финальный nginx: HTTP 200, `tmdb-603` найден по обоим запросам.
- 21 файл actual frontend runtime assets проверен на действующий backend TMDB token: отсутствует.
  Frontend runtime environment также не содержит TMDB_READ_TOKEN. `.env` и локальные cache файлы остаются ignored.
- Controlled restart с сохранением progress и reconnect новых WS tickets проверен ранее на той же nginx-конфигурации,
  которая при финальной сборке была reused из Docker cache. Повторный restart во время browser E2E не выполнялся.
- Backend source, HTTP/WS contract и SQL migrations в этой задаче не менялись. Новых ошибок поведения не выявлено;
  Origin 127.0.0.1:5173 исправлен минимальной Compose настройкой с подтверждённым переходом 403 → 201.

## Границы результата

Backend часть завершена; frontend browser E2E ведут frontend dev/координатор. Этот отчёт подтверждает Docker build,
health, HTTP/native WS и secret scan, но не заявляет ручную проверку экранов в браузере или физических устройств.
Системные proxy/TLS настройки не ослаблялись. Registry TLS timeout обойдён только предзагрузкой точных официальных
public base images через существующий proxy; на чистом Docker cache по-прежнему требуется рабочий registry access.
Production/deploy, новые GitHub repos, commits, push, PR, merge, release, tags и удаление Git refs не выполнялись.
Исключение — явно разрешённое создание локальных `dev` и `feature/docker-stack` с сохранением рабочих изменений.
Backend CI остаётся не настроен; Git lifecycle и раздельные tag channels задокументированы для следующих задач.
Контейнеры оставлены запущенными, прежние документы проверки после переноса сохранены.
