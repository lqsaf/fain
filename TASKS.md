FA task queue
Очередь для автономного агента FA (free agent). Человек добавляет и приоритизирует задачи, FA выполняет их по одной и открывает PR.

Протокол
`## [ ] Txx · Название` — задача к выполнению.
`[~]` — задача взята в работу (ставит только оркестратор, максимум одна).
`[!]` — задача заблокирована (нужен человек); причина в `- blocked:`.
`[x]` — задача выполнена; ниже есть `- done:`.
`needs:` — задача ждёт действия владельца (URL, доступ, контракт) и пропускается.
`depends_on:` — задача запускается только после выполнения указанных ID.
`verify:` — команда проверки из allowlist (`node ...`, `npm run ...`).
`review: required` — перед коммитом обязателен независимый review сабагентом.
Правила для FA: не редактировать этот файл, не коммитить, не пушить, не менять harness-файлы. Оркестратор сам отмечает статусы.

Ревизия 2026-11-20 (оркестратор): приняты только прозрачная панель (T03) и относительное время (T01, но нужно живое обновление — T23). UX настроек отклонён — T04 переоткрыта. Backend-работы FA откатываются (T22), T08/T09 переоткрыты поверх восстановленной базы. T10 переосмыслена: не «5 в день», а 1–2 самые важные новости в час, без сплетен. Поля приведены к формату парсера queue.mjs (`- key: value`).

## [x] T01 · Относительное время в подвале
- area: frontend
- priority: high
- files: js/feed.js, js/data.js, index.html
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
  Заменить абсолютную дату в подвале на локализованное относительное время.
  Формат: «N минут назад», «M часов назад», «K дней назад»; для en и zh — свои формы в I18N.
  Правильные склонения для ru (минута/минуты/минут, час/часа/часов, день/дня/дней).
  Для времени < 1 минуты — «только что» (локализовано).
  Для времени > 30 дней — абсолютная дата.
  Подвал обновляется при каждом рендере ленты; не показывать «Invalid Date».
  `node scripts/verify.mjs` проходит.
- done: 2026-11-18T19:10:33.138Z

## [ ] T02 · Ссылка «бесплатно помочь разработке»
- area: frontend
- priority: normal
- files: index.html, css/styles.css, js/data.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- url: https://lqsaf.github.io/sgak/
- acceptance: |
  В подвале ниже ссылки на GitHub добавить кнопку-ссылку на sgak с текстом «бесплатно помочь разработке».
  Ссылка ведёт на `https://lqsaf.github.io/sgak/`.
  Ссылка открывается в новой вкладке с `rel="noopener noreferrer"`.
  Текст локализован в ru/en/zh через I18N.
  Адрес берётся из поля `- url:` этой задачи, не хардкодится в нескольких местах.

## [x] T03 · Тема без сброса, предсказуемый интерфейс, прозрачная топ-панель
- area: frontend
- priority: high
- files: index.html, settings.html, css/styles.css, js/ui.js, js/data.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
  Убрать сброс темы при обновлении страницы и привести визуал к предсказуемому поведению.
  Синхронный inline-скрипт в `<head>` обеих страниц до подключения CSS применяет `fain_theme_v1`, масштаб и `fain_custom_css_v1` из localStorage; вспышки темы нет.
  У топ-панели убрать фон и blur (`background`, `backdrop-filter`); логику скрытия/показа при скролле не менять.
  После reload в light/amber/phosphor нет вспышки чёрного/белого.
  Нет layout shift из-за шрифтов/панели; поведение одинаково на index.html и settings.html.
  `node scripts/verify.mjs` проходит.
- done: 2026-11-18T19:12:21.964Z

## [!] T04 · Настройки 2.0: аккордеон
- area: frontend
- priority: high
- files: settings.html, js/settings.js, js/ui.js, js/data.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: npm run verify:ui
- review: optional
- note: Первая итерация (нативные select, статичные секции) отклонена владельцем. UI smoke уже проверяет custom dropdown и accordion, а не наличие нативных select.
- acceptance: |
  Секции «Интерфейс», «Язык», «Прочее» — аккордеон: клик и Enter/Space по заголовку переключают содержимое вниз в потоке страницы; анимация уважает `prefers-reduced-motion`.
  Заголовок — кнопка с уникальными `aria-controls`/`aria-expanded`. Закрытая панель имеет `hidden` (или эквивалент, исключающий её содержимое из tab-порядка и accessibility tree).
  `loadAccordionState()` всегда возвращает JSON-массив известных ID (`interface`, `language`, `other`); при отсутствующем/битом значении или ошибке чтения localStorage возвращает ровно `["interface"]`. Неизвестные ID отбрасываются, без миграции старых ключей. Состояние хранится в `STORAGE_KEYS.SETTINGS_SECTIONS = "fain_settings_sections_v1"`; ошибки localStorage при чтении/записи не ломают страницу.
  Проверки мышью, клавиатурой и перезагрузкой выполняются в `npm run verify:ui`: три accordion-панели, `loadAccordionState()` default и отсутствие фокусируемых элементов в закрытых панелях. При 390px нет горизонтального переполнения.
  Состав этой задачи ограничен темой, ASCII-волнами, языком и CSS-панелью. Масштаб — T05; выбор шрифта и редактор цветов — T20. `js/ui.js` менять только если доказана необходимость для применения настроек или регресса T03.
  T03 не регрессирует: нет вспышки темы после reload, top-panel прозрачна, inline-скрипт в `<head>` обеих страниц сохранён.
  `npm run verify` и `npm run verify:ui` проходят.

- blocked: 2026-11-23T13:48:07.081Z · plan review failed: e trigger and its removal. | | **minor** | Step 3 | Single `document` click-outside handler "attached once at module load" — good. Ensure it's registered in module scope (not inside `renderSettingsPage`) so re-renders don't duplicate listeners. | No **blocker** or **major** issues. All acceptance criteria are mapped to concrete steps and verifications. Protected files (`settings.html`, `js/ui.js`) are explicitly not modified. Accessibility requirements (ARIA roles, keyboard, 
## [ ] T24 · Настройки 2.0: inline combobox
- area: frontend
- priority: high
- files: settings.html, js/settings.js, js/data.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: npm run verify:ui
- review: optional
- depends_on: T04
- acceptance: |
  Кастомные настройки темы, ASCII-волн и языка используют inline-панели под триггерами; список входит в поток страницы, раздвигает контент и не использует portal, overlay или popup ОС. Нативных `<select>` на странице нет.
  Каждый trigger имеет `role="combobox"`, `aria-haspopup="listbox"`, уникальные `aria-controls` и `aria-expanded`; popup имеет `role="listbox"`, options — `role="option"`, ровно одна опция выбрана через `aria-selected="true"`. DOM-focus остаётся на combobox.
  Trigger получает доступное имя через `aria-labelledby`, объединяющий ID видимого локализованного label и ID текста текущего значения; listbox ссылается на тот же label. Placeholder и title не используются как единственное accessible name.
  Используются локализованные `settings.themeLabel`, `settings.asciiLabel`, `settings.langLabel` и имеющиеся названия секций; новые видимые строки добавляются синхронно в ru/en/zh. Выбор применяется сразу и сохраняется существующими `STORAGE_KEYS`, без новых ключей темы/ASCII/языка.
  `npm run verify` и `npm run verify:ui` проверяют inline-положение, отсутствие native select, combobox/listbox/option semantics, accessible name, сохранённый выбор и отсутствие горизонтального переполнения при 390px.

## [ ] T25 · Настройки 2.0: клавиатурная навигация
- area: frontend
- priority: high
- files: js/settings.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: npm run verify:ui
- review: optional
- depends_on: T24
- acceptance: |
  Enter, Space, ArrowDown и ArrowUp на закрытом combobox открывают список с текущим значением активным. Открытый combobox обрабатывает ArrowDown/ArrowUp, Home/End, Enter и Escape.
  `aria-activedescendant` указывает на существующую активную option при открытом списке; Escape закрывает без изменения выбранного значения и удаляет active descendant. Tab следует обычному tab-порядку, фокус виден в терминальном стиле.
  `npm run verify:ui` покрывает открытие, перемещение, выбор и Escape с клавиатуры.

## [ ] T26 · Настройки 2.0: доступность и жизненный цикл
- area: frontend
- priority: high
- files: js/settings.js, settings.html, css/styles.css
- context: docs/CONVENTIONS.md
- verify: npm run verify:ui
- review: optional
- depends_on: T24, T25
- acceptance: |
  Закрытие по клику вне работает без потери фокуса и не перехватывает Tab. Закрытые панели исключены из tab-порядка и accessibility tree.
  Глобальные `pointerdown`/`keydown` обработчики связаны с текущим render через `AbortController` либо сохранённые handler refs; перед повторным render старые обработчики снимаются, listeners не накапливаются.
  `npm run verify:ui` проверяет доступность accordion/combobox, состояния `aria-expanded`/`aria-selected`/`aria-activedescendant`, закрытие по клику вне и отсутствие утечек listeners.

## [ ] T27 · Настройки 2.0: изоляция CSS-редактора
- area: frontend
- priority: normal
- files: css/styles.css, settings.html, js/settings.js
- context: docs/CONVENTIONS.md
- verify: npm run verify:ui
- review: optional
- depends_on: T04, T24, T25, T26
- acceptance: |
  Сохранить правила textarea `.custom-css-area` независимо от trigger/popup-стилей; не использовать общий selector `.custom-css-area, select` или аналогичный, который непреднамеренно меняет textarea.
  Проверить отображение и доступность редактора CSS вместе с accordion и inline combobox в `npm run verify:ui`.

## [ ] T05 · Масштаб интерфейса
- area: frontend
- priority: normal
- files: js/data.js, js/settings.js, js/ui.js, settings.html, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T04, T24, T25
- acceptance: |
  Добавить в секцию «Интерфейс» из T04 настройку «Масштаб интерфейса»: 90%, 100%, 110%, 120%.
  `STORAGE_KEYS.SCALE = "fain_scale_v1"`.
  Значение применяется к `document.documentElement.style.fontSize` на обеих страницах до первого рендера.
  Выбор сохраняется, переживает reload и не ломает мобильную вёрстку.
  Выбор масштаба использует inline-dropdown из T04; если он уже поддерживает опции с `%`, не создавать второй компонент.
  Регрессионная проверка фиксирует все 4 значения, применение до первого рендера, reload и отсутствие горизонтального переполнения при 390px.
  `npm run verify` и `npm run verify:ui` проходят.

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
  Контракт: Android-обёртка выставляет `window.fainAppVersion` (строка).
  В браузере без переменной блок версии не рендерится.
  Версия локализована («версия» / «version» / «版本»).
  `node scripts/verify.mjs` проходит.

## [ ] T07 · Кэш ленты раздельно по языкам
- area: frontend
- priority: high
- files: js/data.js, js/main.js, js/feed.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- acceptance: |
  При смене языка ru ↔ en ↔ zh не смешивать карточки разных языков.
  Кэш и время обновления разделены по языку: `fain_cached_items_v2_<lang>`, `fain_last_updated_v1_<lang>`.
  Значение `fain_cached_items_v2_<lang>` — JSON-массив нормализованных карточек `{ id, url, source, publishedAt, tag, title, summary, analysis }`; время хранится отдельной ISO-строкой в `fain_last_updated_v1_<lang>`.
  `fain_read_ids_v1` остаётся общим и не теряется.
  Старые ключи мигрируют один раз без потери прочитанных ID.
  После смены языка лента сразу показывает карточки целевого языка.
  `node scripts/verify.mjs` проходит.

## [ ] T08 · Мультиязычный pipeline в worker.js
- area: backend
- priority: high
- files: worker.js, wrangler.toml, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: required
- depends_on: T22
- note: Прошлая реализация откачена (T22). Делать заново поверх восстановленной базовой версии worker.js, аккуратно, с review.
- acceptance: |
  Зафиксировать API-ответ GET как `{ items, lastUpdated }`. `?lang=ru|en|zh` выбирает ровно одну локаль для каждого `title`, `summary`, `analysis`; отсутствующий или неизвестный `lang` выбирает `ru`, не вызывает 500.
  В KV одна запись новости хранит неизменяемые общие поля (`id`, `url`, `publishedAt`, `source`) и `translations` с ключами `en`, `ru`, `zh`; каждая локаль содержит `title`, `summary`, `analysis`, `tag`. Если генерация одной локали не удалась, уже сохранённые локали не затираются.
  RSS нормализуется, отбирается и дедуплицируется один раз на исходном тексте. Все три локали генерируются непосредственно из английского источника; цепочка перевода через другую целевую локаль запрещена. Теги вычисляются один раз либо подтверждённо совпадают между локалями.
  Результат GET имеет единый контракт существующего клиента и возвращает только запрошенную локаль, а не внутреннюю карту `translations`.
  Добавить/обновить dependency-free Worker fixtures в `tests/worker/` и проверить: поля/тип ответа, неизвестный `lang`, отсутствие повторных вызовов отбора/dedup для каждой локали, прямую генерацию из source и сохранение успешной локали при частичном отказе.
  Формулировку «качество не ниже базовой версии» не использовать как критерий; важность и часовой лимит — только T10.
  `npm run verify` и `node --test tests/worker` проходят без внешней сети и Cloudflare credentials.

## [ ] T09 · Убрать жёсткую привязку к кириллице
- area: backend
- priority: high
- files: worker.js, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: required
- depends_on: T08
- acceptance: |
  Убрать `isRussianText()` / `isValidRussianItem()` и русскоязычную валидацию как единственную.
  Валидация учитывает `lang` и проверяет непустые/осмысленные поля, а не алфавит.
  EN и ZH элементы не отбрасываются и не помечаются невалидными.
  Ошибочные/пустые ответы модели по-прежнему отбрасываются.
  `npm run verify` и `node --test tests/worker` проходят.

## [ ] T10 · Только самые важные новости: 1–2 в час
- area: backend
- priority: high
- files: worker.js, wrangler.toml, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: required
- depends_on: T08
- acceptance: |
  Cron Worker запускается по `0 * * * *`; единица квоты — максимум 2 **новые** опубликованные новости на один UTC-часовой интервал. Допустимо 0 или 1, если прошло меньше двух материалов; дневного лимита нет.
  Важное — подтверждённое событие с датой/артефактом: релиз модели/версии/API, доступности или весов; выпуск агента/фреймворка/инструмента; исследование с paper и кодом/весами/бенчмарком; значимый GA-релиз продукта. Предложения, слухи, неподтверждённые утечки, политика без технического результата, мнения и подборки не проходят. Контрпример: предложение создать ИИ-хаб без состоявшегося технического результата.
  Gemini присваивает score 0–100 по rubric в коде; порог фиксирован как константа. В логе только score, решение и безопасный reason code — без ключей и тел запросов. Ниже порога материал не сохраняется.
  Источник ограничен последним UTC-часом с перекрытием 15 минут; окно и порог проверяются фикстурами, одинаковый упорядоченный вход даёт одинаковый результат и tie-break.
  Дедупликация и idempotency key учитывают уже записанные ID. Повторный запуск в том же UTC-часе не добавляет повторов и не превышает лимит 2; граница часа сбрасывает лимит. Параллельные refresh/scheduled executions должны быть сериализованы (через поддерживаемую Worker coordination primitive), иначе операция не объявляется безопасной. Счётчик/результат переживает рестарт isolate.
  Старые KV-записи не очищаются автоматически. Новая политика применяется к новым записям; миграция/удаление существующих данных — отдельный явно утверждённый шаг.
  Тесты покрывают 0/1/2/3 кандидатов, ниже/равно/выше порога, неподтверждённое предложение, повтор, параллельный запуск, рестарт isolate и новый час. `npm run verify` и `node --test tests/worker` проходят.

## [ ] T11 · Исключить случайные пропуски новостей
- area: backend
- priority: high
- files: worker.js, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: required
- depends_on: T08, T10
- acceptance: |
  Scope только надёжность pipeline и сохранности данных; алгоритм семантического сходства остаётся T13.
  Для одинакового набора записей результат и порядок детерминированы; ID и KV-ключи стабильны.
  Запись нового материала не перезаписывает существующие записи, если изменились порядок RSS или результаты параллельного чтения; конфликтная запись разрешается без потери обоих разных ID. Использовать serialization primitive из T10, не добавлять второй механизм блокировок.
  Фикстуры проверяют повтор одного ID, перестановку входа, два разных ID с одинаковым заголовком и одновременное добавление двух материалов. Разные ID не удаляются этой задачей только из-за совпадения заголовков.
  Проверки запускаются локально без внешних API и Cloudflare credentials через `node --test tests/worker`; `npm run verify` также проходит.

## [ ] T12 · KV: хранить 200, отдавать 50
- area: backend
- priority: high
- files: worker.js, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: required
- depends_on: T08
- acceptance: |
  Единая политика: хранить ровно до 200 самых новых уникальных записей в KV; альтернативу «все за месяц» не реализовывать. Запись соответствует схеме `translations` из T08.
  GET и опубликованный static feed содержат не более 50 новостей выбранной локали; KV-записи 51–200 используются для дедупликации, но не отдаются клиенту.
  Сортировка — `publishedAt` по убыванию, стабильный tie-break по `id`; ID уникальны. После добавления записи выполнить детерминированное вытеснение записей за пределами 200.
  Фикстура с более чем 200 записями проверяет exact count, сохранение новых, удаление самых старых, уникальность и первые 50 элементов GET для каждой локали. KV не должен расти сверх заданной политики.
  Проверки запускаются локально без Cloudflare credentials через `node --test tests/worker`; `npm run verify` также проходит.

## [ ] T13 · Улучшить сравнение новостей на уникальность
- area: backend
- priority: normal
- files: worker.js, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: required
- depends_on: T08, T12
- acceptance: |
  Scope только семантическое сходство; детерминированная запись/гонки — T11. Не менять `wrangler.toml`, если не требуется новая инфраструктура, предварительно обоснованная в PR.
  Сравнение не вызывает Gemini и даёт одинаковый результат при одинаковом входе. Нормализация использует URL/ID, основные сущности, даты и токены заголовка; совпадение общих слов или тега само по себе не является причиной удаления.
  В проверках есть пары: два пересказа одного события с разными заголовками/URL должны схлопнуться; два разных релиза одного вендора/одной модели должны сохраниться; одинаковый URL с обновлённым текстом остаётся одним событием.
  Для каждого решения выдаётся структурированный reason code (`exact-id`, `canonical-url`, `same-event`, `distinct-event`, `not-similar`) без исходного тела статьи и секретов.
  Порог/правила сходства фиксируются в коде и проверяются на локальных fixtures; ложное объединение двух разных событий считается провалом.
  `npm run verify` и `node --test tests/worker` проходят.

## [ ] T15 · Защитить POST /refresh и GET
- area: backend-security
- priority: high
- files: worker.js, wrangler.toml, tests/worker/**
- context: docs/harness/GOVERNANCE.md
- verify: node --test tests/worker
- review: required
- depends_on: T08, T22
- acceptance: |
  Закрыть `POST /refresh` секретным токеном и защитить GET от тяжёлого пайплайна.
  `POST /refresh` требует `Authorization: Bearer <env.REFRESH_TOKEN>`; без токена — 401.
  Заголовок использует ровно `Authorization: Bearer <REFRESH_TOKEN>`; секрет задаётся через Cloudflare Worker secret `REFRESH_TOKEN`.
  Отсутствующий/неверный токен возвращает 401 и не запускает pipeline; верный токен запускает один refresh. Сравнение токена constant-time по UTF-8 bytes с проверкой одинаковой длины.
  GET только читает KV/cache, никогда не запускает pipeline. При пустом хранилище отдаёт 200 и `{ items: [], lastUpdated: null }`; заполненное — обычный response из T08.
  Тесты Request/Response без реальных секретов: POST без заголовка, неверный Bearer, верный Bearer, GET при пустом KV, счётчик вызовов pipeline и проверка логов на отсутствие токена.
  `npm run verify` и `node --test tests/worker` проходят.

## [ ] T16 · Таймаут Gemini через AbortController
- area: backend
- priority: high
- files: worker.js, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: optional
- depends_on: T08
- acceptance: |
  Добавить `AbortController` с таймаутом 12–15 секунд в `callGeminiWithFallback`.
  Таймер очищается во всех ветках; зависший запрос не держит воркер.
  По таймауту срабатывает fallback на следующий ключ/модель.
  Ошибка таймаута логируется без ключей и тел запросов.
  `npm run verify` и `node --test tests/worker` проходят.

## [ ] T17 · cleanText: сначала decodeEntities, потом теги
- area: backend
- priority: high
- files: worker.js, tests/worker/**
- context: docs/CONVENTIONS.md
- verify: node --test tests/worker
- review: optional
- depends_on: T22
- acceptance: |
  В `cleanText()` декодировать HTML-сущности до вырезания тегов.
  `&lt;p&gt;` и другие экранированные теги не попадают в текст.
  Нет двойного декодирования и порчи `&amp;`.
  Пробелы/переносы нормализуются, пустой результат отбрасывается.
  `npm run verify` и `node --test tests/worker` проходят.

## [ ] T18 · Статический feed.json и GitHub Actions
- area: delivery
- priority: high
- files: js/data.js, .github/workflows/feed-sync.yml, feed.ru.json, feed.en.json, feed.zh.json, docs/CONVENTIONS.md, tests/feed-sync/**
- context: docs/CONVENTIONS.md, docs/harness/OPERATING.md
- verify: node --test tests/feed-sync
- review: required
- depends_on: T07, T08
- acceptance: |
  При старте страница сразу показывает language-specific localStorage cache; фоновое обновление пробует `./feed.<lang>.json`, затем Worker GET. Любой валидный ответ сохраняется в соответствующий cache; при сетевых ошибках/битом JSON старый cache не очищается.
  Static feed имеет схему T08 `{ items, lastUpdated }`, содержит не более 50 записей для конкретного `lang` и валидируется до публикации. Если файл отсутствует/невалиден, выполняется попытка Worker; если Worker также недоступен, используется сохранённый cache.
  `.github/workflows/feed-sync.yml` запускается по расписанию и вручную, забирает только опубликованную Worker-ленту для ru/en/zh, проверяет schema/лимит/язык, записывает `feed.<lang>.json` и коммитит только при diff. Невалидный ответ не коммитится; workflow завершает шаг ошибкой с понятным логом.
  Feed-sync не вызывает POST refresh, не редактирует `TASKS.md` и не использует `fa/work`; его concurrency-group и credentials отделены от FA workflow.
  Проверки покрывают cache-first paint, порядок static→Worker fallback, битый JSON, сохранение старого cache, schema и no-op commit при отсутствии изменений.
  `npm run verify` и `node --test tests/feed-sync` проходят без Worker refresh и внешних API.

## [ ] T20 · Редактор темы и шрифта
- area: frontend
- priority: normal
- files: css/styles.css, settings.html, js/settings.js, js/data.js, js/ui.js
- context: docs/CONVENTIONS.md
- verify: npm run verify:ui
- review: optional
- depends_on: T03, T04, T24, T25, T26, T27
- acceptance: |
  Добавить в секцию «Интерфейс» выбора шрифта и редактор четырёх CSS-переменных: фон, основной текст, акцент и граница. Не менять существующие четыре именованных пресета тем и их значения.
  Шрифты: JetBrains Mono, Fira Code, системный monospace; загружать новые шрифты или добавлять CDN/зависимости нельзя.
  Цвета принимают только `#RGB`/`#RRGGBB`; невалидный ввод не применяется и не сохраняется. Кнопка сброса возвращает активный пресет и системный шрифт.
  Сохранение — только через новые именованные ключи `STORAGE_KEYS.FONT` и `STORAGE_KEYS.THEME_COLORS` с суффиксом `_v1`; значения применяются на обеих страницах до первого рендера. Ошибки localStorage и повреждённый JSON безопасно игнорируются.
  Пользовательский CSS остаётся последним применённым слоем и имеет приоритет над цветами редактора. Все контролы находятся в accordion T04; выбор шрифта использует его inline-dropdown, цветовой ввод не открывает модальное окно.
  Проверить каждую тему, три шрифта, валидные/невалидные цвета, reload, reset и приоритет custom CSS на обеих страницах.
  `npm run verify` и `npm run verify:ui` проходят.

## [ ] T21 · Не отмечать новость прочитанной при скролле и выделении
- area: frontend
- priority: high
- files: js/main.js, js/feed.js, js/data.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: npm run verify:ui -- --task T21
- review: optional
- depends_on: T07
- ui: |
  expect-eval (() => { localStorage.setItem("fain_lang_v1", "ru"); localStorage.setItem("fain_cached_items_v2_ru", JSON.stringify([{ id: 984001, url: "https://example.com/story", source: "Fixture", publishedAt: "2026-01-01T00:00:00.000Z", tag: "test", title: "Harness fixture", summary: "Fixture summary", analysis: "Fixture analysis" }])); localStorage.setItem("fain_last_updated_v1_ru", "2026-01-01T00:00:00.000Z"); localStorage.setItem("fain_read_ids_v1", "[]"); return true; })()
  goto index.html
  expect-eval Boolean(document.querySelector(".news-description"))
  click .news-description
  click .news-description
  expect-eval document.querySelector(".news-description") && JSON.parse(localStorage.getItem("fain_read_ids_v1") || "[]").length === 0
  expect-eval (() => { const text = document.querySelector(".news-description"); if (!text) return false; const range = document.createRange(); range.selectNodeContents(text); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); text.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })); document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); window.scrollTo(0, document.body.scrollHeight); return JSON.parse(localStorage.getItem("fain_read_ids_v1") || "[]").length === 0; })()
  expect-eval (() => { const link = document.querySelector(".news-description")?.closest("article, .news-card, .news-item")?.querySelector("a[href]"); if (!link) return false; link.href = "#fa-smoke-link"; link.setAttribute("data-fa-smoke-link", "target"); return true; })()
  click [data-fa-smoke-link="target"]
  expect-eval JSON.parse(localStorage.getItem("fain_read_ids_v1") || "[]").length === 0
  expect-eval Boolean(document.querySelector('button[data-action="mark-read"]'))
  click button[data-action="mark-read"]
  expect-eval JSON.parse(localStorage.getItem("fain_read_ids_v1") || "[]").includes(984001)
  goto index.html
  expect-eval JSON.parse(localStorage.getItem("fain_read_ids_v1") || "[]").includes(984001)
  expect-eval (() => { const button = document.querySelector('button[data-action="mark-read"]'); if (!button) return false; button.focus(); return true; })()
  press Enter
  expect-eval JSON.parse(localStorage.getItem("fain_read_ids_v1") || "[]").includes(984001)
  goto index.html
  expect-eval (() => { const button = document.querySelector('button[data-action="mark-read"]'); if (!button) return false; button.focus(); return true; })()
  press Space
  expect-eval JSON.parse(localStorage.getItem("fain_read_ids_v1") || "[]").includes(984001)
- acceptance: |
  Обычный клик по описанию, drag, выделение текста, прокрутка страницы и переход по ссылке не меняют read-state и не скрывают карточку.
  Единственный способ отметить новость прочитанной — отдельная видимая кнопка `button[data-action="mark-read"]` в карточке; double-click и клик по описанию не являются действиями.
  Кнопка — `button`, работает мышью, touch, Enter и Space; её локализованные текст и `aria-label` присутствуют в ru/en/zh. Не обещать toggle, если текущая модель данных не поддерживает снятие read-state.
  После явного действия `fain_read_ids_v1` обновлён, состояние переживает reload и не удаляет другие read IDs.
  Browser verification выполняет сценарий из `ui` на русском языке и сообщает отдельный результат для кликов по описанию, выделения/прокрутки, ссылки, кнопки, клавиатуры и reload. I18N parity проверяется для ru/en/zh. `npm run verify` и `npm run verify:ui -- --task T21` проходят.

## [ ] T22 · Откат backend-изменений FA
- area: backend
- priority: high
- files: worker.js, wrangler.toml
- context: docs/CONVENTIONS.md, docs/harness/GOVERNANCE.md
- verify: node scripts/verify.mjs
- review: required
- acceptance: |
  Базовая одобренная ревизия для `worker.js` и `wrangler.toml`: `d39f82bbaf79bba50a1a042732b791c7cdaa0d02` (непосредственно до backend-коммитов T08/T09).
  Вернуть только `worker.js` и `wrangler.toml` к этому SHA; не делать общий `git revert` и не затрагивать frontend (включая T07), harness, workflow, secrets и variables.
  PR содержит hash базы и точный diff этих двух файлов. Проверить `git diff d39f82bbaf79bba50a1a042732b791c7cdaa0d02 -- worker.js wrangler.toml` на отсутствие остаточных backend-изменений.
  Worker GET сохраняет контракт базовой версии; страница загружается без JS errors. Не выполнять очистку KV и не менять production data автоматически; несовместимость данных оформить отдельной блокирующей миграцией без потери `fain_read_ids_v1`.
  `npm run verify` проходит, diff содержит только разрешённые backend-файлы.

## [ ] T23 · Живое относительное время без перезагрузки
- area: frontend
- priority: high
- files: js/feed.js, js/data.js, js/main.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
  Метка `time` в подвале обновляется без reload и полного rerender feed; обновление меняет только text node метки и сохраняет DOM-узел карточки.
  На странице ровно один активный interval 30–60 секунд независимо от числа карточек и повторных render; повторная инициализация очищает прежний interval/listeners.
  При `document.hidden === true` callback не меняет DOM. `visibilitychange` в visible и `focus` немедленно пересчитывают все метки.
  Смена локали запускает немедленный пересчёт ru/en/zh с формами T01. Пороговые переходы: <1 мин, 1 мин, 1 час, 1 день, 30 дней и >30 дней; invalid date скрывает time element и никогда не показывает `Invalid Date`.
  Unit/browser tests используют fake clock и контролируемые document events; проверяют количество timers/listeners, identity card/text node, пороговые переходы и смену локали.
  `npm run verify` и `npm run verify:ui` проходят.
