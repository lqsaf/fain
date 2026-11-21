# Operating — как запускать, останавливать и чинить FA

FA живёт в GitHub Actions и не требует ноутбука. Этот документ — инструкция для человека: первый запуск, ежедневная эксплуатация, аварийная остановка и разбор поломок.

## Что нужно один раз

1. **Ключи провайдеров.** `Settings → Secrets and variables → Actions → New repository secret`.
   Добавьте хотя бы один `GEMINI_API_KEY` (cross-provider fallback для кодовых ролей) и `NVIDIA_API_KEY` либо `NVIDIA_NIM_API_KEY` (основной провайдер всех ролей). Для ротации Gemini можно добавить `GEMINI_API_KEY_2` … `_5`.
   Задайте repository variables `FA_NVIDIA_RPM`, `FA_NVIDIA_TPM`, `FA_NVIDIA_RPD` по квоте вашего NVIDIA API key: публичная документация не задаёт универсальный лимит для всех Catalog endpoints и аккаунтов.
   Если ключа провайдера нет, его модели пропускаются; preflight требует хотя бы одну доступную модель на каждую роль.
2. **Модели.** В `Actions → FA → Run workflow` можно отдельно выбрать planner, executor, repair и reviewer; `inherit` означает стандартный роутинг из `scripts/fa/models.mjs`. Расписание использует только стандартный роутинг и code-owned лимиты времени: repo variables `FA_MODELS`, `FA_TASK_TIMEOUT_MIN`, `FA_RUN_BUDGET_MIN`, `FA_MODEL_TIMEOUT_MIN` и `FA_REPAIR_TIMEOUT_MIN` не передаются. Старые `FA_*_MODEL` repo variables также игнорируются. Локальный запуск может задавать `FA_MODELS` и `FA_*_TIMEOUT_MIN` через окружение.
3. **Права.** В `Settings → Actions → General → Workflow permissions` разрешить `Read and write permissions`.
4. **Branch protection для `main`.** Только PR, обязательный check `fa-verify`, запрет force-push и удаления, обязательное одобрение Code Owner для совпавших с `CODEOWNERS` файлов. Merge делает человек. Заблокированная задача теперь завершает FA job с ошибкой, чтобы `done=0, blocked>0` не выглядело успешным запуском.
5. **Опционально `FA_PAT`.** Fine-grained token с правами `contents`, `pull-requests`, `issues`. Нужен, чтобы PR, созданный FA, запускал проверки: push с `GITHUB_TOKEN` не триггерит другие workflow.
6. **Включение.** Переменная `FA_ENABLED`:
   - не задана или `true` — FA работает;
   - `false` — новый запуск не стартует.

После этого расписание `0 * * * *` запускает ровно одну задачу, если очередь не пуста и нет стоп-сигнала. GitHub может задержать cron; долгий job также занимает общую concurrency-группу.

Раз в квартал `FA quarterly harness audit` создаёт issue с чек-листом пересмотра таймаутов, квот, scaffolding, telemetry и branch protection. Workflow не запускает модели и не меняет конфигурацию автоматически.

## Переменные

| Переменная | По умолчанию | Смысл |
| --- | --- | --- |
| `FA_MODELS` | пусто, стандартный список из кода | локальный override общей цепочки; стандартные кандидаты дополняют fallback, провайдеры вне Google/NVIDIA отфильтровываются; не применяется в Actions |
| `FA_ENABLED` | включено | глобальный выключатель |
| `FA_TASK_TIMEOUT_MIN` | `90` | таймаут одной задачи |
| `FA_RUN_BUDGET_MIN` | `240` | бюджет времени запуска |
| `FA_MODEL_TIMEOUT_MIN` | `60` | максимальное время одного модельного вызова |
| `FA_REPAIR_TIMEOUT_MIN` | `30` | общий лимит repair-фазы, включая fallback; допустимо 1–30 минут |
| `FA_PREFLIGHT_MODEL_TIMEOUT_MIN` | `2` | таймаут одного вызова при явном model-capability probe |
| `FA_MAX_ATTEMPTS` | `2` | попыток на задачу |
| `FA_TOKEN_BUDGET` | `2000000` | токен-бюджет запуска |
| `FA_MAX_INFRA_FAILURES` | `3` | инфра-провалов подряд до остановки |
| `OPENCODE_VERSION` | `latest` | версия CLI (лучше запинить) |

Секреты и переменные не хранятся в репозитории. В `.env` и `.dev.vars` FA не заглядывает.

При `inherit` кодовые роли имеют разные NVIDIA-предпочтения; их Google fallback упорядочен Gemini 4 Hydrogen → 3.8 Flash → 3.6 Flash → 2.5 Flash. Явно помеченные `area: simple` задачи с текстовыми файлами используют Nemotron 3.5 Lightning → Gemini 3.5 Flash-Lite → Gemini 3.1 Flash-Lite; они не попадают в кодовые роли. Суточная квота standard Google общая для моделей группы (5 RPM, 250000 TPM, 20 RPD); Lite использует отдельную группу (15 RPM, 250000 TPM, 500 RPD). Явный выбор роли в форме workflow меняет её предпочтение только внутри разрешённой роли и каталога.

Для явной диагностики модельных способностей запустите `npm run fa:doctor -- --probe-capabilities`. Команда вызывает каждую модель с доступным ключом, записывает pass/fail, latency и usage в `fa/eval`, но не меняет порядок fallback. Это платный probe; стандартный preflight остаётся без дополнительных вызовов моделей, чтобы не расходовать квоты на каждом часовом запуске. NVIDIA не задаёт один лимит, общий для всех моделей и API keys; выставить фактические `FA_NVIDIA_RPM`, `FA_NVIDIA_TPM`, `FA_NVIDIA_RPD` в repository variables по лимитам аккаунта. Роутер применяет указанные caps совместно на всей NVIDIA quota group.

Плановое расписание не сбрасывает breakers. Выбор в ручной форме workflow сбрасывает сохранённые auth-breakers, чтобы после исправления/замены ключа провайдер сразу перепроверился.

## Первый запуск

1. Смержить harness-PR в `main`.
2. Открыть `Actions → FA → Run workflow`, выбрать `mode=run`.
3. Дождаться первого PR из `fa/work` в `main`.
4. Проверить, что `fa-verify` зелёный, diff минимален, acceptance выполнен.
5. Смержить PR. Следующий запуск продолжит с той же веткой или начнёт её заново после merge.

`mode=run` и `mode=once` делают одно и то же — одну задачу; `once` оставлен для совместимости.

## Остановка

| Способ | Что делает | Когда использовать |
| --- | --- | --- |
| `FA_ENABLED=false` | новый запуск не стартует | планово, на ночь, на время отпуска |
| файл `FA_STOP` в корне | запуск завершается после текущей задачи | аварийно, без доступа к Settings |
| `workflow_dispatch` → `mode=stop` | отменяет активные запуски | срочно |
| Cancel job в UI | мгновенная остановка процесса | совсем срочно |

Текущая задача при остановке может остаться незакоммиченной: рабочее дерево раннера уничтожается, очередь не меняется. Это безопасно.

После аварийной остановки:

1. Проверить `fa/work` и открытый PR.
2. Скачать artifact `fa-logs-<run>`.
3. Найти `summary.json` и `run.jsonl`.
4. Убрать причину, снять `FA_STOP`, вернуть `FA_ENABLED=true`.

## Ежедневная эксплуатация

- Смотреть открытый PR `fa/work → main`. Один rolling PR, тело обновляется после каждой задачи.
- Смотреть `fa/logs/STATUS.md` в artifact: очередь, последний запуск, попытки.
- Смотреть issues с заголовком `FA blocked:` и `FA infrastructure failure`.
- Не редактировать `fa/work` вручную во время работы FA: `concurrency: fa-loop` не даст двум запускам пересечься, но локальные правки могут конфликтовать.
- Задачи добавлять в `TASKS.md` через PR в `main`. FA не меняет очередь.

## Локальный запуск

Локально FA нужен для отладки harness, а не для постоянной работы.

```bash
export GEMINI_API_KEY="..."        # не коммитить
export NVIDIA_API_KEY="..."      # не коммитить
npm run fa:preflight
npm run fa -- --force-local --once
```

Требования: Node 22+, OpenCode в `PATH`, чистый worktree. Без `--force-local` оркестратор откажется работать вне CI, чтобы не утащить незакоммиченные правки. `--no-push` оставляет коммиты локально.

## Как читать логи

```text
fa/logs/<run>/
├── run.jsonl          события оркестратора
├── <task>.jsonl       события OpenCode (JSONL)
├── <task>.err.log     stderr процесса
├── verify-<task>.json результат инвариантов
├── traces.otlp.json  spans для внешней OTLP-системы
└── summary.json       итог запуска
```

`summary.json` — первое, что нужно открыть. В нём: задача, попытка, длительность, шаги, токены, изменённые файлы, причина остановки.

Каждая строка `run.jsonl` содержит `correlationId`. События одной попытки задачи (включая `model.start`, `model.infra`, `model.fallback` и `model.done`) имеют одинаковый ID; события запуска вне попытки используют `<runId>:run`. В Actions можно искать `[corr:<id>]`, а в JSONL — фильтровать по точному полю `correlationId`.

## Типовые поломки

| Симптом | Причина | Что делать |
| --- | --- | --- |
| `preflight: opencode not found` | CLI не установлен | проверить шаг установки, версию, PATH |
| `Database is not empty and has no session table` | битое локальное состояние OpenCode | переустановить CLI или очистить data-dir; к репозиторию отношения не имеет |
| `no changes after DONE` | агент ничего не сделал | смотреть `<task>.jsonl`; уточнить acceptance; задача уйдёт в `[!]` после попыток |
| `protected harness files changed` | агент правил harness | откат автоматический; проверить, не слишком ли широкое `files:` |
| `verify` падает на i18n | забыт ключ в одном языке | добавить во все три локали |
| `verify` падает на HTML | `getElementById` без элемента | синхронизировать HTML и JS |
| PR не запускает checks | push сделан `GITHUB_TOKEN` | добавить `FA_PAT` |
| запуск не стартует | `FA_ENABLED=false`, `FA_STOP`, пустая очередь | проверить gate в workflow |
| 401 от провайдера | секрет не задан или отозван | обновить secret, перезапустить; при наличии второй модели FA переключится сам |
| 429/quota от провайдера | исчерпан лимит модели | FA перейдёт к следующей модели из `FA_MODELS`; если все исчерпаны — задача останется `[ ]` |
| задача вечно `[~]` | ручной claim без запуска | оркестратор сбросит stale claim при старте |

## Стоимость

- Один запуск = одна задача, ограничен `FA_RUN_BUDGET_MIN` и `FA_TOKEN_BUDGET`.
- Одна задача ограничена `FA_TASK_TIMEOUT_MIN` и `steps` агента.
- Watchdog не создаёт параллельные запуски: `concurrency: fa-loop`.
- Пустая очередь не тратит токены: gate завершает job до запуска модели.
- Квота одной модели не останавливает шаг: FA переключается на следующую из `FA_MODELS`.
- При Gemini quota FA сначала пробует следующий заданный Gemini key, затем переходит к следующей модели.
- После трёх одинаковых наблюдений в двух разных задачах за 90 дней FA создаёт одно дедуплицированное issue-предложение по harness; очередь `TASKS.md` не меняется автоматически.
- При смене моделей сначала прогнать `npm run fa:eval -- --suite model`, потом менять `FA_MODELS`.

## Обновление harness

Файлы из списка `scripts/fa/policy.mjs` меняет только человек через отдельный PR. FA не может их править: это проверяется до и после агента. После изменения harness:

```bash
npm run verify
npm run fa:preflight
```

Если меняется промпт или модель — зафиксировать замер в [PROMPTS.md](PROMPTS.md).

## Контакты и эскалация

- Блокировка задачи → issue `FA blocked: Txx`.
- Инфра-провал → issue `FA infrastructure failure`.
- Безопасность → [GOVERNANCE.md](GOVERNANCE.md), затем отзыв секретов и остановка запусков.
