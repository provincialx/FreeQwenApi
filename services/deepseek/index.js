// services/deepseek/index.js — Entry point for DeepSeek proxy service
import express from "express";
import bodyParser from "body-parser";

import { addAccountInteractive, clearSession, hasValidSession } from "./browser/auth.js";
import { initBrowserPage, sendViaBrowser, shutdownBrowser } from "./browser/proxyPage.js";
import { logHttpRequest, logInfo, logError, logWarn } from "../../shared/logger/index.js";
import { prompt } from "../../shared/utils/prompt.js";
import { PORT as DEFAULT_PORT, HOST as DEFAULT_HOST } from "../../shared/config.js";

const app = express();

export const port = Number.parseInt(
  process.env.DEEPSEEK_PORT ?? process.env.PORT ?? DEFAULT_PORT,
  10
);
export const host = process.env.HOST || DEFAULT_HOST;

// Middleware
app.use(logHttpRequest);
app.use(bodyParser.json({ limit: "50mb" }));
app.use(bodyParser.urlencoded({ limit: "50mb", extended: true }));

// CORS + Authorization middleware (Relaxed for local dev)
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Origin, X-Requested-With, Content-Type, Accept, Authorization"
  );

  // Accept ANY auth header for localhost. Zed sends 'Bearer sk-...', some clients send custom formats.
  const auth = req.headers.authorization;
  console.log(`[Auth Check] Header: ${auth || "(none)"}`);

  if (req.method === "OPTIONS") return res.sendStatus(204);

  next();
});

// ─── OpenAI-compatible API routes ──────────────────────────────

app.get("/api/v1/models", (req, res) => {
  const models = [
    { id: "deepseek-v3", object: "model" }, // V4 Flash — Быстрый
    { id: "deepseek-chat", object: "model" }, // Alias
    { id: "deepseek-r1", object: "model" }, // Thinking mode (V4 Flash + reasoning)
    { id: "deepseek-reasoner", object: "model" }, // Alias for R1
    { id: "deepseek-expert", object: "model" }, // V4 Pro — Эксперт
    { id: "deepseek-v4-pro", object: "model" }, // V4 Pro — Эксперт + reasoning
  ];

  logInfo(`GET /api/v1/models (client: ${req.ip})`);
  return res.json({ object: "list", data: models });
});

// Health check / GET method helper for API endpoint testing via browser
app.get("/api/v1/chat/completions", (_req, res) => {
  return res.json({
    status: "ok",
    message: "DeepSeek Proxy запущен. Используйте POST для запросов к chat completions.",
    models_available: [
      "deepseek-v3",
      "deepseek-chat",
      "deepseek-r1",
      "deepseek-reasoner",
      "deepseek-expert",
      "deepseek-v4-pro",
    ],
  });
});

// Main chat endpoint — OpenAI compatible
app.post("/api/v1/chat/completions", async (req, res) => {
  const messages = req.body?.messages || [];
  const model = req.body?.model || "deepseek-v3";
  const isStreaming = req.body?.stream === true;

  // Force Puppeteer mode — browser page.solveChatMessage() handles PoW automatically
  logInfo("[Proxy] Маршрутизация через браузер (PoW авто-решение)");

  if (!hasValidSession()) {
    return res.status(401).json({ error: "Сессия не найдена. Запустите авторизацию." });
  }

  // Extract content from messages (DeepSeek web API takes last user message only)
  const userMsg = [...messages].reverse().find((m) => m.role === "user");
  if (!userMsg || !userMsg.content) {
    return res.status(400).json({ error: "Нет пользовательского сообщения." });
  }

  // Prepare full message history context (append previous messages to user content)
  let contentText = "";
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  for (const msg of nonSystemMessages) {
    const roleLabel = msg.role === "user" ? "\nHuman: " : "\nAssistant: ";

    // Handle content array (multimodal images etc.)
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (part.type === "text") {
          contentText += roleLabel + part.text;
        }
      }
    } else {
      contentText += roleLabel + (msg.content || "");
    }
  }

  const startTime = Date.now();

  // Init browser page on first request
  await initBrowserPage();

  try {
    // Send message through authenticated browser context (bypasses PoW validation)
    const apiResult = await sendViaBrowser(messages, model);

    if (!apiResult?.success) {
      logWarn(`DeepSeek ${model}: Browser API returned error — ${apiResult.error}`);
      return res.status(502).json({ error: apiResult.error });
    }

    const fullContent = apiResult.data.content;

    if (!isStreaming) {
      // Non-streaming response
      const completionTokens = estimateTokens(fullContent);

      return res.json({
        id: `chatcmpl-${Date.now()}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop",
          },
        ],
        usage: {
          prompt_tokens: estimateTokens(contentText),
          completion_tokens: completionTokens,
          total_tokens: estimateTokens(contentText) + completionTokens,
        },
      });
    }

    // ─── Streaming response (SSE) ──────────────────────

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    const completionId = `chatcmpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Send initial role chunk
    const roleChunk = buildSSE({
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: { role: "assistant" } }],
    });
    res.write(roleChunk);

    // Send content chunks (simulated streaming from full response)
    const chunkSize = 4; // chars per SSE event
    for (let i = 0; i < fullContent.length; i += chunkSize) {
      const chunk = fullContent.slice(i, i + chunkSize);
      const dataChunk = buildSSE({
        id: completionId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: chunk } }],
      });

      if (!res.writableEnded) res.write(dataChunk);
    }

    // Final [DONE] chunk
    const doneChunk = buildSSE({
      id: completionId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    });

    if (!res.writableEnded) {
      res.write(doneChunk);
      res.end();
      logInfo(
        `DeepSeek ${model}: ответ за ${(Date.now() - startTime / 1000).toFixed(1)}с (${fullContent.length} симв)`
      );
    }
  } catch (err) {
    if (!res.writableEnded) {
      res.json({ error: "Ошибка генерации", details: err.message });
    }
    logError("Ошибка обработки запроса DeepSeek", err);
  }
});

// ─── Helper functions ──────────────────────────────────────

function buildSSE(data) {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function estimateTokens(text) {
  // Rough estimation — ~1 token per word + extra for special chars
  if (!text) return 0;
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  const otherWords = text
    .replace(/[\u4e00-\u9fff]/g, "")
    .split(/\s+/)
    .filter(Boolean).length;
  return chineseChars + Math.ceil(otherWords * 1.2);
}

// Error handling middleware (requires exactly 4 params for Express to recognize it)
app.use((err, req, res, _next) => {
  logError("Внутренняя ошибка сервера", err);
  if (!res.headersSent) {
    res.status(500).json({ error: "Внутренняя ошибка сервера" });
  }
});

export function showAccountMenu() {
  return new Promise(async (resolve) => {
    while (true) {
      console.log("\n=== Меню DeepSeek ===");

      if (!hasValidSession()) {
        console.log("Статус: ❌ Не авторизован");
      } else {
        console.log("Статус: ✅ Авторизован (куки сохранены)");
      }

      console.log("\n1 - Войти в DeepSeek (открыть браузер)");
      console.log("2 - Очистить сессию и выйти заново");
      console.log("3 - Запустить прокси (по умолчанию)");
      console.log("4 - Выход");

      let choice = await prompt("\nВаш выбор (Enter = 3): ");
      if (!choice) choice = "3";

      if (choice === "1") {
        await addAccountInteractive();
      } else if (choice === "2") {
        clearSession();
      } else if (choice === "3") {
        break;
      } else if (choice === "4") {
        console.log("До свидания!");
        process.exit(0);
      }
    }
    resolve();
  });
}

export async function startDeepSeekProxy() {
  logInfo("Запуск DeepSeek прокси...");

  await showAccountMenu();

  try {
    app.listen(port, host, () => {
      const displayHost = host === "0.0.0.0" ? "localhost" : host;
      console.log(`\n🚀 DeepSeek API запущен на http://${displayHost}:${port}`);
      logInfo(`API доступен по адресу: http://localhost:${port}/api/v1/chat/completions`);
      logInfo(
        "Модели: deepseek-v3 (V4 Flash), deepseek-r1 (Thinking), deepseek-expert (V4 Pro), deepseek-v4-pro (Pro+Thinking)"
      );
    });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      logError(`Порт ${port} уже используется.`);
      process.exit(1);
    }
    throw err;
  }
}

// Graceful shutdown
let _shuttingDown = false;
function safeShutdown() {
  if (_shuttingDown) return;
  _shuttingDown = true;
  process.exit(0);
}

async function gracefulShutdown() {
  logInfo("Закрытие прокси...");
  await shutdownBrowser();
  process.exit(0);
}

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);
process.on("uncaughtException", (err) => {
  logError("Необработанное исключение", err);
  process.exit(1);
});

// If started directly as CLI entry:
const isMainModule =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/"));
if (isMainModule) {
  startDeepSeekProxy().catch((error) => {
    logError("Ошибка при запуске сервера DeepSeek", error);
    process.exit(1);
  });
}
