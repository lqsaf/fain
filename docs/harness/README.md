# FA harness — свободный агент

**FA (free agent)** — обвязка вокруг модели, которая позволяет проекту развиваться без человека и без его ноутбука. Человек пишет задачи в `TASKS.md` и ревьюит PR; FA непрерывно берёт задачи, проверяет себя и складывает результат в ветку `fa/work`.

Это не «ночник» и не cron-задача. Внутри одного запуска GitHub Actions работает непрерывный цикл: задача → проверка → коммит → следующая задача. Watchdog раз в 15 минут поднимает цикл заново, если он завершился по таймауту. Пока не остановлен — работа продолжается.

## Семь слоёв (ETCLOVG)

Таксономия из обзора Agent Harness Engineering, разобранная в видео Дмитрия Березницкого «Prompt Engineering Is Dead as a Profession».

| Слой | Что это | Где реализовано |
| --- | --- | --- |
| **E** Execution | где и в каких рамках исполняется агент | `.github/workflows/fa.yml`, `scripts/fa/loop.mjs`, лимиты в `scripts/fa/config.mjs` |
| **T** Tools | инструменты, схемы, контракт ошибок | `scripts/verify.mjs`, `scripts/fa/*.mjs`, `.opencode/commands/*`, allowlist в `policy.mjs` |
| **C** Context | что видит модель: короткий, сессионный и постоянный контекст | `AGENTS.md`, `docs/CONVENTIONS.md`, `.opencode/skills/fain/SKILL.md`, `TASKS.md`, compaction в `opencode.jsonc` |
| **L** Lifecycle | оркестрация, state machine, задача → PR | `scripts/fa/loop.mjs`, `scripts/fa/queue.mjs`, `.opencode/agents/fa.md`, ветка `fa/work` |
| **O** Observability | логи, метрики, детект плохих циклов, алерты | `scripts/fa/metrics.mjs`, `scripts/fa/report.mjs`, `fa/logs/`, artifacts, `fa/STATUS.md` |
| **V** Verification | инварианты, замеры, человек; model-as-judge | `scripts/verify.mjs`, `scripts/fa/eval.mjs`, `.opencode/agents/fa-reviewer.md`, PR review |
| **G** Governance | безопасность, политики, границы, approvals | `opencode.jsonc`, `scripts/fa/policy.mjs`, `.githooks/pre-push`, `CODEOWNERS`, kill switch |

## Четыре функции OpenAI

| Функция | Как реализована |
| --- | --- |
| **Constrain** | жёсткие лимиты шагов/времени/токенов в коде, deny-правила, запрет необратимых действий |
| **Inform** | `AGENTS.md` + `docs/CONVENTIONS.md` + контекст задачи + skill `fain` |
| **Verify** | `npm run verify` (инварианты) + eval (замеры) + человек/reviewer (смысл) |
| **Correct** | откат рабочего дерева при провале, повторные попытки с backoff, `BLOCKED` и issue после лимита |

## Три уровня проверок

1. **Инварианты в коде** — `npm run verify`: мгновенно, бесплатно, без модели. Синтаксис, паритет I18N, ключи, контракт HTML, CSS, JSON, очередь, секреты.
2. **Замеры** — `npm run fa:eval`: эталонные микрозадачи и метрики при смене модели. Дороже, запускается по событию.
3. **Человек** — merge PR, разблокировка `[!]`, решения по вкусу и продукту. Reviewer-сабагент — вероятностная подсказка, не замена человеку.

Правило: каждый инцидент — повод опустить проверку на уровень ниже. Увидел глазами → добавь в замеры. Замер ловит регулярно → добавь инвариант в код.

## Как это работает

```text
watchdog (каждые 15 мин, если FA_ENABLED)
        │
        ▼
gate: есть задачи? не остановлено?
        │
        ▼
loop.mjs ──► выбрать первую [ ] ──► opencode run --agent fa
   ▲                                        │
   │                                        ▼
   │                                 verify + diff guard
   │                                   │           │
   │                                 pass         fail
   │                                   │           │
   │                             коммит в fa/work  откат
   │                                   │           │
   │                             PR → main      попытка 2 → [!]
   └──────── следующая задача ◄────────┘
```

## Запуск и остановка

Подробно — в [OPERATING.md](OPERATING.md).

```bash
npm run fa:preflight   # проверить окружение
npm run fa             # непрерывный цикл локально
npm run fa:once        # одна задача
npm run fa:status      # состояние очереди
```

Остановить: repo variable `FA_ENABLED=false`, файл `FA_STOP` в корне или `workflow_dispatch` с `mode=stop`.

## Документы

- [EXECUTION.md](EXECUTION.md) — среда, лимиты, изоляция.
- [TOOLS.md](TOOLS.md) — инструменты и контракт ошибок.
- [CONTEXT.md](CONTEXT.md) — контекст, память, бюджеты.
- [LIFECYCLE.md](LIFECYCLE.md) — state machine и цикл.
- [OBSERVABILITY.md](OBSERVABILITY.md) — логи, метрики, алерты.
- [VERIFICATION.md](VERIFICATION.md) — три уровня проверок.
- [GOVERNANCE.md](GOVERNANCE.md) — угрозы, права, kill switch.
- [CHECKLIST.md](CHECKLIST.md) — чек-лист из видео с ответами.
- [PROMPTS.md](PROMPTS.md) — версионирование промптов и замеры.
- [OPERATING.md](OPERATING.md) — эксплуатация.
