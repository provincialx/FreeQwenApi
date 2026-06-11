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
  evaluateInBrowser,
} from "../browser/pagePool.js";
import { getAvailableToken, getTokenById, markRateLimited } from "./tokenManager.js";
import { invalidateQwenChatId, setChatTokenOwner, getChatTokenOwner } from "./chatSession.js";
import { logInfo, logError, logWarn, logDebug } from "../logger/index.js";
import crypto from "crypto";
import {
  CHAT_API_URL,
  CREATE_CHAT_URL,
  CHAT_PAGE_URL,
  PAGE_TIMEOUT,
  REQUEST_TIMEOUT_MINUTES,
  RETRY_DELAY,
  DEFAULT_MODEL,
  MAX_RETRY_COUNT,
  USER_AGENT,
} from "../config.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// CAPTCHA simulation: fires once per process to test resolver without waiting for Qwen.
let _captchaSimulated = false;

// ─── CLI prompt helper (same pattern as auth.js) ──────────────────────────────
async function promptUser(message) {
  return new Promise((resolve) => {
    process.stdout.write(message);
    const onData = (data) => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(data.toString().trim());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

// ─── WAF/CAPTCHA detection ────────────────────────────────────────────
// Aliyun WAF uses multiple signals. Check all known markers.
function isCaptchaChallenge(errorBody) {
  const body = errorBody || "";

  // Old structured CAPTCHA token
  if (body.includes("FAIL_SYS_USER_VALIDATE")) return true;

  // New Aliyun WAF HTML challenge page — non-JSON response from Node fetch.
  // Markers: <meta name="aliyun_waf_aa">, _waf_ JS vars, console override script
  if (body.includes('name="aliyun_waf') || body.includes("name='aliyun_waf")) return true;
  if (body.includes("_waf_is_mob") || body.includes("_wa1_is_mob")) return true;
  if (body.includes("void 0===window.console")) return true;

  // Response is HTML with WAF-like inline styles designed to block bots
  if (body.toLowerCase().includes("background:#fff") && body.includes("aliyun")) return true;

  return false;
}

/** Show headed browser for user to solve CAPTCHA, refresh token, then retry. */
async function resolveCaptchaAndRetry(
  _browserContext,
  messageContent,
  model,
  chatId,
  parentId,
  files,
  tools,
  toolChoice,
  systemMessage,
  retryCount,
  onChunk
) {
  console.log("\n------------------------------------------------------");
  console.log(`              ⚠️  ЗАПРОШЕНА КАПЧА (CAPTCHA)`);
  console.log("------------------------------------------------------");
  console.log(
    "Qwen запросил CAPTCHA из-за подозрительной активности.\nОткройте браузер, решите капчу, затем нажмите ENTER в консоли."
  );
  console.log("------------------------------------------------------");

  try {
    logInfo("Перезапуск браузера в видимом режиме для CAPTCHA...");

    // Qwen relies on localStorage JWT for session, not HTTP cookies. Save it now before shutdown wipes state.
    const savedToken = getAuthToken();
    if (!savedToken) {
      console.log("ОШИБКА: Токен отсутствует, невозможно восстановить сессию для CAPTCHA");
      return sendMessage(
        messageContent,
        model,
        chatId,
        parentId,
        files,
        tools,
        toolChoice,
        systemMessage,
        retryCount + 1,
        onChunk
      );
    }

    // Shutdown headless and start visible browser WITHOUT manual auth prompt.
    await shutdownBrowser();
    await delay(2000);
    await initBrowser(true, true); // visible + skipManualAuth
    const visibleContext = getBrowserContext();

    if (!visibleContext) {
      console.log("Не удалось запустить браузер для CAPTCHA.");
      return sendMessage(
        messageContent,
        model,
        chatId,
        parentId,
        files,
        tools,
        toolChoice,
        systemMessage,
        retryCount + 1,
        onChunk
      );
    }

    // Open CAPTCHA page and inject saved auth token.
    const captchaPage = await pagePool.getPage(visibleContext);
    try {
      await captchaPage.goto(CHAT_PAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT,
      });

      // Qwen checks localStorage["token"] for login state. Write our saved JWT there.
      const injected = await evaluateInBrowser(
        captchaPage,
        (t) => {
          localStorage.setItem("token", t);
          return localStorage.getItem("token") === t;
        },
        [savedToken]
      );

      if (injected) logInfo(`Токен успешно восстановлен в браузере`);
      else logWarn("Не удалось записать токен в браузер");
    } catch (e) {
      logWarn(`Ошибка при открытии страницы CAPTCHA: ${e.message}`);
    }

    // Brief pause for Qwen to process the token and update UI.
    await delay(1000);

    console.log("\nПосле прохождения CAPTCHA нажмите ENTER...");
    await new Promise((resolve) => {
      process.stdout.write("> ");
      const onData = (data) => {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(true);
      };
      process.stdin.resume();
      process.stdin.once("data", onData);
    });

    console.log("CAPTCHA подтверждена, обновляю сессию...");
    await delay(3000); // Give Qwen time to register the solved captcha.

    // Re-extract auth token — it might be rotated after CAPTCHA resolution.
    const newToken =
      (await captchaPage.evaluate(() => localStorage.getItem("token"))) || getAuthToken();
    if (newToken) {
      setAuthToken(newToken);
      saveAuthToken(newToken);
      logInfo(`Токен обновлён после CAPTCHA`);
    }

    pagePool.releasePage(captchaPage);

    // Return to headless mode.
    logInfo("Возвращаю браузер в фоновый режим...");
    await shutdownBrowser();
    await delay(2000);
    await initBrowser(false);
  } catch {
    console.log("CAPTCHA сессия завершена.");
  }

  return sendMessage(
    messageContent,
    model,
    chatId,
    parentId,
    files,
    tools,
    toolChoice,
    systemMessage,
    retryCount + 1,
    onChunk
  );
}

// ─── sendMessage — helper functions ──────────────────────────────────────

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
        (item.type === "file" && typeof item.file === "string")
    );
    if (!isValid) return { error: "Некорректная структура составного сообщения" };
    return { content: message };
  }
  return { error: "Неподдерживаемый формат сообщения" };
}

async function resolveAuthToken(browserContext, preferredOwnerId = null) {
  // Try the chat's owner token first — Qwen chats belong to a specific account.
  // Without this, createChatV2() creates on account A but sendMessage uses B → "not exist".
  if (preferredOwnerId) {
    const ownedToken = getTokenById(preferredOwnerId);
    if (ownedToken && ownedToken.token) {
      setAuthToken(ownedToken.token);
      logInfo(`♻️ Используем привязанный аккаунт: ${ownedToken.id}`);
      return ownedToken;
    } else {
      logWarn(`Привязанный аккаунт ${preferredOwnerId} недоступен — используем любой доступный`);
    }
  }

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
  toolChoice
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
      `System message: ${systemMessage.substring(0, 100)}${systemMessage.length > 100 ? "..." : ""}`
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

    // CAPTCHA can appear in structured error JSON too, check before other errors.
    if (body.includes("FAIL_SYS_USER_VALIDATE")) {
      return { success: false, isCaptcha: true, errorBody: body };
    }

    if (hasStructuredError) {
      const isRateLimited = topLevelCode === "RateLimited" || nestedCode === "RateLimited";
      return {
        success: false,
        status: isRateLimited ? 429 : 500,
        errorBody: body,
      };
    }

    if (parsed.choices || parsed.id || (parsed.success === true && parsed.data)) {
      return { success: true, isTask: false, data: parsed };
    }
  } catch {
    // Ignore parse errors here and return a generic failure below.
  }

  // WAF/CAPTCHA detection at raw text level — final fallback.
  if (isCaptchaChallenge(body)) {
    return { success: false, isCaptcha: true, errorBody: body };
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
  onChunk = null,
  cookieStr = ""
) {
  try {
    if (!token) return { success: false, error: "Токен авторизации не найден" };
    if (typeof fetch !== "function") return { success: false, error: "Fetch API is unavailable" };

    const headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      Accept: "*/*",
      Origin: "https://chat.qwen.ai",
      Referer: "https://chat.qwen.ai/",
      "Sec-Fetch-Dest": "empty",
      "Sec-Fetch-Mode": "cors",
      "Sec-Fetch-Site": "same-origin",
      "User-Agent": USER_AGENT,
      ...(cookieStr ? { Cookie: cookieStr } : {}),
    };

    const requestBody = JSON.stringify(payload);
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: requestBody,
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

    // Non-streaming payload path (rare — used by createChatV2)
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

    // SSE fast-fail: abort empty stream after ~15s instead of hanging for REQUEST_TIMEOUT_MINUTES
    const slowTimer = setTimeout(() => {
      if (!hasStreamedChunks && !finished) {
        logWarn("SSE fast-fail: no chunks received after 15s, aborting");
        finished = true;
      }
    }, 15_000);

    try {
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

            if (chunk["response.created"]) responseId = chunk["response.created"].response_id;
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
    } finally {
      clearTimeout(slowTimer);
      // Cancel reader gracefully — Qwen stream may already be done.
      try {
        await reader.cancel().catch(() => {});
      } catch {}
    }

    if (streamError) {
      return { success: false, ...streamError, hasStreamedChunks };
    }

    // Empty stream guard — slowTimer fired with no content received.
    if (!hasStreamedChunks && !fullContent) {
      return { success: false, error: "Empty SSE response", hasStreamedChunks };
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

// Aliyun WAF blocks pure Node.js fetch. Must run INSIDE browser context.
// protocolTimeout is set to 15+ min in browser.js so long SSE streams don't break the CDP link.
async function executeApiRequest(page, apiUrl, payload, token, onChunk = null) {
  logDebug(`Используем токен: ${token ? "Токен существует" : "Токен отсутствует"}`);
  logDebug(`API URL: ${apiUrl}`);

  const apiTimeoutMs = Math.max(REQUEST_TIMEOUT_MINUTES * 60_000 + 30_000, 180_000);
  const requestBody = { apiUrl, payload, token };

  return evaluateInBrowser(
    page,
    async (data) => {
      try {
        if (!data.token) return { success: false, error: "Токен авторизации не найден" };

        // AbortController: kill fetch() itself if it hangs >120s. Prevents indefinite CDP lock.
        const controller = new AbortController();
        const timeoutId = setTimeout(() => {
          controller.abort();
        }, 120_000);

        // Debug info returned in case we hang at fetch()
        const startMs = Date.now();
        const browserHostname = typeof location !== "undefined" ? location.hostname : "unknown";

        // Use relative URL to keep same-origin — Qwen requires cookies from session.
        // If data.apiUrl is absolute (https://chat.qwen.ai/...), extract just path+query.
        let fetchUrl = data.apiUrl;
        if (fetchUrl.startsWith("http")) {
          try {
            const urlObj = new URL(fetchUrl);
            fetchUrl = urlObj.pathname + urlObj.search;
          } catch {}
        }

        const response = await fetch(fetchUrl, {
          method: "POST",
          credentials: "include", // Send browser cookies — Qwen needs session, not just Bearer token
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.token}`,
            Accept: "*/*",
          },
          body: JSON.stringify(data.payload),
          signal: controller.signal,
        }).finally(() => clearTimeout(timeoutId));

        // Log response metadata for Node-side debugging
        const respMeta = {
          status: response.status,
          contentType: response.headers.get("content-type") || "",
          elapsedMs: Date.now() - startMs,
          browserHost: browserHostname,
          urlCalled: data.apiUrl.substring(0, 120),
        };

        if (response.ok) {
          const contentType = response.headers.get("content-type") || "";
          if (!contentType.includes("text/event-stream")) {
            const bodyText = await response.text();
            return {
              ...parseNonSseCompletionBody(bodyText),
              debugMeta: respMeta,
              responseBodyPreview: (bodyText || "").substring(0, 300),
            };
          }

          // SSE stream inside browser. Must collect fully because CDP is locked during this.
          const reader = response.body?.getReader();
          if (reader) {
            let buffer = "",
              fullContent = "",
              responseId,
              usage,
              finished = false;

            // AbortController: kill SSE read if Qwen hangs >3min. CDP is locked during evaluate,
            // so without this the page stays blocked for REQUEST_TIMEOUT_MINUTES (5m+).
            const abortTimeoutMs = 180_000; // 3 min
            let sseTimer = null;
            try {
              sseTimer = setTimeout(() => {
                if (!finished) {
                  finished = true;
                  // Running inside page.evaluate — console.log goes to browser devtools.
                  // Node.js side will see this as partial content return, not full [DONE].
                  reader.cancel().catch(() => {});
                }
              }, abortTimeoutMs);

              while (!finished) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer += new TextDecoder().decode(value, { stream: true });
                for (const line of buffer.split("\n")) {
                  buffer = line.substring(line.lastIndexOf("\n") + 1);
                  const jsonStr = line.replace(/^data:\s?/, "").trim();
                  if (!jsonStr || jsonStr === "[DONE]") {
                    if (jsonStr === "[DONE]") finished = true;
                    continue;
                  }
                  try {
                    const chunk = JSON.parse(jsonStr);
                    if (chunk["response.created"])
                      responseId = chunk["response.created"].response_id;
                    const delta = chunk.choices?.[0]?.delta;
                    if (delta?.content) fullContent += delta.content;
                    if (delta?.status === "finished") finished = true;
                    if (chunk.usage) usage = chunk.usage;
                  } catch {}
                }
              }
            } finally {
              if (sseTimer) clearTimeout(sseTimer);
            }

            return {
              success: true,
              isTask: false,
              data: {
                id: responseId || `chatcmpl-${Date.now()}`,
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
              },
            };
          }
        }

        const errorBody = await response.text();
        return { success: false, status: response.status, errorBody };
      } catch (error) {
        if (error?.name === "AbortError") return { success: false, error: `API request timed out` };
        return { success: false, error: error.toString() };
      }
    },
    [requestBody],
    apiTimeoutMs
  );
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
  onChunk = null
) {
  // Build error message — caller is responsible for logging.
  // Don't log here: "in progress", "not exist" etc. are transient and
  // retried automatically, so logging them as [error] creates noise.
  const errMsg =
    response.error ||
    response.statusText ||
    (response.status ? `HTTP ${response.status}` : "Неизвестная ошибка");
  if (!response.error && !response.statusText && !response.status && !response.errorBody) {
    logWarn(`handleApiError получил неполный объект: ключи=${Object.keys(response).join(",")}`);
  }

  if (response.html && response.html.includes("Verification")) {
    setAuthenticationStatus(false);
    logInfo("Обнаружена необходимость верификации, перезапуск браузера в видимом режиме...");
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
    logWarn(`Токен ${tokenObj?.id} недействителен (401). Удаляем и пробуем другой.`);
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
        onChunk
      );
    }
    logError("Не осталось валидных токенов или исчерпаны попытки.");
    return {
      error: "Все токены недействительны (401). Требуется повторная авторизация.",
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
        `Токен ${tokenObj.id} достиг лимита. Помечаем на ${hours}ч и пробуем другой токен...`
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
        onChunk
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
  preferredOwnerId = null
) {
  if (!chatId) {
    const newChatResult = await createChatV2(model, "Новый чат", 0);
    if (newChatResult.error) return { error: "Не удалось создать чат: " + newChatResult.error };
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
    logWarn(`Модель "${model}" не найдена в списке доступных. Используется модель по умолчанию.`);
    model = DEFAULT_MODEL;
  }
  // Model logged once in getAvailableModelsFromFile() — no duplicate

  const browserContext = getBrowserContext();
  if (!browserContext) return { error: "Браузер не инициализирован", chatId };

  // Use the token that created this chat — Qwen chats belong to a specific account.
  // Without ownership, rotation picks random account → "not exist" on other accounts' chats.
  // Map proxy-hash to real qwen ID first if needed (ownership is stored by real ID).
  const { getChatIdFromMap } = await import("./chatSession.js");
  const realQwenChatId = getChatIdFromMap(chatId) || chatId;
  const preferredOwner = getChatTokenOwner(realQwenChatId);

  logDebug(
    `Ищем токен для чата: proxyId=${chatId}, realId=${realQwenChatId}, owner=${preferredOwner}`
  );
  const tokenObj = await resolveAuthToken(browserContext, preferredOwner);
  if (!tokenObj) return { error: "Ошибка авторизации: не удалось получить токен", chatId };

  // CAPTCHA simulation: inject fake error response to test resolver e2e.
  // Fires once per process. _captchaSimulated flag prevents loops on retries.
  const simulateCaptcha = process.env.SIMULATE_CAPTCHA === "true" && !_captchaSimulated;
  if (simulateCaptcha) {
    _captchaSimulated = true;
    logInfo("[СИМУЛЯЦИЯ] CAPTCHA — пропускаю реальный запрос, запускаю resolver");
    return resolveCaptchaAndRetry(
      browserContext,
      messageContent,
      model,
      chatId,
      parentId,
      files,
      tools,
      toolChoice,
      systemMessage,
      retryCount,
      onChunk
    );
  }

  // Build payload once — shared by both paths
  const payload = buildPayloadV2(
    messageContent,
    model,
    chatId,
    parentId,
    files,
    systemMessage,
    tools,
    toolChoice
  );
  logDebug(`Отправка запроса к API v2 (model: ${payload.model}, chat_id: ${payload.chat_id})`);
  // Full debug: enable for tool-calling troubleshooting only!
  // logDebug("=== PAYLOAD V2 ===\n" + JSON.stringify(payload, null, 2));

  const apiUrl = `${CHAT_API_URL}?chat_id=${chatId}`;

  // ── Two-path strategy (S59) ───────────────────────────────────────────────
  // Path 1: Node.js streaming — primary path. Fast, doesn't block CDP.
  // Falls back to Path 2 only when Aliyun WAF blocks the request.

  let response = null;
  let page = null;

  logInfo(`🟢 Node-streaming (path 1): чат ${chatId}, parent: ${parentId || "null"}`);
  const cookieStr = getAuthToken();
  logInfo(`🔍 [S59_CODE_V2] Two-path strategy active`);
  let path1Failed = false;
  try {
    response = await executeApiRequestWithNodeStreaming(apiUrl, payload, cookieStr, onChunk);
    logDebug(`[Path1] Result: success=${response.success}, isCaptcha=${response.isCaptcha}`);
  } catch (err) {
    logWarn(`Node-streaming failed: ${err.message}`);
    path1Failed = true;
  }

  // ── Force browser fallback when Node fetch can't reach Qwen API ───────
  // WAF blocks ALL subsequent Node-fetch from this IP/token. Retrying Node path is futile.
  // Also covers "Токен авторизации" errors — browser can extract token from localStorage.
  const forceBrowserFallback =
    path1Failed ||
    (response && !response.success && response.isCaptcha) ||
    (response && !response.success && isCaptchaChallenge(response.errorBody));

  try {
    // ── Path 2: Browser fallback — forced when WAF blocks Node fetch ─────────
    if (forceBrowserFallback) {
      const reason = path1Failed
        ? "Path1 exception"
        : response?.isCaptcha
          ? "WAF challenge"
          : "HTML response";
      logWarn(`🟡 Browser fallback forced: ${reason} → executeApiRequest`);
      try {
        logInfo("⏳ Getting page from pool for browser fallback...");
        page = await pagePool.getPage(browserContext);
        logInfo("✅ Page acquired, executing API request in browser context...");

        // Navigate to chat.qwen.ai if needed — origin mismatch breaks fetch.
        const currentHost = await page.evaluate(() => location.hostname);
        logDebug(`[Path2] Current host: ${currentHost}`);
        if (currentHost !== "chat.qwen.ai") {
          logDebug(`Navigating from ${currentHost} → ${CHAT_PAGE_URL}`);
          await page.goto(CHAT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });

          // Re-extract token after navigation (may differ if on different subdomain)
          const extracted = await page.evaluate(() => localStorage.getItem("token"));
          if (extracted && extracted !== cookieStr) {
            logInfo("Токен обновлён после навигации для browser fallback");
            setAuthToken(extracted);
          }
        } else {
          // Page already on correct host — verify auth token freshness
          const verificationNeeded = await checkVerification(page);
          if (verificationNeeded) {
            await page.reload({ waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
          }
        }

        // Verify the page has session cookies — Qwen API requires them for browser-origin requests.
        // A fresh pagePool-page without cookies will hang on fetch() even in browser context.
        const cookieCount = (await page.cookies("https://chat.qwen.ai")).length;
        logDebug(`[Path2] Page has ${cookieCount} cookies for chat.qwen.ai`);
        if (cookieCount === 0) {
          logWarn("⚠️ Path2 page has no cookies! Restoring from browser context...");
          // Restore cookies from the main auth page
          const basePage = getBrowserContext();
          if (basePage) {
            try {
              const baseCookies = await basePage.cookies("https://chat.qwen.ai");
              logDebug(`[Path2] Base page has ${baseCookies.length} cookies, restoring...`);
              await page.setCookie(...baseCookies);
            } catch (e) {
              logWarn(`[Path2] Could not restore cookies: ${e.message}`);
            }
          }
        }

        const path2Start = Date.now();
        response = await executeApiRequest(page, apiUrl, payload, getAuthToken(), onChunk);
        const path2Elapsed = ((Date.now() - path2Start) / 1000).toFixed(1);

        logInfo(
          `[Path2] Result: success=${response.success}, error=${
            response.error || "none"
          }, isCaptcha=${response.isCaptcha}`
        );

        // Log debug metadata if available (browser-host, elapsedMs, content-type)
        if (response.debugMeta) {
          const m = response.debugMeta;
          logInfo(
            `[Path2] Meta: host=${m.browserHost}, fetch=${(m.elapsedMs / 1000).toFixed(1)}s, total=${path2Elapsed}s, ct=${m.contentType}`
          );
        }

        // Log body preview if non-SSE HTML was returned (WAF/blocking)
        if (response.responseBodyPreview) {
          logWarn(`[Path2] Body preview: ${response.responseBodyPreview.substring(0, 300)}`);
        }

        // Even browser fetch can be blocked by WAF if the token/IP was flagged.
        // If we get WAF HTML back from inside browser, try resolveCaptchaAndRetry.
        if (!response.success && response.errorBody) {
          const bodyStr = String(response.errorBody);
          if (isCaptchaChallenge(bodyStr)) {
            logWarn(
              "Browser fallback also hit WAF → resolveCaptchaAndRetry needed. Body preview:",
              bodyStr.substring(0, 200)
            );
          }
        }

        pagePool.releasePage(page);
        page = null;
      } catch (err) {
        logError("Browser fallback also failed", err);
        if (page) pagePool.releasePage(page);
        return { error: `WAF fallback browser request failed: ${err.message}`, chatId };
      }
    } else if (
      !forceBrowserFallback &&
      response &&
      !response.success &&
      response.error &&
      response.error.includes("Токен авторизации")
    ) {
      // Token missing — browser fallback is already covered by forceBrowserFallback.
      // This branch handles the rare case of direct token error without WAF.
      logWarn("Токен отсутствует или невалиден → получение из браузера");
    }

    // ── Shared response handling (both paths converge here) ───────────────────
    if (response.success) {
      logInfo("Ответ получен успешно");
      response.data.chatId = chatId;
      response.data.parentId = response.data.response_id;
      response.data.id = response.data.id || "chatcmpl-" + Date.now();

      // Fallback: если поток чанков не был отдан, отправляем контент единым куском.
      if (typeof onChunk === "function" && response.data.choices?.[0]?.message?.content) {
        onChunk(response.data.choices[0].message.content);
      }
      return response.data;
    } else {
      // Debug: log response keys to understand what path is used
      logInfo(`[ERR] keys=${Object.keys(response).join(",")} status=${response.status}`);

      // ── CAPTCHA detection (FAIL_SYS_USER_VALIDATE) ─────────────────────
      if (
        response.isCaptcha ||
        (response.errorBody && String(response.errorBody).includes("FAIL_SYS_USER_VALIDATE"))
      ) {
        return resolveCaptchaAndRetry(
          browserContext,
          messageContent,
          model,
          chatId,
          parentId,
          files,
          tools,
          toolChoice,
          systemMessage,
          retryCount,
          onChunk
        );
      }

      // ── Normal error handling path ─────────────────────────────────────
      const apiResult = await handleApiError(
        response,
        tokenObj,
        message,
        model,
        chatId,
        parentId,
        files,
        retryCount,
        onChunk
      );

      const errText = (response.errorBody || "").toLowerCase();

      // Distinguish between parent_id not exist and chat not exist.
      if (errText.includes("not exist") && errText.includes("parent_id")) {
        logWarn(`Stale parentId ${parentId} — retry without it on chat ${chatId}`);
        if (retryCount < 1) {
          const retryResult = await sendMessage(
            message,
            model,
            chatId, // keep existing chat
            null, // parentId: reset stale parent reference
            files,
            tools,
            toolChoice,
            systemMessage,
            retryCount + 1,
            onChunk
          );
          return retryResult;
        }
      }

      // Only allow ONE new-chat creation on "not exist" — prevent infinite loop.
      if (errText.includes("not exist") && retryCount === 0) {
        logWarn(`Qwen чат ${chatId} больше не существует. Создаю новый и повторяю запрос...`);

        // Invalidate stale mappings BEFORE creating new chat so next request doesn't reuse dead ID.
        invalidateQwenChatId(chatId);

        const newChatResult = await createChatV2(model, "Сессия", 0, tokenObj);
        if (newChatResult && newChatResult.chatId) {
          // Retry with new chat. Reset parentId — old parent message doesn't exist in the new chat.
          const retryResult = await sendMessage(
            message,
            model,
            newChatResult.chatId,
            null, // parentId: reset for new chat
            files,
            tools,
            toolChoice,
            systemMessage,
            1, // prevent infinite retry loop
            onChunk
          );
          // Signal to routes: this request used a newly-created chat
          if (!retryResult.error) {
            retryResult.newChatId = newChatResult.chatId;
          }
          return retryResult;
        }
      }

      // Handle Qwen API error: "The chat is in progress!" -> wait and retry SAME chat.
      // Creating a new chat during agent-loop destroys context — Qwen loses
      // assistant.tool_calls history and generates explanatory text instead of continuation.
      // Only escalate to new-chat if same-chat retries exhaust (Qwen truly stuck).
      const isInProgress = errText.includes("chat is in progress");
      if (isInProgress) {
        if (retryCount < 3) {
          // Backoff: ~2s, ~4s — Qwen SSE session usually finishes in 1-5s after
          // we receive the last chunk. Shorter than normal retry to avoid blocking agent-loop.
          const waitMs = Math.min(1000 * (retryCount + 2), RETRY_DELAY);
          logWarn(
            `Qwen чат ${chatId} заблокирован ("in progress"). Ожидание ${waitMs}мс перед повтором на том же чате...`
          );
          await delay(waitMs);
          const retryResult = await sendMessage(
            message,
            model,
            chatId, // keep same chat — preserve assistant.tool_calls context
            parentId, // keep same parentId — continue conversation thread
            files,
            tools,
            toolChoice,
            systemMessage,
            retryCount + 1,
            onChunk
          );
          return retryResult;
        } else {
          logWarn(
            `Qwen чат ${chatId} заблокирован ("in progress") после ${retryCount} попыток. Создаю новый чат...`
          );
          const newChatResult = await createChatV2(model, "Сессия", 0, tokenObj);
          if (newChatResult && newChatResult.chatId) {
            const retryResult = await sendMessage(
              message,
              model,
              newChatResult.chatId,
              null, // parentId: reset for new chat
              files,
              tools,
              toolChoice,
              systemMessage,
              10, // hard-stop — prevent infinite loop even if new chat also "in progress"
              onChunk
            );
            if (!retryResult.error) retryResult.newChatId = newChatResult.chatId;
            return retryResult;
          }
        }
      }

      // All transient retries exhausted — log final error.
      logError(`Ошибка API для чата ${chatId}: ${apiResult.error || "неизвестно"}`);
      if (response.errorBody) logWarn(`Ошибка API ответ: ${response.errorBody.substring(0, 500)}`);
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
  tokenObj = null
) {
  const browserContext = getBrowserContext();
  if (!browserContext) return { error: "Браузер не инициализирован" };

  // Reuse provided token (from sendMessage context) to avoid creating
  // chat under one account then sending message from another.
  let resolvedTokenObj = tokenObj;
  if (!resolvedTokenObj) {
    resolvedTokenObj = await getAvailableToken();
    if (resolvedTokenObj?.token) {
      setAuthToken(resolvedTokenObj.token);
      logInfo(`Используется аккаунт для создания чата: ${resolvedTokenObj.id}`);
    }
  } else if (resolvedTokenObj?.token) {
    setAuthToken(resolvedTokenObj.token);
    logInfo(`Переиспользуется аккаунт для создания чата: ${resolvedTokenObj.id}`);
  }

  if (!getAuthToken()) {
    logInfo("Получение токена авторизации для создания чата...");
    setAuthToken(await extractAuthToken(browserContext));
    if (!getAuthToken()) return { error: "Не удалось получить токен авторизации" };
  }

  const authHeader = getAuthToken();
  if (!authHeader) return { error: "Токен авторизации не найден" };

  // Use Node.js fetch directly — evaluateInBrowser timeouts are unreliable.
  let result;
  try {
    const response = await fetch(CREATE_CHAT_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${authHeader}`,
      },
      body: JSON.stringify({
        title,
        models: [model],
        chat_mode: "normal",
        chat_type: "t2t",
        timestamp: Date.now(),
      }),
    });

    if (response.ok) {
      const json = await response.json();
      result = { success: true, data: json };
    } else {
      const errorBody = await response.text();
      result = { success: false, status: response.status, errorBody };
    }
  } catch (error) {
    return { error: `Сетевая ошибка при создании чата: ${error.message}` };
  }

  if (!result.success || !result.data?.success) {
    const isTransient = result.status >= 500 && result.status < 600;
    if (isTransient && retryCount < MAX_RETRY_COUNT) {
      logWarn(
        `Создание чата: ${result.status}, ретрай ${retryCount + 1}/${MAX_RETRY_COUNT} через ${RETRY_DELAY}мс...`
      );
      await delay(RETRY_DELAY);
      return createChatV2(model, title, retryCount + 1, resolvedTokenObj);
    }

    const cleanError = isTransient
      ? `Qwen API недоступен (${result.status}). Повторите позже.`
      : result.errorBody || "Неизвестная ошибка";
    logError(`Ошибка при создании чата: ${result.status || "unknown"} (попытка ${retryCount + 1})`);
    return { error: cleanError };
  }

  const createdChatId = result.data.data.id;
  logInfo(`Чат создан: ${createdChatId}`);

  // Bind this chat to the account that created it — prevents cross-account "not exist" errors
  if (resolvedTokenObj?.id) {
    setChatTokenOwner(createdChatId, resolvedTokenObj.id);
  }

  return {
    success: true,
    chatId: createdChatId,
    requestId: result.data.request_id,
  };
}

// ─── testToken ───────────────────────────────────────────────────────────────

// Test token using Node.js fetch — no browser needed.
export async function testToken(token) {
  if (!token) return "ERROR";

  try {
    const response = await fetch(CHAT_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        chat_type: "t2t",
        messages: [{ role: "user", content: "ping", chat_type: "t2t" }],
        model: DEFAULT_MODEL,
        stream: false,
      }),
    });

    if (response.ok || response.status === 400) return "OK";
    if (response.status === 401 || response.status === 403) return "UNAUTHORIZED";
    if (response.status === 429) return "RATELIMIT";
    return "ERROR";
  } catch (e) {
    logError("testToken error", e);
    return "ERROR";
  }
}
