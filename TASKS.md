# FA task queue

Очередь для автономного агента **FA (free agent)**. Человек добавляет и приоритизирует задачи, FA выполняет их по одной и открывает PR.

## Протокол

- `## [ ] Txx · Название` — задача к выполнению.
- `[~]` — задача взята в работу (ставит только оркестратор, максимум одна).
- `[!]` — задача заблокирована (нужен человек); причина в `- blocked:`.
- `[x]` — задача выполнена; ниже есть `- done:`.
- `needs:` — задача ждёт действия владельца (URL, доступ, контракт) и пропускается.
- `depends_on:` — задача запускается только после выполнения указанных ID.
- `verify:` — команда проверки из allowlist (`node ...`, `npm run ...`).
- `review: required` — перед коммитом обязателен независимый review сабагентом.

Правила для FA: не редактировать этот файл, не коммитить, не пушить, не менять harness-файлы. Оркестратор сам отмечает статусы.

---

## [x] T01 · Относительное время в подвале
- area: frontend
- priority: high
- files: js/feed.js, js/data.js, index.html
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
    Заменить абсолютную дату в подвале на локализованное относительное время.
    - Формат: «N минут назад», «M часов назад», «K дней назад»; для en и zh — свои формы в I18N.
    - Правильные склонения для ru (минута/минуты/минут, час/часа/часов, день/дня/дней).
    - Для времени < 1 минуты — «только что» (локализовано).
    - Для времени > 30 дней — абсолютная дата.
    - Подвал обновляется при каждом рендере ленты; не показывать «Invalid Date».
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T19:10:33.138Z
## [x] T02 · Ссылка «бесплатно помочь разработке»
- area: frontend
- priority: normal
- files: index.html, css/styles.css, js/data.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- url: https://lqsaf.github.io/sgak/
- acceptance: |
    В подвале ниже ссылки на GitHub добавить кнопку-ссылку на sgak с текстом «бесплатно помочь разработке».
    - Ссылка ведёт на `https://lqsaf.github.io/sgak/`.
    - Ссылка открывается в новой вкладке с `rel="noopener noreferrer"`.
    - Текст локализован в ru/en/zh через I18N.
    - Адрес берётся из поля `- url:` этой задачи, не хардкодится в нескольких местах.

- done: 2026-11-19T01:51:06.088Z
## [x] T03 · Тема без сброса, предсказуемый интерфейс, прозрачная топ-панель
- area: frontend
- priority: high
- files: index.html, settings.html, css/styles.css, js/ui.js, js/data.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
    Убрать сброс темы при обновлении страницы и привести визуал к предсказуемому поведению.
    - Синхронный inline-скрипт в `<head>` обеих страниц до подключения CSS применяет `fain_theme_v1`, масштаб и `fain_custom_css_v1` из localStorage; вспышки темы нет.
    - У топ-панели убрать фон и blur (`background`, `backdrop-filter`); логику скрытия/показа при скролле не менять.
    - После reload в light/amber/phosphor нет вспышки чёрного/белого.
    - Нет layout shift из-за шрифтов/панели; поведение одинаково на index.html и settings.html.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T19:12:21.964Z
## [x] T04 · Настройки: разделы и выпадающие списки
- area: frontend
- priority: high
- files: settings.html, js/settings.js, js/data.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
    Переработать страницу настроек в строгие разделы: «Интерфейс», «Язык», «Прочее».
    - Все настройки — выпадающие списки (`<select>`), стилизованные под терминал, с корректным focus и клавиатурой.
    - Язык, тема, ASCII-волны, масштаб, шрифт и пользовательский CSS разложены по разделам.
    - Подписи и варианты локализованы в ru/en/zh.
    - Сохранение применяется сразу и переживает reload.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T20:40:43.306Z
## [x] T05 · Масштаб интерфейса
- area: frontend
- priority: normal
- files: js/data.js, js/settings.js, js/ui.js, settings.html, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T04
- acceptance: |
    Добавить настройку «Масштаб интерфейса»: 90%, 100%, 110%, 120%.
    - `STORAGE_KEYS.SCALE = "fain_scale_v1"`.
    - Значение применяется к `document.documentElement.style.fontSize` на обеих страницах до первого рендера.
    - Выбор сохраняется, переживает reload и не ломает мобильную вёрстку.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-19T01:52:04.799Z
## [ ] T06 · Версия приложения внизу настроек
- area: frontend
- priority: low
- files: js/settings.js, js/data.js, settings.html, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T04
- acceptance: |
    Внизу страницы настроек показывать установленную версию, только если это Android-приложение.
    - Контракт: Android-обёртка выставляет `window.fainAppVersion` (строка).
    - В браузере без переменной блок версии не рендерится.
    - Версия локализована («версия» / «version» / «版本»).
    - `node scripts/verify.mjs` проходит.

## [x] T07 · Кэш ленты раздельно по языкам
- area: frontend
- priority: high
- files: js/data.js, js/main.js, js/feed.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- acceptance: |
    При смене языка ru ↔ en ↔ zh не смешивать карточки разных языков.
    - Кэш и время обновления разделены по языку: `fain_cached_items_v2_<lang>`, `fain_last_updated_v1_<lang>`.
    - `fain_read_ids_v1` остаётся общим и не теряется.
    - Старые ключи мигрируют один раз без потери прочитанных ID.
    - После смены языка лента сразу показывает карточки целевого языка.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T20:43:23.744Z
## [x] T08 · Мультиязычный pipeline в worker.js
- area: backend
- priority: high
- files: worker.js, wrangler.toml
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- acceptance: |
    Принимать `?lang=ru|en|zh` и отдавать `title`, `summary`, `analysis` на нужном языке.
    - Шаги 0 (пре-фильтр RSS), 1 (отбор тем), 2 (дедупликация) и 4 (теги) выполняются один раз на английских источниках.
    - Нет цепочки EN → RU → EN; выжимки генерируются сразу на трёх языках из английского источника.
    - Локализованные поля хранятся в KV внутри одного объекта (или вынесены во второй воркер при лимитах).
    - Неизвестный/отсутствующий `lang` даёт безопасный fallback (ru), без 500.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T22:36:03.862Z
## [x] T09 · Убрать жёсткую привязку к кириллице
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
    Убрать `isRussianText()` / `isValidRussianItem()` и русскоязычную валидацию как единственную.
    - Валидация учитывает `lang` и проверяет непустые/осмысленные поля, а не алфавит.
    - EN и ZH элементы не отбрасываются и не помечаются невалидными.
    - Ошибочные/пустые ответы модели по-прежнему отбрасываются.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T22:38:50.118Z
## [x] T10 · Не более 5 новостей в день
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
    Ужесточить отбор: публиковать не более 5 новостей в календарный день (UTC).
    - Лимит учитывается при добавлении в KV и при отдаче ленты.
    - Повторный запуск пайплайна не превышает лимит.
    - Счётчик/дата восстанавливаются из KV после рестарта воркера.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T23:32:24.493Z
## [!] T11 · Исключить случайные пропуски новостей
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
    Убрать случайные пропуски новостей при отборе/дедупликации.
    - Одинаковый вход даёт одинаковый результат (детерминированный порядок, стабильные ключи).
    - Элемент не теряется из-за гонки между чтением KV и записью.
    - Дедупликация не удаляет легитимно разные новости с похожими заголовками.
    - `node scripts/verify.mjs` проходит.

- blocked: 2026-11-18T23:34:55.475Z · review: в контексте задачи «Исключить случайные пропуски». Необходимо убедиться, что это действительно уменьшает ложные срабатывания, а не добавляет новые. ### Замечания по коду - **Scope Creep:** Удаление функциональности T10 является нарушением целостности репозитория. Задачи должны дополнять друг друга, а не противоречить. --- VERDICT: FAIL **Причины:** Регрессия функциональности: удаление лимита в 5 новостей в день (T10), отсутствие пояснений по поводу удаления этой логики в контексте задачи
## [x] T12 · KV: хранить 200, отдавать 50
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
    Хранить в KV последние 200 новостей (или все за текущий месяц), в кэше/feed.json отдавать последние 50.
    - Остальные ~150 используются только для проверки на дубли.
    - Сортировка по `publishedAt` убывающая, ID уникальны.
    - Ответ `GET` не превышает 50 элементов, KV не растёт бесконечно.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T23:36:41.201Z
## [x] T13 · Улучшить сравнение новостей на уникальность
- area: backend
- priority: normal
- files: worker.js, wrangler.toml
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08, T12
- acceptance: |
    Улучшить дедупликацию: сравнение по тегам/нормализованным сущностям, а не только по заголовку.
    - Похожие пересказы одного события схлопываются, разные события с общими словами — нет.
    - Решение детерминировано и логируется.
    - При упоре в лимиты Gemini допускается выделение сравнения в отдельный воркер; контракт API сохраняется.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-19T01:54:07.115Z
## [x] T15 · Защитить POST /refresh и GET
- area: backend-security
- priority: high
- files: worker.js, wrangler.toml
- context: docs/harness/GOVERNANCE.md
- verify: node scripts/verify.mjs
- review: required
- acceptance: |
    Закрыть `POST /refresh` секретным токеном и защитить GET от тяжёлого пайплайна.
    - `POST /refresh` требует `Authorization: Bearer <env.REFRESH_TOKEN>`; без токена — 401.
    - GET при пустом KV не запускает генерацию; отдаёт 202/пустую ленту и понятный статус.
    - Токен не логируется; сравнение timing-safe.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T23:38:33.483Z
## [x] T16 · Таймаут Gemini через AbortController
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T08
- acceptance: |
    Добавить `AbortController` с таймаутом 12–15 секунд в `callGeminiWithFallback`.
    - Таймер очищается во всех ветках; зависший запрос не держит воркер.
    - По таймауту срабатывает fallback на следующий ключ/модель.
    - Ошибка таймаута логируется без ключей и тел запросов.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T23:38:53.923Z
## [x] T17 · cleanText: сначала decodeEntities, потом теги
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
    В `cleanText()` декодировать HTML-сущности до вырезания тегов.
    - `&lt;p&gt;` и другие экранированные теги не попадают в текст.
    - Нет двойного декодирования и порчи `&amp;`.
    - Пробелы/переносы нормализуются, пустой результат отбрасывается.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-18T23:39:15.303Z
## [!] T18 · Статический feed.json и GitHub Actions
- area: delivery
- priority: high
- files: js/data.js, .github/workflows/feed-sync.yml
- context: docs/CONVENTIONS.md, docs/harness/OPERATING.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T07, T08
- acceptance: |
    Настроить доставку ленты без VPN через статический `feed.json`.
    - `fetchAndSyncNews()` сначала пробует `./feed.json` (или `./feed.<lang>.json`), затем воркер, затем кэш.
    - Ошибка/битый JSON не ломает страницу.
    - Workflow `.github/workflows/feed-sync.yml` по cron и вручную забирает ленту у воркера, пишет `feed.json`/`feed.<lang>.json`, коммитит только при изменении.
    - Сценарий FA-харнеса отдельный и не пересекается с feed-sync.
    - `node scripts/verify.mjs` проходит.

- blocked: 2026-11-19T01:48:38.796Z · review: .yml`. The task acceptance criteria explicitly require this workflow file to fetch the feed from the worker and commit `feed.json`/`feed.<lang>.json`. It is currently not present in the repository, and only `js/data.js` has been modified. 2. **Logic check**: The implementation in `js/data.js` correctly implements the fallback strategy: static JSON -> worker -> cache. This part of the acceptance criteria is met. Since the workflow file is entirely missing, the task is incomplete. VERDICT:
## [x] T19 · Грамотная харнес-разработка (FA)
- area: harness
- priority: high
- files: AGENTS.md, TASKS.md, opencode.jsonc, .opencode/**, scripts/**, .github/workflows/fa.yml, docs/harness/**
- context: docs/harness/README.md
- verify: node scripts/verify.mjs
- review: optional
- done: 2026-11-18 · bootstrap FA (free agent), 7 слоёв ETCLOVG
- acceptance: |
    Перейти на harness-разработку по семи слоям ETCLOVG.
    - Execution, Tools, Context, Lifecycle, Observability, Verification, Governance реализованы и описаны в docs/harness/.
    - FA работает непрерывно в GitHub Actions, пока не остановлен; PR в main, без прямого push.
    - Инварианты, замеры и человек разведены по трём уровням проверок.
    - Kill switch, лимиты, бюджеты, логи и алерты работают.

## [ ] T20 · Редактор темы и шрифта
- area: frontend
- priority: normal
- files: css/styles.css, settings.html, js/settings.js, js/data.js, js/ui.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T03, T04
- acceptance: |
    Добавить заготовку для ручной смены темы и шрифта.
    - CSS переписан на переменные: фон, основной текст, акцент, границы, шрифт.
    - В настройках можно выбрать шрифт (JetBrains Mono / Fira Code / системный моноширинный) и изменить базовые цвета темы.
    - Значения сохраняются в localStorage, применяются на обеих страницах и сбрасываются к пресету.
    - Пользовательский CSS по-прежнему имеет приоритет.
    - `node scripts/verify.mjs` проходит.

## [x] T21 · Не отмечать новость прочитанной при скролле и выделении
- area: frontend
- priority: high
- files: js/main.js, js/feed.js, js/data.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
    Убрать случайные пропуски новостей: сейчас клик по `.news-description` сразу скрывает карточку.
    - Прочитанным считается только явное действие: отдельная кнопка «✓ прочитано» или double-click.
    - Скролл, drag и выделение текста не скрывают карточку.
    - Кнопка доступна с клавиатуры (`Enter`/`Space`) и имеет локализованный `aria-label`.
    - Поведение одинаково для мыши, тача и клавиатуры.
    - `node scripts/verify.mjs` проходит.

- done: 2026-11-19T01:49:27.470Z
