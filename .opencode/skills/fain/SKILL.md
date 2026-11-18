---
name: fain
description: Домен fain — статическая лента AI-новостей, темы, i18n, localStorage, Cloudflare Worker. Используй при задачах по frontend, feed и worker.
---

# fain — доменная шпаргалка

## Что это

Статический сайт без сборщиков: `index.html` (лента), `settings.html` (настройки), ES-модули в `js/`, стили в `css/styles.css`, Cloudflare Worker в `worker.js` (RSS → Gemini → KV).

## Данные

`js/data.js` — единственный источник `STORAGE_KEYS` и `I18N`.

| Ключ | Значение |
| --- | --- |
| `ITEMS` | `fain_cached_items_v2` |
| `READ_IDS` | `fain_read_ids_v1` |
| `LAST_UPDATED` | `fain_last_updated_v1` |
| `LANG` | `fain_lang_v1` |
| `THEME` | `fain_theme_v1` |
| `ASCII` | `fain_ascii_v1` |
| `CUSTOM_CSS` | `fain_custom_css_v1` |

Правила: только через `STORAGE_KEYS`, формат `fain_*_vN`, запись в `try/catch`, миграция старых значений. Кэш ленты и `lastUpdated` будут разделены по языку (T07).

## Локализация

- Языки: `ru`, `en`, `zh`. Набор ключей одинаковый, пустых строк нет.
- Новая UI-строка добавляется сразу во все три локали.
- `locale` — для `toLocaleString`/`Intl`.
- Не хардкодить русский текст в JS/HTML, если его видит пользователь.

## Темы и UI

- `data-theme` на `<html>`: `dark`, `light`, `amber`, `phosphor`.
- Цвета — CSS-переменные; хардкод цветов в правилах не нужен.
- Тема применяется синхронно в `<head>` до CSS, иначе будет вспышка.
- Верхняя панель прозрачная, без blur; скрытие по скроллу — в `js/ui.js`.
- Масштаб — `font-size` на `<html>`, не `zoom`.
- Уважать `prefers-reduced-motion`, `aria-label`, клавиатуру.

## Лента

- Контракт: `{ items: [...], lastUpdated: "ISO" }`.
- Элемент: `id`, `title`, `summary`, `analysis`, `tag`, `url`, `publishedAt`.
- Сортировка по `publishedAt` убывающая, дубли по `id` схлопываются.
- Сначала кэш, потом сеть, потом `feed.json`, потом пустое состояние.
- «Прочитано» — отдельно от кэша, окно 30 дней.
- `innerHTML` только для статичных статусов; пользовательские данные — `textContent`/`createElement`.

## Worker

- KV binding `FAIN_KV`, cron каждый час.
- `GET /?lang=ru|en|zh` — лента; `POST /refresh` — генерация (токен, T15).
- Ключи Gemini только из `env` (`getGeminiKeys(env)`), без дублей и логов.
- Внешние запросы — `AbortController` 12–15 с, fallback на ключ/модель (T16).
- `cleanText`: сначала decode entities, потом теги (T17).
- Ошибка пайплайна не должна отдавать 500, если в KV есть прошлая лента.

## Частые грабли

1. Забыт ключ в `zh` или `en` → падает `i18n.parity`.
2. Новый `getElementById` без элемента в HTML → падает `html.contract`.
3. Хардкод `fain_*_vN` вне `data.js` → падает `storage.keys`.
4. Новый цвет мимо переменной → тема ломается в light/amber/phosphor.
5. `Date.parse` без проверки → «Invalid Date» в подвале.
6. `innerHTML` с текстом из RSS → XSS.
7. Новая зависимость → нарушение dependency-free.

## Проверки

```bash
npm run verify        # инварианты
npm run verify:json   # машинный формат
npm run fa:queue      # очередь
```

Перед сдачей задачи: зелёный `verify`, минимальный diff, acceptance выполнен.
