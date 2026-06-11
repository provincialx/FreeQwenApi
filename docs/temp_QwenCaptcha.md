# WAF/CAPTCHA Bypass — Current Status (2026-06-11)

## Problem Summary

Aliyun WAF блокирует все запросы к Qwen Chat API от Node.js и sandboxed browser contexts. Ручной Chrome работает идеально, автоматизация падает на каждом уровне.

---

## Что мы знаем о защите Qwen

### Уровень 1: Aliyun WAF (Node-fetch)
- Возвращает HTTP **200** с HTML challenge page вместо SSE/JSON
- Маркеры: `<meta name="aliyun_waf_aa">`, `_waf_is_mob`, `void 0===window.console`
- Блокирует по IP/token после первого обнаружения
- Retrying тот же Node-fetch бесполезно — сервер "помнит"

### Уровень 2: CSP/COOP (evaluate fetch/XHR)
- `fetch()` внутри `page.evaluate()` → **`TypeError: Failed to fetch`** мгновенно (1.3s)
- Заблокировано политиками Content-Security-Policy страницы Qwen Studio
- Headers, cookies, localStorage — все валидные и есть на странице

### Уровень 3: XHR network block
- `XMLHttpRequest` внутри evaluate → **`XHR network error`** мгновенно (0.5s)
- Работает даже с `setBypassCSP('all')` и правильными cookies
- Причина: Chromium sandboxed world где execute API blocked или blocked на уровне browser CSP

### Уровень 4: Execution context destruction
- При использовании main контекста: `goto()` уничтожает execution context
- Если XHR запущен до полной загрузки документа → network error
- Если запустить после goto() — evaluate не успевает отработать (context destroyed by navigation)

---

## Timeline походов к решению

### Path 1: Node-fetch (основной путь)
```
✓ Быстрый, не блокирует CDP
✗ WAF возвращает HTML challenge → падает в fallback
```

**Status:** Работает как "пробный шар" — если WAF отпустил, ответ придёт быстро. Если нет — мгновенная передача Path 2.

### Path 2: Browser-evaluate (fallback)

| Подход | Результат | При чём виновата |
|--------|-----------|-----------------|
| `fetch()` внутри evaluate | `TypeError: Failed to fetch` (1.3s) | CSP/COOP блокировка same-origin |
| `fetch()` + relative URL + credentials | `Failed to fetch` (1.2s) | То же самое, headers не помогают |
| `XMLHttpRequest` + setBypassCSP | `XHR network error` (0.5s) | Sandbox execution context block |
| XHR на pagePool-странице | `XHR network error` | Страница без контекста сессии |
| XHR на main context | `Execution context destroyed` | goto() убивает висящий evaluate |

### Отображение: "вручную работает, кодом нет"

**Что делает ручной Chrome:**
1. Нормальная страница → нормальный execution context
2. Пользователь печатает сообщение → Qwen frontend сам делает XHR к API
3. Cookies + token + origin — все корректные
4. Нет WAF блокировки (реальный браузер, настоящий пользователь)

**Что пытается делать наш код:**
1. `page.evaluate()` запускает JS в **isolated world** Chromium
2. Isolated world не имеет доступа к network requests на некоторые домены внутри sandboxed execution context
3. Даже с CSP bypass и cookies → XHR отклоняется на уровне браузера

---

## Возможные пути решения (гипотезы)

### Вариант A: Вызвать нативный API-клиент Qwen страницы
Вместо своего fetch/XHR — найти как Qwen Studio фронтенд отправляет запрос к своему бэкенду и вызвать ту же функцию. Если они используют собственный abstraction layer (например, через их JS framework), возможно обходить блокировку через него.

**Сложность:** Нужно исследовать frontend bundle Qwen Studio. Высокая сложность.

### Вариант B: Запустить Chrome в режиме `--disable-web-security`
Chrome уже запускается с этим флагом (`--disable-web-security`, `--disable-features=IsolateOrigins,site-per-process`). Но isolated world evaluate всё равно не пускает XHR — это **отдельный механизм** от CSP.

### Вариант C: Использовать WebSocket вместо HTTP
Qwen может поддерживать WS для SSE streaming. Если да — подключиться через WebSocket внутри evaluate и обойти блокировку HTTP request entirely.

**Сложность:** Нужно найти URL WebSocket endpoint в трафике Qwen Studio.

### Вариант D: Проксируемый fetch из content-script context
`page.evaluate()` использует isolated world, который ограничен sandboxом. Альтернатива — inject script напрямую в main execution world через `page.addScriptTag()` или `page.exposeFunction()`. Это может дать доступ к network requests.

**Сложность:** Требует эксперимента с injection-паттернами. Может сломаться при обновлении Qwen frontend.

### Вариант E: Полностью отказаться от browser-evaluate Path 2
Если WAF блокирует Node-fetch, а evaluate не даёт сделать запросы — единственный работающий путь: **headless режим без stealth**, с полноценным Chromium где JS-сценарий запускается через `page.exposeFunction()` + inject на страницу.

**Сложность:** Риск обнаружения, но работает.

### Вариант F: Подождать пока WAF отпустит
WAF может блокировать по времени/IP. Если подождать N минут/часов — Node-fetch снова заработает. Path 1 станет основным снова без необходимости Path 2.

---

## Что работает НАВЕРНЯКА (baseline)

1. ✅ Ручной Chrome → печатаешь в поле ввода → Qwen отвечает
2. ✅ `initBrowser(true)` → ручной логин → авторизация проходит, cookies сохраняются
3. ✅ `sendMessage()` с Node-fetch → работает когда WAF отпустил IP
4. ✅ Создание чата через `createChatV2` → работает (использует browser evaluate для auth token только)

## Что сломано НАВЕРНЯКА

1. ❌ Node-fetch после WAF challenge — permanent block до expiration
2. ❌ Browser fetch/XHR внутри page.evaluate() — blocked навсегда
3. ❌ Параллельные запросы через Pool → все падают одинаково
4. ❌ Смена URL/headers/credentials не помогает

## Рекомендации для следующего шага

1. **Приоритет 1:** Исследировать frontend Qwen Studio в DevTools. Найти как они делают XHR к `/api/v2/chat/completions`. Возможно, используют нестандартный подход который мы копируем неправильно.
2. **Приоритет 2:** Попробовать `page.addScriptTag()` вместо `page.evaluate()` — inject script напрямую в main world где network unrestricted.
3. **Приоритет 3:** Если всё безнадёжно → вернуться к полной browser automation (отправка сообщения через UI как в ручном режиме).
