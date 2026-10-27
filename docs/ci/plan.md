# План реализации SPEC-008

Спецификация: [`spec.md`](./spec.md).

## Подход и архитектура

Инфраструктура вне FSD: `.github/workflows/ci.yml`. Игровые slices не меняются.
События: pull_request в dev/main и push в dev/main. Jobs Validate и Build независимы, запускаются на Ubuntu.
Используется актуальная Node.js 24: ранняя 24.12 несовместима с engine транзитивной зависимости nopt.
Yarn устанавливает зависимости с `--frozen-lockfile`, затем запускает `yarn validate` или `yarn build`.
Actions закреплены на commit SHA; секреты не передаются, API модели и GitHub App отсутствуют.

## Защита веток

В main/dev обязательны Validate и Build от GitHub Actions App, strict up-to-date, PR и применение правил к администраторам.
Force push и удаление запрещены. Автоматического слияния нет. Число обязательных approvals — 0:
владелец не может одобрить собственный PR. Проверки CI не заменяют ручное ревью.
Настройки защищённых веток не меняются при удалении платного AI-бота.

## Проверка и риски

`yarn validate`, `yarn build`, разбор YAML, GitHub check runs и branch protection API.
Установочный [PR №2](https://github.com/afpias/moviestr-front/pull/2) содержит CI; до его ручного слияния
workflow ещё не установлен в dev. Защита main/dev уже включена на GitHub.
Изменять CI могут доверенные участники с write-доступом; администратор организации может изменить защиту.
