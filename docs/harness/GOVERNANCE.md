# Governance — безопасность и границы

Слой отвечает за то, чтобы агент **не мог навредить**, даже если модель уверена в обратном. В видео это называют defense in depth: политики поверх всех остальных слоёв.

## Модель угроз

| Угроза | Вектор | Контроль |
| --- | --- | --- |
| Prompt injection | RSS, `feed.json`, текст задачи, комментарий PR | данные ≠ инструкции; `webfetch`/`websearch` запрещены; агент не исполняет найденные команды |
| Утечка секретов | чтение `.env`, логов, ответа | deny на `.env*`, `.dev.vars*`, `~/.ssh`, `~/.aws`; редактирование в логах |
| Необратимое действие | deploy, push в main, удаление | deny `git push`, `gh`, `wrangler`, `rm -rf`; PR-only; hook на main |
| Самомодификация | правка harness-файлов | protected paths + проверка после агента |
| Supply chain | новая зависимость | `npm install` запрещён, `package.json` защищён |
| Runaway cost | длинный цикл/повторы | один запуск = одна задача; лимиты шагов, времени, токенов; детект повторов |
| Загрязнение main | прямой push | ветка `fa/work`, PR, branch protection |
| Кража токена CI | логи/артефакты | маскирование, минимальные permissions, без `pull_request_target` |

## Права

`opencode.jsonc` задаёт ordered deny-правила; `policies` — жёсткие запреты, которые не переопределяются сохранёнными approval'ами.

Запрещено всегда:

- `git push`, `git commit`, `git merge`, `git tag`, `git remote`, `git config`;
- `gh *`, `wrangler *`, `npm publish`, `npm install`, `pnpm`, `yarn`, `bun add`;
- `sudo`, `su`, `rm -rf`, `rm -r`, `find -delete`, `chmod`, `chown`, `dd`, `mkfs`;
- `curl`, `wget`, `ssh`, `scp`, `env`, `printenv`;
- `git reset --hard`, `git clean -fdx`;
- `webfetch`, `websearch`, `external_directory`.

Разрешено: чтение и правка проектных файлов, `git status/diff/log/show`, `node`, `npm run verify`, `node --check`, очередь и отчёты.

## Защищённые файлы

Список — в `scripts/fa/policy.mjs`:

```text
opencode.jsonc
.opencode/**
scripts/fa/**
scripts/verify.mjs
.github/workflows/fa*.yml
.github/CODEOWNERS
.githooks/**
AGENTS.md
package.json
.gitignore
docs/harness/**
docs/decisions/**
TASKS.md
```

FA не может их менять. Изменения делает человек через отдельный PR; `.github/CODEOWNERS` запрашивает ревью владельца.

## Ветки и PR

- `main` защищён: только PR, обязательный `fa-verify`, запрет force-push и обязательное одобрение Code Owner для совпавших с `CODEOWNERS` чувствительных файлов. В настройках branch protection включить `Require review from Code Owners`.
- FA пушит только `fa/work`.
- `.githooks/pre-push` отказывает в push в `main`/`master`.
- Merge делает человек; авто-merge выключен.
- Закрытый без merge PR — стоп, а не «попробуем ещё раз».

## Секреты

- Только GitHub Secrets: `GEMINI_API_KEY` … `GEMINI_API_KEY_5` (Gemini), `NVIDIA_API_KEY`/`NVIDIA_NIM_API_KEY` (NVIDIA NIM), опционально `FA_PAT`.
- `.dev.vars`, `.env` — в `.gitignore`, чтение агентом запрещено.
- Ключи не попадают в `TASKS.md`, логи, PR body, issue.
- При подозрении на утечку: отозвать ключ, удалить artifact, проверить diff, инцидент.

## Kill switch

1. Repo variable `FA_ENABLED=false` — новый запуск не стартует.
2. Файл `FA_STOP` в корне — аварийный предохранитель.
3. `workflow_dispatch` `mode=stop` — отмена активных запусков.
4. Cancel job в UI — мгновенная остановка.

## Человеческие точки

- Merge PR.
- Разблокировка `[!]`.
- Смена модели (после eval).
- Правка harness.
- Любое необратимое действие: deploy, публикация, миграция данных.

## Остаточные риски

- `GITHUB_TOKEN` с `contents: write` может пушить в любые ветки, кроме защищённых. Поэтому main защищён branch protection.
- Runner имеет сеть; агент не имеет `webfetch`, но `npm run verify` и `opencode` сеть используют. Это принято.
- Модель недетерминирована; поэтому инварианты и откат важнее «убеждения» промпта.
- Человек может смержить плохой PR; CODEOWNERS и `fa-verify` снижают риск, но не отменяют ревью.

## Реакция на инцидент

1. Остановить запуски (kill switch).
2. Скачать artifact, определить задачу и tool calls.
3. Отозвать скомпрометированные секреты.
4. Откатить подозрительный коммит/PR.
5. Добавить инвариант или замер, чтобы инцидент не повторился.
6. Записать разбор в `docs/decisions/` (ADR) или issue.
