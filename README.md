# FreeQwenApi — ForgetMeAI fork

> **Локальный OpenAI-compatible прокси к Qwen Chat**. Контакты: `mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)
> Текст, модели Qwen 3.7, файлы, Open WebUI, генерация изображений и видео через Qwen Chat.

![Contact](https://img.shields.io/badge/Contact-mandrykinsergey@-blue)
![API](https://img.shields.io/badge/API-OpenAI--compatible-green)
![Qwen](https://img.shields.io/badge/Qwen-Chat-purple)

## Что это такое

FreeQwenApi превращает веб-аккаунт Qwen Chat в локальный API endpoint:

```text
http://localhost:3264/api
```

Это **не локальная модель на вашей видеокарте** и **не официальный API Alibaba/Qwen**. Это практичный browser-based proxy: вы авторизуетесь в Qwen Chat, проект сохраняет сессию и даёт локальный OpenAI-compatible API для ваших инструментов.

## Возможности fork

- **Chat Completions API**: `POST /api/chat/completions`, совместимый с OpenAI SDK, Open WebUI, LiteLLM и агентами.
- **Актуальные модели Qwen Chat**: `qwen3.7-max`, `qwen3.7-plus`, `qwen3.6-plus` и другие модели из `src/AvailableModels.txt`.
- **Мультиаккаунты**: добавление, перелогин, удаление, статусы `OK` / `WAIT` / `INVALID`, автоматическая round-robin ротация при лимитах.
- **Загрузка файлов**: upload endpoint для файлов и вложений Qwen.
- **Open WebUI**: можно подключить как OpenAI-compatible backend.
- **Health/smoke tooling**: `/api/health`, `/api/status`, `/api/models`, `npm run smoke`, `npm run models:sync`.
- **Contact info**: watermark с контактами в README, CLI и health metadata.

## Быстрый старт

```bash
git clone https://github.com/ForgetMeAI/FreeQwenApi
cd FreeQwenApi
npm install
npm run auth
npm run models:sync
SKIP_ACCOUNT_MENU=true npm start
```

В другом терминале:

```bash
npm run smoke
```

Если всё хорошо, API доступен здесь:

```text
http://localhost:3264/api
```

## Авторизация Qwen Chat

Добавить аккаунт:

```bash
npm run auth
```

Или сразу конкретное действие:

```bash
npm run auth -- --add
npm run auth -- --list
npm run auth -- --relogin
npm run auth -- --remove
```

При добавлении аккаунта откроется Chromium. Войдите в Qwen Chat, затем вернитесь в терминал — токен будет сохранён в `session/`.

**Не коммитьте и не публикуйте секреты:**

- `session/`
- `session/tokens.json`
- `session/accounts/**/token.txt`
- `.env`
- `Authorization.txt`
- cookies / browser profile / реальные токены

## Основные endpoints

### Health

```bash
curl http://localhost:3264/api/health
```

Ответ содержит количество моделей, аккаунтов и watermark:

```json
{
  "ok": true,
  "service": "FreeQwenApi",
  "watermark": "mandrykinsergey@gmail.com | twitch.tv/dnovitv",
  "baseUrl": "/api",
  "models": 28
}
```

### Список моделей

```bash
curl http://localhost:3264/api/models
```

Обновить список моделей из Qwen Chat metadata:

```bash
npm run models:sync
```

Подробный отчёт: [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md)

### Chat Completions

```bash
curl http://localhost:3264/api/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "qwen3.7-max",
    "messages": [
      {"role": "user", "content": "Ответь коротко: что такое FreeQwenApi?"}
    ],
    "stream": false
  }'
```

OpenAI SDK:

```js
import OpenAI from 'openai';

const openai = new OpenAI({
  baseURL: 'http://localhost:3264/api',
  apiKey: 'dummy-key'
});

const response = await openai.chat.completions.create({
  model: 'qwen3.7-max',
  messages: [{ role: 'user', content: 'Привет!' }]
});

console.log(response.choices[0].message.content);
```

## Open WebUI

Для локального Open WebUI:

```text
Base URL: http://localhost:3264/api
API Key: dummy-key
Model: qwen3.7-max
```

Если Open WebUI в Docker:

```text
Base URL: http://host.docker.internal:3264/api
API Key: dummy-key
```

Полная инструкция: [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md)



## Docker

Сначала добавьте аккаунт локально, потому что внутри контейнера нет GUI для входа:

```bash
npm run auth
```

Потом:

```bash
docker compose up --build -d
```

В `docker-compose.yml` важно пробросить `session/`:

```yaml
services:
  qwen-proxy:
    build: .
    environment:
      - SKIP_ACCOUNT_MENU=true
      - PORT=3264
    ports:
      - "3264:3264"
    volumes:
      - ./session:/app/session
      - ./logs:/app/logs
      - ./uploads:/app/uploads
```

## Рекомендуемые модели

- **Обычный чат / агенты**: `qwen3.7-max`
- **Быстрее и легче**: `qwen3.7-plus`
- **Кодинг**: `qwen3-coder-plus`
- **Open WebUI default**: `qwen3.7-max`

## Полезные команды

```bash
npm run auth                  # управление аккаунтами
npm run models:sync           # обновить список моделей
npm run smoke                 # быстрая проверка API
SKIP_ACCOUNT_MENU=true npm start
```

Проверки руками:

```bash
curl http://localhost:3264/api/health
curl http://localhost:3264/api/status
curl http://localhost:3264/api/models
```

## Разработка

**ESLint + Prettier** — установлен и настроен. Запуск перед коммитом:

```bash
npm run lint          # найти проблемы
npm run lint:fix      # автофикс (где возможно)
npm run format        # форматирование Prettier
```

**Тесты + покрытие:**

```bash
npm test              # юнит-тесты (43 теста, node:test)
npm run test:cov      # тесты с coverage report (c8)
```

## Документация

- [docs/FORK_DEMO_QUICKSTART.md](docs/FORK_DEMO_QUICKSTART.md) — быстрый сценарий для демо.
- [docs/QWEN_CHAT_MODELS.md](docs/QWEN_CHAT_MODELS.md) — отчёт синхронизации моделей Qwen Chat.
- [docs/OPENWEBUI_SETUP.md](docs/OPENWEBUI_SETUP.md) — подключение Open WebUI.

## Ограничения

- Это неофициальный browser-based proxy, Qwen может менять внутренний API.
- Аккаунты Qwen Chat могут ловить лимиты; используйте несколько аккаунтов для round-robin.
- Токены истекают — используйте `npm run auth -- --relogin`.
- Для production используйте осторожно: это инструмент для экспериментов, демо и локальных workflow.

## Поддержать автора

Если проект помог — пишите: `mandrykinsergey@gmail.com` | [twitch.tv/dnovitv](https://www.twitch.tv/dnovitv)
