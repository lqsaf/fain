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

## [ ] T04 · Настройки 2.0: аккордеон и inline-дропдауны
- area: frontend
- priority: high
- files: settings.html, js/settings.js, js/ui.js, js/data.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- note: Первая итерация (нативные select, статичные секции) отклонена владельцем. Переработать существующую страницу, а не оставлять как есть.
- acceptance: |
  Секции «Интерфейс», «Язык», «Прочее» — аккордеон: клик по заголовку разворачивает/сворачивает поднастройки вниз, в потоке страницы, с плавной анимацией высоты.
  Заголовок секции — кнопка с `aria-expanded`/`aria-controls`, активируется с Enter/Space; свёрнутое содержимое не фокусируется и скрыто от скринридера.
  По умолчанию открыта «Интерфейс», остальные свёрнуты; набор открытых секций запоминается в localStorage и восстанавливается после reload.
  Все выпадающие списки — кастомный компонент вместо нативного `<select>`: список разворачивается вниз под триггером внутри страницы и раздвигает контент; никакого нативного popup ОС, оверлеев и модальных окон.
  Триггер показывает текущее значение; в списке текущий вариант отмечен; выбор применяется сразу и переживает reload.
  Клавиатура: Enter/Space и стрелки открывают список и ведут по нему, Home/End — края, Enter — выбор, Escape — закрытие без изменения; клик вне компонента закрывает список; focus-visible в терминальном стиле.
  Корректные ARIA-роли (combobox/listbox/option или эквивалент); поведение одинаково для мыши, тача и клавиатуры.
  Длинный список ограничен по высоте с внутренним скроллом, стилизованным под терминал; на мобильной вёрстке список не выходит за экран.
  Состав: Интерфейс — тема, масштаб, шрифт, ASCII-волны; Язык — язык; Прочее — пользовательский CSS. Подписи и варианты локализованы в ru/en/zh.
  Не регрессировать T03: нет вспышки темы при reload, топ-панель прозрачная, inline-скрипт в `<head>` сохранён.
  `node scripts/verify.mjs` проходит.

## [ ] T05 · Масштаб интерфейса
- area: frontend
- priority: normal
- files: js/data.js, js/settings.js, js/ui.js, settings.html, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T04
- acceptance: |
  Добавить настройку «Масштаб интерфейса»: 90%, 100%, 110%, 120%.
  `STORAGE_KEYS.SCALE = "fain_scale_v1"`.
  Значение применяется к `document.documentElement.style.fontSize` на обеих страницах до первого рендера.
  Выбор сохраняется, переживает reload и не ломает мобильную вёрстку.
  Выбор масштаба — кастомным inline-дропдауном из T04, внутри секции «Интерфейс».
  `node scripts/verify.mjs` проходит.

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
  `fain_read_ids_v1` остаётся общим и не теряется.
  Старые ключи мигрируют один раз без потери прочитанных ID.
  После смены языка лента сразу показывает карточки целевого языка.
  `node scripts/verify.mjs` проходит.

## [ ] T08 · Мультиязычный pipeline в worker.js
- area: backend
- priority: high
- files: worker.js, wrangler.toml
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T22
- note: Прошлая реализация откачена (T22). Делать заново поверх восстановленной базовой версии worker.js, аккуратно, с review.
- acceptance: |
  Принимать `?lang=ru|en|zh` и отдавать `title`, `summary`, `analysis` на нужном языке.
  Шаги 0 (пре-фильтр RSS), 1 (отбор тем), 2 (дедупликация) и 4 (теги) выполняются один раз на английских источниках.
  Нет цепочки EN → RU → EN; выжимки генерируются сразу на трёх языках из английского источника.
  Локализованные поля хранятся в KV внутри одного объекта (или вынесены во второй воркер при лимитах).
  Неизвестный/отсутствующий `lang` даёт безопасный fallback (ru), без 500.
  Качество отбора не ниже базовой версии; критерии важности подключаются отдельно в T10.
  `node scripts/verify.mjs` проходит.

## [ ] T09 · Убрать жёсткую привязку к кириллице
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
  Убрать `isRussianText()` / `isValidRussianItem()` и русскоязычную валидацию как единственную.
  Валидация учитывает `lang` и проверяет непустые/осмысленные поля, а не алфавит.
  EN и ZH элементы не отбрасываются и не помечаются невалидными.
  Ошибочные/пустые ответы модели по-прежнему отбрасываются.
  `node scripts/verify.mjs` проходит.

## [ ] T10 · Только самые важные новости: 1–2 в час
- area: backend
- priority: high
- files: worker.js, wrangler.toml
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
  Пайплайн запускается каждый час (cron `0 * * * *` в wrangler.toml, scheduled handler) и отбирает 1–2 самые важные новости часа. Жёсткого дневного лимита нет; старую логику «не более 5 в день» убрать полностью.
  Важное — свершившийся технический факт: релиз новой модели или версии (веса/API/доступность), выпуск агентной системы/фреймворка/инструмента, крупный исследовательский результат с артефактом (paper + код/веса/бенчмарк), значимое GA-обновление крупного продукта.
  Не важное — предложения и инициативы («предложил», «обсудил», визиты, протокольные мероприятия), анонсы без подтверждения/даты/артефакта, слухи и утечки без официального подтверждения, политика вокруг ИИ без прямого технического результата, мнения, колонки, подборки, сплетни.
  Контрпример (не публиковать): «Трамп предложил создать ИИ-хаб на Филиппинах» — лишь предложение, ничем не заверенный анонс.
  Важность оценивается по явной рубрике в промпте Gemini (score 0–100); порог отсечения фиксирован в коде; score и причина решения логируются без ключей.
  Если за час нет ничего выше порога — не публикуется ничего. Квота не заполняется ради заполнения: лучше пусто, чем сплетни.
  Окно источников — последний час с небольшим перекрытием, чтобы не терять новости на границе; дедупликация против хранилища.
  Лимит 1–2 учитывается при записи в KV и при отдаче ленты; повторный запуск пайплайна в том же часу не превышает лимит; счётчик часа восстанавливается из KV после рестарта воркера.
  Отбор детерминирован: одинаковый вход даёт одинаковый результат.
  При первом прогоне после внедрения существующий KV очищается от карточек, не проходящих новые критерии.
  `node scripts/verify.mjs` проходит.

## [ ] T11 · Исключить случайные пропуски новостей
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
  Убрать случайные пропуски новостей при отборе/дедупликации.
  Одинаковый вход даёт одинаковый результат (детерминированный порядок, стабильные ключи).
  Элемент не теряется из-за гонки между чтением KV и записью.
  Дедупликация не удаляет легитимно разные новости с похожими заголовками.
  `node scripts/verify.mjs` проходит.

## [ ] T12 · KV: хранить 200, отдавать 50
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08
- acceptance: |
  Хранить в KV последние 200 новостей (или все за текущий месяц), в кэше/feed.json отдавать последние 50.
  Остальные ~150 используются только для проверки на дубли.
  Сортировка по `publishedAt` убывающая, ID уникальны.
  Ответ `GET` не превышает 50 элементов, KV не растёт бесконечно.
  `node scripts/verify.mjs` проходит.

## [ ] T13 · Улучшить сравнение новостей на уникальность
- area: backend
- priority: normal
- files: worker.js, wrangler.toml
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T08, T12
- acceptance: |
  Улучшить дедупликацию: сравнение по тегам/нормализованным сущностям, а не только по заголовку.
  Похожие пересказы одного события схлопываются, разные события с общими словами — нет.
  Решение детерминировано и логируется.
  При упоре в лимиты Gemini допускается выделение сравнения в отдельный воркер; контракт API сохраняется.
  `node scripts/verify.mjs` проходит.

## [ ] T15 · Защитить POST /refresh и GET
- area: backend-security
- priority: high
- files: worker.js, wrangler.toml
- context: docs/harness/GOVERNANCE.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T22
- acceptance: |
  Закрыть `POST /refresh` секретным токеном и защитить GET от тяжёлого пайплайна.
  `POST /refresh` требует `Authorization: Bearer <env.REFRESH_TOKEN>`; без токена — 401.
  GET при пустом KV не запускает генерацию; отдаёт 202/пустую ленту и понятный статус.
  Токен не логируется; сравнение timing-safe.
  `node scripts/verify.mjs` проходит.

## [ ] T16 · Таймаут Gemini через AbortController
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T08
- acceptance: |
  Добавить `AbortController` с таймаутом 12–15 секунд в `callGeminiWithFallback`.
  Таймер очищается во всех ветках; зависший запрос не держит воркер.
  По таймауту срабатывает fallback на следующий ключ/модель.
  Ошибка таймаута логируется без ключей и тел запросов.
  `node scripts/verify.mjs` проходит.

## [ ] T17 · cleanText: сначала decodeEntities, потом теги
- area: backend
- priority: high
- files: worker.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- depends_on: T22
- acceptance: |
  В `cleanText()` декодировать HTML-сущности до вырезания тегов.
  `&lt;p&gt;` и другие экранированные теги не попадают в текст.
  Нет двойного декодирования и порчи `&amp;`.
  Пробелы/переносы нормализуются, пустой результат отбрасывается.
  `node scripts/verify.mjs` проходит.

## [ ] T18 · Статический feed.json и GitHub Actions
- area: delivery
- priority: high
- files: js/data.js, .github/workflows/feed-sync.yml
- context: docs/CONVENTIONS.md, docs/harness/OPERATING.md
- verify: node scripts/verify.mjs
- review: required
- depends_on: T07, T08
- acceptance: |
  Настроить доставку ленты без VPN через статический `feed.json`.
  `fetchAndSyncNews()` сначала пробует `./feed.json` (или `./feed.<lang>.json`), затем воркер, затем кэш.
  Ошибка/битый JSON не ломает страницу.
  Workflow `.github/workflows/feed-sync.yml` по cron и вручную забирает ленту у воркера, пишет `feed.json`/`feed.<lang>.json`, коммитит только при изменении.
  Сценарий FA-харнеса отдельный и не пересекается с feed-sync.
  `node scripts/verify.mjs` проходит.

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
  CSS переписан на переменные: фон, основной текст, акцент, границы, шрифт.
  В настройках можно выбрать шрифт (JetBrains Mono / Fira Code / системный моноширинный) и изменить базовые цвета темы.
  Значения сохраняются в localStorage, применяются на обеих страницах и сбрасываются к пресету.
  Пользовательский CSS по-прежнему имеет приоритет.
  Все контролы — в аккордеоне и кастомных inline-дропдаунах из T04, без нативных popup.
  `node scripts/verify.mjs` проходит.

## [ ] T21 · Не отмечать новость прочитанной при скролле и выделении
- area: frontend
- priority: high
- files: js/main.js, js/feed.js, js/data.js, css/styles.css
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
  Убрать случайные пропуски новостей: сейчас клик по `.news-description` сразу скрывает карточку.
  Прочитанным считается только явное действие: отдельная кнопка «✓ прочитано» или double-click.
  Скролл, drag и выделение текста не скрывают карточку.
  Кнопка доступна с клавиатуры (`Enter`/`Space`) и имеет локализованный `aria-label`.
  Поведение одинаково для мыши, тача и клавиатуры.
  `node scripts/verify.mjs` проходит.

## [ ] T22 · Откат backend-изменений FA
- area: backend
- priority: high
- files: worker.js, wrangler.toml
- context: docs/CONVENTIONS.md, docs/harness/GOVERNANCE.md
- verify: node scripts/verify.mjs
- review: required
- acceptance: |
  Вернуть `worker.js` и `wrangler.toml` к последней одобренной владельцем ревизии до backend-работ FA (до T08/T09). В PR указать hash базового коммита, к которому выполнен откат.
  Откатывается только backend: фронтенд (включая T07), harness-файлы и workflow не трогать.
  После отката GET ленты работает как в базовой версии, страница грузится без ошибок; временный fallback языка допустим до переделки T08.
  Если откаченный пайплайн успел записать в KV несовместимые данные — привести их к базовому формату или очистить с пересборкой, без потери `fain_read_ids_v1`.
  Секреты и переменные окружения не меняются и не логируются.
  `node scripts/verify.mjs` проходит.

## [ ] T23 · Живое относительное время без перезагрузки
- area: frontend
- priority: high
- files: js/feed.js, js/data.js, js/main.js
- context: docs/CONVENTIONS.md
- verify: node scripts/verify.mjs
- review: optional
- acceptance: |
  Относительное время в подвале обновляется само, без перезагрузки страницы и без полного ререндера ленты.
  Один таймер (~30–60 с) обновляет только текстовый узел времени; повторные рендеры ленты не плодят таймеры и слушатели.
  На скрытой вкладке (`document.hidden`) тики пропускаются; при возврате видимости (`visibilitychange`) и фокусе — немедленное обновление.
  Смена языка мгновенно пересчитывает строку: форматы и склонения ru/en/zh.
  Переходы «только что» → «N минут назад» → «M часов назад» → «K дней назад» → абсолютная дата (>30 дней) происходят на лету.
  «Invalid Date» не показывается никогда; при невалидной дате время скрывается.
  `node scripts/verify.mjs` проходит.
