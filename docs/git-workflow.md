# Git workflow Moviestr

Правило одинаково для backend и frontend. Команды ниже — инструкция для будущих согласованных операций,
а не запуск merge, push, release или cleanup в текущей задаче.

Принятый владельцем merge/release уже разрешает последующие описанные шаги: тегирование и публикацию только нужного тега,
удаление merged feature/fix branch и, после успешной публикации версии, вошедших dev-тегов.
При выполнении всех условий этой политики повторное разрешение на каждый шаг не требуется.
При изменении области работ или невыполненном условии остановиться и уточнить только это изменение.

## Постоянные ветки и рабочий цикл

- `main` и `dev` — постоянные ветки; их не удаляют. `main` содержит выпущенную историю, `dev` — принятую разработку.
- Новая работа начинается от актуальной `dev` в `feature/<name>` или `fix/<name>`.
- До PR выполняются type-check, lint, tests, format check и build, применимые к репозиторию.
- PR направляется в `dev`. После review и успешных обязательных проверок используется обычный merge commit (`--no-ff`),
  сохраняющий ancestry. Squash/rebase merge для этого workflow не применяется.
- После принятого merge и успешных проверок на его точном merge commit ставится annotated tag,
  например `dev/rooms-pr-42`. Имя содержит feature и уникальный PR number либо дату со временем/иным уникальным суффиксом.
- Публикуется только этот тег. Не использовать `git push --tags`, force-push и перемещение опубликованных тегов.
- Только после успешного merge, проверок и публикации временного тега удаляется соответствующая merged feature/fix branch
  локально и на origin. Нельзя удалять `main`, `dev`, чужую или ещё не влитую ветку.

Пример после принятого владельцем merge конкретного PR и успешных проверок; повторное подтверждение этих шагов не требуется:

```powershell
$mergeCommit = '<exact-accepted-merge-commit>'
$tagName = 'dev/rooms-pr-42'
git merge-base --is-ancestor $mergeCommit origin/dev
# Продолжать только при exit code 0 и если tagName ещё не существует локально/на origin.
git tag -a $tagName $mergeCommit -m 'Rooms: принят PR 42'
git push origin "refs/tags/$tagName"
# После успешной публикации тега, из dev, при подтверждённом merge ветки:
git branch -d feature/rooms
git push origin --delete feature/rooms
```

## Выпуск версии

1. После принятия необходимых изменений обычным merge объединить `dev` в `main`, сохранив ancestry.
   Например, согласованный release PR с merge commit; не squash/rebase merge и не cherry-pick истории dev.
2. На точном release commit `main` выполнить обязательные проверки и убедиться, что нужная dev-история достижима из него.
3. Создать annotated SemVer tag `vMAJOR.MINOR.PATCH` на этом commit и опубликовать только его ref.
4. Дождаться успешной публикации версии: обязательные release checks и выбранный процесс публикации должны завершиться.
   Одного локального тега или запуска pipeline недостаточно. CI/release infrastructure настраивается отдельной задачей.
5. Только после этого сформировать список `dev/*` тегов, достижимых из **exact commit опубликованного v-тега**.
   Удалить только этот проверенный список локально и на origin. Теги будущей разработки сохраняются.

Пример отбора кандидатов в PowerShell, без удаления:

```powershell
$versionTag = 'v1.2.3'
$releaseCommit = git rev-parse "$versionTag`^{commit}"
if ($LASTEXITCODE -ne 0) { throw 'Не найден точный release commit' }
$releaseCommit = $releaseCommit.Trim()
$candidates = foreach ($tagName in (git tag --list 'dev/*')) {
    git merge-base --is-ancestor "$tagName`^{commit}" $releaseCommit
    if ($LASTEXITCODE -eq 0) { $tagName }
    elseif ($LASTEXITCODE -ne 1) { throw 'Ошибка проверки достижимости тега' }
}
$candidates
```

Перед отбором нужен актуальный список remote dev-тегов и проверенная публикация version tag с тем же SHA.
При ошибке, несовпадении SHA или изменении remote ref очистка останавливается. Для каждого кандидата сверяется его
remote object SHA с проверенным локальным annotated tag, чтобы не удалить изменившийся или чужой ref.
После просмотра списка и проверки факта успешной публикации версии удаляется только каждый выбранный ref:

```powershell
# Для каждого заранее проверенного кандидата $tagName, начинающегося с dev/:
git push origin --delete "refs/tags/$tagName"
# Только после успешного удаления этого remote ref:
git tag -d -- $tagName
```

Не выбирать все dev-теги без ancestry check, не считать подвижную `main`/`dev` exact release commit,
не удалять `v*`, ветки или dev-теги, не вошедшие в выпущенную версию. Опубликованные теги не перемещаются.

## CI

- `dev/*`: отдельный поток проверок/временных артефактов, без production release.
- `v*`: отдельный поток с валидацией SemVer, проверки release commit и публикации версии.
- Branch PR checks выполняются до merge. Cleanup возможен только после успешной публикации версии.
- Документирование правил само по себе не создаёт CI, GitHub protection rules или автоматическую очистку.

## Текущее состояние backend

28 октября 2026 локально созданы `dev` от существующей `main` и рабочая `feature/docker-stack` от `dev`.
Существующие незакоммиченные изменения сохранены. На origin пока опубликована `main`; remote default branch не менялась.
В рамках закрепления правила merge, commits, releases, tags, branch deletion, push и PR не выполняются.

## Подготовка первого релиза, 29 октября 2026

После завершения реализации и независимого ревью владелец разрешил закоммитить накопленные изменения
и провести их через dev в main. Первый release tag — `v0.1.0`; backend package version уже `0.1.0`.
Backend dev подготавливает только локальный коммит feature/docker-stack. Публикацией, PR/merge,
annotated tags и удалением merged branches управляет координатор по правилам выше.
Эта запись дополняет историческое состояние от 28 октября и не переписывает его.
