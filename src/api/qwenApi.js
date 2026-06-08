// Depends on chat.js for token state and model validation.
// Use getters/setters — ESM import bindings are immutable.
import {
  getAuthToken,
  setAuthToken,
  extractAuthToken,
  getBrowserTokenRateLimited,
  setBrowserTokenRateLimited,
  isValidModel,
} from "./chat.js";

import {
  getBrowserContext,
  getAuthenticationStatus,
  setAuthenticationStatus,
} from "../browser/browser.js";
import { checkAuthentication, checkVerification } from "../browser/auth.js";
import { shutdownBrowser, initBrowser } from "../browser/browser.js";
import { saveAuthToken } from "../browser/session.js";
import {
  pagePool,
  createPage,
  evaluateWithTimeout,
} from "../browser/pagePool.js";
import { getAvailableToken, markRateLimited } from "./tokenManager.js";
import { logInfo, logError, logWarn, logDebug } from "../logger/index.js";
import crypto from "crypto";
import {
  CHAT_API_URL,
  CREATE_CHAT_URL,
  CHAT_PAGE_URL,
  PAGE_TIMEOUT,
  RETRY_DELAY,
  DEFAULT_MODEL,
  MAX_RETRY_COUNT,
} from "../config.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ─── sendMessage — helper functions ──────────────────────────────────────────

function validateAndPrepareMessage(message) {
  if (message === null || message === undefined) {
    return { error: "Сообщение не может быть пустым" };
  }
  if (typeof message === "string") return { content: message };
  if (Array.isArray(message)) {
    const isValid = message.every(
      (item) =>
        (item.type === "text" && typeof item.text === "string") ||
        (item.type === "image" && typeof item.image === "string") ||
        (item.type === "file" && typeof item.file === "string"),
    );
    if (!isValid)
      return { error: "Некорректная структура составного сообщения" };
    return { content: message };
  }
  return { error: "Неподдерживаемый формат сообщения" };
}

async function resolveAuthToken(browserContext) {
  const tokenObj = await getAvailableToken();
  if (tokenObj && tokenObj.token) {
    setAuthToken(tokenObj.token);
    logInfo(`Используется аккаунт: ${tokenObj.id}`);
    return tokenObj;
  }

  if (getBrowserTokenRateLimited()) {
    logWarn("Browser-токен залимичен, пропускаем fallback");
    return null;
  }

  if (!getAuthenticationStatus()) {
    logInfo("Проверка авторизации...");
    const authCheck = await checkAuthentication(browserContext);
    if (!authCheck) return null;
  }

  if (!getAuthToken()) {
    logInfo("Получение токена авторизации...");
    setAuthToken(await extractAuthToken(browserContext));
  }

  const token = getAuthToken();
  return token ? { id: "browser", token } : null;
}

function buildPayloadV2(
  messageContent,
  model,
  chatId,
  parentId,
  files,
  systemMessage,
  tools,
  toolChoice,
) {
  const userMessageId = crypto.randomUUID();
  const assistantChildId = crypto.randomUUID();

  const newMessage = {
    fid: userMessageId,
    parentId,
    parent_id: parentId,
    role: "user",
    content: messageContent,
    chat_type: "t2t",
    sub_chat_type: "t2t",
    timestamp: Math.floor(Date.now() / 1000),
    user_action: "chat",
    models: [model],
    files: files || [],
    childrenIds: [assistantChildId],
    extra: { meta: { subChatType: "t2t" } },
    feature_config: {
      thinking_enabled: false,
      output_schema: "phase",
      // Disable Qwen Chat built-in tools so external clients (Zed) remain the only tool executor.
      auto_search: false,
      web_search: false,
      search_enabled: false,
      online_search: false,
      internet_search: false,
      research_mode: "none",
      code_interpreter: false,
      browser_enabled: false,
      plugins_enabled: false,
    },
  };

  const payload = {
    stream: true,
    incremental_output: true,
    chat_id: chatId,
    chat_mode: "normal",
    messages: [newMessage],
    model,
    parent_id: parentId,
    timestamp: Math.floor(Date.now() / 1000),
    // Disable Qwen built-in tools at payload level too
    auto_search: false,
    web_search: false,
    search_enabled: false,
    online_search: false,
    internet_search: false,
    search: false,
    research_mode: "none",
    code_interpreter: false,
    browser_enabled: false,
    plugins_enabled: false,
    tools_enabled: false,
    builtin_tools_enabled: false,
  };

  if (systemMessage) {
    payload.system_message = systemMessage;
    logDebug(
      `System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? "..." : ""}`,
    );
  }
  // Tool prompt injected in routes.js into both user message content AND system_message.
  // The payload.content now carries the full Zed tool protocol instructions.

  return payload;
}

function parseNonSseCompletionBody(body) {
  try {
    const parsed = JSON.parse(body);
    const topLevelCode = parsed?.code;
    const nestedCode = parsed?.data?.code;
    const hasStructuredError =
      parsed?.success === false ||
      Boolean(parsed?.error) ||
      Boolean(parsed?.data?.error) ||
      Boolean(topLevelCode) ||
      Boolean(nestedCode);

    if (hasStructuredError) {
      const isRateLimited =
        topLevelCode === "RateLimited" || nestedCode === "RateLimited";
      return {
        success: false,
        status: isRateLimited ? 429 : 500,
        errorBody: body,
      };
    }

    if (
      parsed.choices ||
      parsed.id ||
      (parsed.success === true && parsed.data)
    ) {
      return { success: true, isTask: false, data: parsed };
    }
  } catch {
    // Ignore parse errors here and return a generic failure below.
  }

  return {
    success: false,
    error: "Unexpected non-SSE 200 response",
    errorBody: body,
  };
}

async function executeApiRequestWithNodeStreaming(
  apiUrl,
  payload,
  token,
  onChunk,
) {
  try {
    if (!token) return { success: false, error: "Токен авторизации не найден" };
    if (typeof fetch !== "function")
      return { success: false, error: "Fetch API is unavailable" };

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        Accept: "*/*",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        success: false,
        status: response.status,
        statusText: response.statusText,
        errorBody,
      };
    }

    if (payload.stream === false) {
      const jsonResponse = await response.json();
      if (jsonResponse.code === "RateLimited" || jsonResponse.error) {
        return {
          success: false,
          status: 429,
          errorBody: JSON.stringify(jsonResponse),
        };
      }
      return { success: true, isTask: true, data: jsonResponse };
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      const body = await response.text();
      return parseNonSseCompletionBody(body);
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
      const body = await response.text();
      return parseNonSseCompletionBody(body);
    }

    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let responseId = null;
    let usage = null;
    let finished = false;
    let streamError = null;
    let hasStreamedChunks = false;

    while (!finished) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || !line.startsWith("data:")) continue;

        const jsonStr = line.substring(5).trim();
        if (!jsonStr) continue;
        if (jsonStr === "[DONE]") {
          finished = true;
          break;
        }

        try {
          const chunk = JSON.parse(jsonStr);

          if (chunk.code === "RateLimited" || (chunk.code && chunk.detail)) {
            streamError = { status: 429, errorBody: JSON.stringify(chunk) };
            finished = true;
            break;
          }
          if (chunk.error && !chunk.choices) {
            streamError = { status: 500, errorBody: JSON.stringify(chunk) };
            finished = true;
            break;
          }

          if (chunk["response.created"])
            responseId = chunk["response.created"].response_id;
          if (chunk.response_id) responseId = chunk.response_id;

          if (chunk.choices && chunk.choices[0]) {
            const delta = chunk.choices[0].delta;
            if (delta && delta.content) {
              fullContent += delta.content;
              if (typeof onChunk === "function") {
                onChunk(delta.content);
                hasStreamedChunks = true;
              }
            }
            if (delta && delta.status === "finished") finished = true;
            if (chunk.choices[0].finish_reason) finished = true;
          }

          if (chunk.usage) usage = chunk.usage;
        } catch {
          // Ignore broken chunks, keep reading stream.
        }
      }
    }

    if (streamError) {
      return { success: false, ...streamError, hasStreamedChunks };
    }

    return {
      success: true,
      isTask: false,
      hasStreamedChunks,
      data: {
        id: responseId || "chatcmpl-" + Date.now(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: payload.model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: fullContent },
            finish_reason: "stop",
          },
        ],
        usage: usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
        },
        response_id: responseId,
      },
    };
  } catch (error) {
    return { success: false, error: error.toString() };
  }
}

async function executeApiRequest(page, apiUrl, payload, token, onChunk = null) {
  if (payload?.stream !== false && typeof onChunk === "function") {
    const streamedResponse = await executeApiRequestWithNodeStreaming(
      apiUrl,
      payload,
      token,
      onChunk,
    );

    const canReturnDirectly =
      streamedResponse.success ||
      Boolean(streamedResponse.status) ||
      Boolean(streamedResponse.errorBody) ||
      streamedResponse.hasStreamedChunks === true;

    if (canReturnDirectly) {
      return streamedResponse;
    }

    logWarn(
      `Node-streaming недоступен (${streamedResponse.error || "unknown error"}), fallback к browser fetch.`,
    );
  }

  const requestBody = { apiUrl, payload, token };

  logDebug(
    `Используем токен: ${token ? "Токен существует" : "Токен отсутствует"}`,
  );
  logDebug(`API URL: ${apiUrl}`);

  return page.evaluate(async (data) => {
    try {
      const t = data.token;
      if (!t) return { success: false, error: "Токен авторизации не найден" };

      const response = await fetch(data.apiUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${t}`,
          Accept: "*/*",
        },
        body: JSON.stringify(data.payload),
      });

      if (response.ok) {
        if (data.payload.stream === false) {
          const jsonResponse = await response.json();
          if (jsonResponse.code === "RateLimited" || jsonResponse.error) {
            return {
              success: false,
              status: 429,
              errorBody: JSON.stringify(jsonResponse),
            };
          }
          return { success: true, isTask: true, data: jsonResponse };
        }

        const contentType = response.headers.get("content-type") || "";

        if (!contentType.includes("text/event-stream")) {
          const body = await response.text();
          try {
            const parsed = JSON.parse(body);
            const topLevelCode = parsed?.code;
            const nestedCode = parsed?.data?.code;
            const hasStructuredError =
              parsed?.success === false ||
              Boolean(parsed?.error) ||
              Boolean(parsed?.data?.error) ||
              Boolean(topLevelCode) ||
              Boolean(nestedCode);

            // API иногда возвращает JSON с success=false и code при HTTP 200.
            if (hasStructuredError) {
              const isRateLimited =
                topLevelCode === "RateLimited" || nestedCode === "RateLimited";
              return {
                success: false,
                status: isRateLimited ? 429 : 500,
                errorBody: body,
              };
            }
            // Валидный JSON-ответ completion (иногда Qwen возвращает так)
            if (
              parsed.choices ||
              parsed.id ||
              (parsed.success === true && parsed.data)
            ) {
              return { success: true, isTask: false, data: parsed };
            }
          } catch {
            /* not JSON, treat as unexpected */
          }
          return {
            success: false,
            error: "Unexpected non-SSE 200 response",
            errorBody: body,
          };
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let fullContent = "";
        let responseId = null;
        let usage = null;
        let finished = false;
        let streamError = null;

        while (!finished) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim() || !line.startsWith("data: ")) continue;
            const jsonStr = line.substring(6).trim();
            if (!jsonStr) continue;
            try {
              const chunk = JSON.parse(jsonStr);

              if (
                chunk.code === "RateLimited" ||
                (chunk.code && chunk.detail)
              ) {
                streamError = { status: 429, errorBody: JSON.stringify(chunk) };
                finished = true;
                break;
              }
              if (chunk.error && !chunk.choices) {
                streamError = { status: 500, errorBody: JSON.stringify(chunk) };
                finished = true;
                break;
              }

              if (chunk["response.created"])
                responseId = chunk["response.created"].response_id;
              if (chunk.choices && chunk.choices[0]) {
                const delta = chunk.choices[0].delta;
                if (delta && delta.content) fullContent += delta.content;
                if (delta && delta.status === "finished") finished = true;
              }
              if (chunk.usage) usage = chunk.usage;
            } catch {
              /* ignore parse errors for individual chunks */
            }
          }
        }

        if (streamError) {
          return { success: false, ...streamError };
        }

        return {
          success: true,
          isTask: false,
          data: {
            id: responseId || "chatcmpl-" + Date.now(),
            object: "chat.completion",
            created: Math.floor(Date.now() / 1000),
            model: data.payload.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: fullContent },
                finish_reason: "stop",
              },
            ],
            usage: usage || {
              prompt_tokens: 0,
              completion_tokens: 0,
              total_tokens: 0,
            },
            response_id: responseId,
          },
        };
      }

      const errorBody = await response.text();
      return {
        success: false,
        status: response.status,
        statusText: response.statusText,
        errorBody,
      };
    } catch (error) {
      return { success: false, error: error.toString() };
    }
  }, requestBody);
}

async function handleApiError(
  response,
  tokenObj,
  message,
  model,
  chatId,
  parentId,
  files,
  retryCount,
  onChunk = null,
) {
  const errMsg =
    response.error ||
    response.statusText ||
    (response.status ? `HTTP ${response.status}` : "Неизвестная ошибка");
  if (!response.error && !response.statusText) {
    logWarn(
      `handleApiError получил неполный объект: ключи=${Object.keys(response).join(",")}`,
    );
  }
  logError(`Ошибка при получении ответа: ${errMsg}`);
  if (response.errorBody)
    logWarn(`Ошибка API ответ: ${response.errorBody.substring(0, 500)}`);

  if (response.html && response.html.includes("Verification")) {
    setAuthenticationStatus(false);
    logInfo(
      "Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...",
    );
    await pagePool.clear();
    setAuthToken(null);
    await shutdownBrowser();
    await initBrowser(true);
    return {
      error: "Требуется верификация. Браузер запущен в видимом режиме.",
      verification: true,
      chatId,
    };
  }

  if (
    response.status === 401 ||
    (response.errorBody &&
      (response.errorBody.includes("Unauthorized") ||
        response.errorBody.includes("Token has expired")))
  ) {
    logWarn(
      `Токен ${tokenObj?.id} недействителен (401). Удаляем и пробуем другой.`,
    );
    setAuthToken(null);
    setBrowserTokenRateLimited(false);
    if (tokenObj?.id && tokenObj.id !== "browser") {
      const { markInvalid } = await import("./tokenManager.js");
      markInvalid(tokenObj.id);
    }
    const { hasValidTokens } = await import("./tokenManager.js");
    if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
      return sendMessage(
        message,
        model,
        chatId,
        parentId,
        files,
        null, // tools
        null, // toolChoice
        null, // systemMessage (cleared on retry — Qwen stores it)
        retryCount + 1,
        onChunk,
      );
    }
    logError("Не осталось валидных токенов или исчерпаны попытки.");
    return {
      error:
        "Все токены недействительны (401). Требуется повторная авторизация.",
      chatId,
    };
  }

  if (
    response.status === 429 ||
    (response.errorBody && response.errorBody.includes("RateLimited"))
  ) {
    let hours = 24;
    try {
      const rateInfo = JSON.parse(response.errorBody);
      hours = Number(rateInfo.num) || 24;
    } catch {
      /* errorBody might not be valid JSON */
    }

    if (tokenObj?.id === "browser") {
      setBrowserTokenRateLimited(true);
      logWarn(`Browser-токен достиг лимита. Помечаем на ${hours}ч.`);
    } else if (tokenObj?.id) {
      markRateLimited(tokenObj.id, hours);
      logWarn(
        `Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`,
      );
    }

    setAuthToken(null);
    const { hasValidTokens } = await import("./tokenManager.js");
    if (hasValidTokens() && retryCount < MAX_RETRY_COUNT) {
      return sendMessage(
        message,
        model,
        chatId,
        parentId,
        files,
        null, // tools
        null, // toolChoice
        null, // systemMessage
        retryCount + 1,
        onChunk,
      );
    }
    return { error: `Все токены заблокированы по лимиту (${hours}ч)`, chatId };
  }

  const finalError =
    response.error ||
    response.statusText ||
    (response.status ? `HTTP ${response.status}` : "Неизвестная ошибка");
  return {
    error: finalError,
    details: response.errorBody || "Нет дополнительных деталей",
    chatId,
  };
}

// ─── Main public API ─────────────────────────────────────────────────────────

export async function sendMessage(
  message,
  model = DEFAULT_MODEL,
  chatId = null,
  parentId = null,
  files = null,
  tools = null,
  toolChoice = null,
  systemMessage = null,
  retryCount = 0,
  onChunk = null,
) {
  if (!chatId) {
    const newChatResult = await createChatV2(model, "Новый чат", 0);
    if (newChatResult.error)
      return { error: "Не удалось создать чат: " + newChatResult.error };
    chatId = newChatResult.chatId;
    logInfo(`Создан новый чат v2 с ID: ${chatId}`);
  }

  const validated = validateAndPrepareMessage(message);
  if (validated.error) {
    logError(validated.error);
    return { error: validated.error, chatId };
  }
  const messageContent = validated.content;

  if (!model || model.trim() === "") {
    model = DEFAULT_MODEL;
  } else if (!isValidModel(model)) {
    logWarn(
      `Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`,
    );
    model = DEFAULT_MODEL;
  }
  logInfo(`Используемая модель: "${model}"`);

  const browserContext = getBrowserContext();
  if (!browserContext) return { error: "Браузер не инициализирован", chatId };

  const tokenObj = await resolveAuthToken(browserContext);
  if (!tokenObj)
    return { error: "Ошибка авторизации: не удалось получить токен", chatId };

  let page = null;
  try {
    page = await pagePool.getPage(browserContext);

    const verificationNeeded = await checkVerification(page);
    if (verificationNeeded) {
      await page.reload({
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT,
      });
    }

    if (!getAuthToken()) {
      logWarn("Токен отсутствует перед отправкой запроса");
      setAuthToken(await page.evaluate(() => localStorage.getItem("token")));
      if (!getAuthToken())
        return {
          error:
            "Токен авторизации не найден. Требуется перезапуск в ручном режиме.",
          chatId,
        };
      saveAuthToken(getAuthToken());
    }

    logInfo("Отправка запроса к API v2...");

    const payload = buildPayloadV2(
      messageContent,
      model,
      chatId,
      parentId,
      files,
      systemMessage,
      tools,
      toolChoice,
    );
    logDebug(
      `Отправка запроса к API v2 (model: ${payload.model}, chat_id: ${payload.chat_id})`,
    );
    // logDebug("=== PAYLOAD V2 ===\n" + JSON.stringify(payload, null, 2)); // Disabled to reduce spam
    logInfo(
      `Отправка сообщения в чат ${chatId} с parent_id: ${parentId || "null"}`,
    );

    const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;
    const response = await executeApiRequest(
      page,
      apiUrl,
      payload,
      getAuthToken(),
      onChunk,
    );

    pagePool.releasePage(page);
    page = null;

    if (response.success) {
      logInfo("Ответ получен успешно");
      response.data.chatId = chatId;
      response.data.parentId = response.data.response_id;
      response.data.id = response.data.id || "chatcmpl-" + Date.now();

      // Fallback: если поток чанков не был отдан, отправляем контент единым куском.
      if (
        typeof onChunk === "function" &&
        response.data.choices?.[0]?.message?.content
      ) {
        onChunk(response.data.choices[0].message.content);
      }
      return response.data;
    } else {
      const apiResult = await handleApiError(
        response,
        tokenObj,
        message,
        model,
        chatId,
        parentId,
        files,
        retryCount,
        onChunk,
      );

      if (response.errorBody && /not exist/i.test(response.errorBody)) {
        logWarn(
          `Qwen чат ${chatId} больше не существует. Создаю новый и повторяю запрос...`,
        );
        const newChatResult = await createChatV2(model, "Сессия", 0);
        if (newChatResult && newChatResult.chatId) {
          // Retry with new chat. Mark result so routes knows to update default cache.
          const retryResult = await sendMessage(
            message,
            model,
            newChatResult.chatId,
            parentId,
            files,
            tools,
            toolChoice,
            systemMessage,
            1, // prevent infinite retry loop
            onChunk,
          );
          // Signal to routes: this request used a newly-created chat
          if (!retryResult.error) {
            retryResult.newChatId = newChatResult.chatId;
          }
          return retryResult;
        }
      }

      // Handle Qwen API error: "The chat is in progress!" -> create new chat and retry once
      if (
        response.errorBody &&
        /chat is in progress/i.test(response.errorBody)
      ) {
        logWarn(
          `Qwen чат ${chatId} заблокирован ("in progress"). Создаю новый и повторяю запрос...`,
        );
        const newChatResult = await createChatV2(model, "Сессия", 0);
        if (newChatResult && newChatResult.chatId) {
          const retryResult = await sendMessage(
            message,
            model,
            newChatResult.chatId,
            parentId,
            files,
            tools,
            toolChoice,
            systemMessage,
            1,
            onChunk,
          );
          if (!retryResult.error) retryResult.newChatId = newChatResult.chatId;
          return retryResult;
        }
      }

      return apiResult;
    }
  } catch (error) {
    logError("Ошибка при отправке сообщения", error);
    return { error: error.toString(), chatId };
  } finally {
    if (page) {
      pagePool.releasePage(page);
    }
  }
}

// ─── createChatV2 ────────────────────────────────────────────────────────────

export async function createChatV2(
  model = DEFAULT_MODEL,
  title = "Новый чат",
  retryCount = 0,
) {
  const browserContext = getBrowserContext();
  if (!browserContext) return { error: "Браузер не инициализирован" };

  const tokenObj = await getAvailableToken();
  if (tokenObj?.token) {
    setAuthToken(tokenObj.token);
    logInfo(`Используется аккаунт для создания чата: ${tokenObj.id}`);
  }

  if (!getAuthToken()) {
    logInfo("Получение токена авторизации для создания чата...");
    setAuthToken(await extractAuthToken(browserContext));
    if (!getAuthToken())
      return { error: "Не удалось получить токен авторизации" };
  }

  let page = null;
  try {
    page = await pagePool.getPage(browserContext);

    const payload = {
      title,
      models: [model],
      chat_mode: "normal",
      chat_type: "t2t",
      timestamp: Date.now(),
    };
    const requestBody = {
      apiUrl: CREATE_CHAT_URL,
      payload,
      token: getAuthToken(),
    };

    const result = await page.evaluate(async (data) => {
      try {
        const response = await fetch(data.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.token}`,
          },
          body: JSON.stringify(data.payload),
        });
        if (response.ok) return { success: true, data: await response.json() };
        return {
          success: false,
          status: response.status,
          errorBody: await response.text(),
        };
      } catch (error) {
        return { success: false, error: error.toString() };
      }
    }, requestBody);

    pagePool.releasePage(page);
    page = null;

    if (result.success && result.data.success) {
      logInfo(`Чат создан: ${result.data.data.id}`);
      return {
        success: true,
        chatId: result.data.data.id,
        requestId: result.data.request_id,
      };
    }

    const isTransient = result.status >= 500 && result.status < 600;
    if (isTransient && retryCount < MAX_RETRY_COUNT) {
      logWarn(
        `Создание чата: ${result.status}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`,
      );
      await delay(RETRY_DELAY);
      return createChatV2(model, title, retryCount + 1);
    }

    const cleanError = isTransient
      ? `Qwen API недоступен (${result.status}). Повторите позже.`
      : result.errorBody || result.error || "Неизвестная ошибка";
    logError(
      `Ошибка при создании чата: ${result.status || "unknown"} (попытка ${retryCount + 1})`,
    );
    return { error: cleanError };
  } catch (error) {
    logError("Ошибка при создании чата", error);
    return { error: error.toString() };
  } finally {
    if (page) {
      pagePool.releasePage(page);
    }
  }
}

// ─── testToken ───────────────────────────────────────────────────────────────

export async function testToken(token) {
  const browserContext = getBrowserContext();
  if (!browserContext) return "ERROR";

  let page;
  let shouldClosePage = false;
  try {
    page = await createPage(browserContext);
    shouldClosePage = page !== browserContext;
    await page.goto(CHAT_PAGE_URL, { waitUntil: "domcontentloaded" });

    const requestBody = {
      apiUrl: CHAT_API_URL,
      token,
      payload: {
        chat_type: "t2t",
        messages: [{ role: "user", content: "ping", chat_type: "t2t" }],
        model: DEFAULT_MODEL,
        stream: false,
      },
    };

    const result = await page.evaluate(async (data) => {
      try {
        const res = await fetch(data.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.token}`,
          },
          body: JSON.stringify(data.payload),
        });
        return { ok: res.ok, status: res.status };
      } catch (e) {
        return { ok: false, status: 0, error: e.toString() };
      }
    }, requestBody);

    if (result.ok || result.status === 400) return "OK";
    if (result.status === 401 || result.status === 403) return "UNAUTHORIZED";
    if (result.status === 429) return "RATELIMIT";
    return "ERROR";
  } catch (e) {
    logError("testToken error", e);
    return "ERROR";
  } finally {
    if (page) {
      try {
        if (shouldClosePage) await page.close();
      } catch {}
    }
  }
}
