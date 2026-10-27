# План SPEC-007

Статус: реализовано. [Спецификация](./spec.md).

- `server/tmdb-proxy.ts` — Web Request/Response обработчик с allowlist, таймаутом и безопасными ошибками.
- `api/tmdb.ts` — единственная серверная функция Vercel, читает `process.env.TMDB_READ_TOKEN`.
- `api/tsconfig.json` — серверные Node-типы; ESM-импорт использует путь `.js` для скомпилированного модуля.
- `server/vite-tmdb-plugin.ts` — локальный серверный адаптер для dev и preview без токена в frontend.
- `shared/api/tmdb/client.ts` — same-origin транспорт; валидация данных и логика каталога сохраняются.
- `vercel.json` — rewrites API отдельно от SPA, Vite build и `dist`.

Новых runtime-зависимостей не требуется. Серверная инфраструктура находится вне frontend FSD-слоёв.
Токен передаётся в Vercel Environment Variables без вывода в терминал. Деплой выполняется после validate/build.

Проверки: unit-тесты обработчика, маршрутные тесты, сборка без клиентского секрета, публичные HTTP smoke-проверки.
Риски: недоступность TMDB из региона функции, отсутствие Vercel-входа, OCR CDN и медленные upstream-ответы.
