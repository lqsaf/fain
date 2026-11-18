---
description: Независимый review текущих изменений
agent: fa-reviewer
subagent: true
---

Проверь незакоммиченные изменения в репозитории.

1. Запусти `git diff` и `git status`.
2. Прочитай acceptance задачи, если в диффе есть `FA-Task:`.
3. Проверь корректность, регрессии, края, локализацию, storage, доступность и scope creep.
4. Запусти `npm run verify`, если это возможно без правок.

Ответ — находки по severity и последняя строка `VERDICT: PASS` или `VERDICT: FAIL`.
