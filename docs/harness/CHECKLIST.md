# Checklist — вопросы из видео и наши ответы

Чек-лист из разбора Harness Engineering. Каждый пункт — не «да/нет», а место в коде, которое можно проверить.

## Лимиты и управление

| Вопрос | Ответ | Где |
| --- | --- | --- |
| Лимиты итераций в коде или в промпте? | В коде: `steps`, таймауты, бюджеты, лимит попыток | `.opencode/agents/fa.md`, `scripts/fa/config.mjs`, `scripts/fa/loop.mjs` |
| Есть kill switch? | Да, три уровня: переменная, файл, dispatch | [GOVERNANCE.md](GOVERNANCE.md) |
| Можно ли остановить агента, не заходя в CI? | Да, файл `FA_STOP` в корне | `scripts/fa/config.mjs` |
| Ограничен ли доступ к внешнему миру? | Да: `webfetch`, `websearch`, `external_directory` запрещены агенту | `opencode.jsonc`, `.opencode/agents/fa.md` |
| Запрещены ли необратимые действия? | Да: push, merge, deploy, publish, удаление | `opencode.jsonc`, `AGENTS.md`, `.githooks/pre-push` |

## Проверки и качество

| Вопрос | Ответ | Где |
| --- | --- | --- |
| Есть инварианты, которые не может обойти модель? | Да, 12 проверок в `scripts/verify.mjs` | [VERIFICATION.md](VERIFICATION.md) |
| Проверки запускает агент или оркестратор? | Оркестратор, после агента | `scripts/fa/loop.mjs` |
| Есть автоматический замер при смене модели? | Да, `npm run fa:eval -- --suite model` | [PROMPTS.md](PROMPTS.md) |
| Замер сравнивается с эталоном? | Да, baseline в `PROMPTS.md` | [PROMPTS.md](PROMPTS.md) |
| Промпты версионируются? | Да, версия в промпте задачи и в документе | [PROMPTS.md](PROMPTS.md) |
| Можно ли откатить промпт? | Да, промпт живёт в git; откат — revert коммита | [PROMPTS.md](PROMPTS.md) |
| Успех доказан состоянием, а не словами? | Да: diff + `verify`; пустой diff = провал | `scripts/fa/loop.mjs` |
| Есть независимый review? | Да, сабагент `fa-reviewer` для `review: required` | `.opencode/agents/fa-reviewer.md` |
| Может ли агент подыграть себе? | Нет: он не правит очередь, проверки и harness | `scripts/fa/policy.mjs` |

## Контекст и состояние

| Вопрос | Ответ | Где |
| --- | --- | --- |
| Контекст собирается под задачу? | Да: `files`, `context`, `acceptance`, skill | `scripts/fa/loop.mjs`, [CONTEXT.md](CONTEXT.md) |
| Есть компакция длинной сессии? | Да, `compaction` в конфиге | `opencode.jsonc` |
| Есть «дыра в состоянии»? | Закрыта: очередь и git — источник истины | [CONTEXT.md](CONTEXT.md) |
| Агент может «запомнить» и потерять? | Нет: прогресс только в коммитах и `TASKS.md` | [LIFECYCLE.md](LIFECYCLE.md) |
| Контекст не раздут? | `AGENTS.md` ≤ 240 строк, harness-документы ≤ 400 | `scripts/verify.mjs` |

## Наблюдаемость

| Вопрос | Ответ | Где |
| --- | --- | --- |
| Видно, что агент делал? | Да: JSONL событий, stderr, verify-отчёт | [OBSERVABILITY.md](OBSERVABILITY.md) |
| Видно стоимость и токены? | Да, `metrics.mjs` и `summary.json` | [OBSERVABILITY.md](OBSERVABILITY.md) |
| Детектятся повторные вызовы? | Да, флаг `repeated_calls` | `scripts/fa/metrics.mjs` |
| Есть алерты? | Да: issue на блокировку и инфра-провал | `.github/workflows/fa.yml` |
| Логи не содержат секретов? | Да: redaction и запрет чтения `.env` | `scripts/fa/policy.mjs` |

## Процесс

| Вопрос | Ответ | Где |
| --- | --- | --- |
| Агент пушит в main? | Нет, только в `fa/work` и только через PR | [GOVERNANCE.md](GOVERNANCE.md) |
| Merge делает человек? | Да, auto-merge выключен | [GOVERNANCE.md](GOVERNANCE.md) |
| Задача = один PR? | Да, один коммит на задачу в rolling PR | [LIFECYCLE.md](LIFECYCLE.md) |
| Провал не блокирует весь проект? | Да, откат, попытка, затем `[!]` и следующая задача | [LIFECYCLE.md](LIFECYCLE.md) |
| Работа не теряется при падении раннера? | Коммит и push после каждой задачи | `scripts/fa/loop.mjs` |
| Есть бюджет на запуск? | Да, время + токены + лимит задач | [EXECUTION.md](EXECUTION.md) |
| Зависимости не растут? | Да, проект dependency-free, `npm install` запрещён | `AGENTS.md`, `scripts/verify.mjs` |

## Что осталось за человеком

- Вкус, продукт, UX и тексты.
- Merge PR и приёмка замеров.
- Разблокировка `[!]` и решение конфликтов.
- Смена модели и правка harness.
- Любое необратимое действие: deploy, публикация, миграция данных.

Это не пробел, а граница: harness автоматизирует проверяемое, а не присваивает решения, которые требуют ответственности.
