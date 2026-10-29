# План Docker runtime и Git workflow

Исполнение: текущий backend dev, без дополнительных агентов. Основание: [spec.md](spec.md).

## Задачи

- [x] Зафиксировать Git workflow в `docs/git-workflow.md`, Git-секции AGENTS и README без публикации Git refs; создать только согласованные локальные dev и feature/docker-stack.
- [x] Добавить frontend service, startup health dependencies, отдельные Docker origins и optional proxy env в Compose.
- [x] Проверить сборку API image и frontend image; frontend Dockerfile/nginx готовит соседний frontend dev.
- [x] Корректно освободить порт 3000 от проверенного host backend, поднять три сервиса без удаления volume.
- [x] Повторить `yarn validate`, `yarn build`, Compose config и живые сценарии через Docker runtime.
- [x] Обновить README с запуском из корня `moviestr` и добавить фактический verification report.

## Проверяемые условия

- Старый ignored `.env` содержит ALLOWED_ORIGINS без 8080: новый Compose должен всё равно принимать 8080.
- Пустой token приводит к неготовому API; healthcheck не должен создавать ложный ready.
- Proxy должен обходить service names и не использовать контейнерный 127.0.0.1 для доступа к Windows proxy.
- При повторном compose up сохраняются данные PostgreSQL; build context не содержит `.env` или caches.
- Примеры очистки dev-тегов не должны выбирать v-теги или dev-теги вне истории exact release commit.

Проверки конфигурации выполняются реально через Compose build/up/inspect и HTTP/WS smoke.
Для чисто документального Git policy и обратимых Compose правок синтетические unit tests не добавляются.
Если runtime выявит программную ошибку, сначала воспроизводим её регрессионным тестом.

Финальная проверка: backend 50/50 tests, validate/build PASS; API/frontend images собраны, три контейнера healthy.
Финальный frontend пересобран после отдельного сигнала о его validate (74 tests) и build. Через nginx8080 повторно
прошли 17 групп HTTP/WS smoke, реальный TMDB RU/EN search и secret scan. Controlled API restart/reconnect доказан.
Полные image IDs, команда запуска, результаты и ограничения находятся в `verification.md`.
Dockerfile/nginx в соседнем repo backend dev не менял. Browser E2E ведёт frontend dev/координатор.
