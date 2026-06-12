// services/deepseek/api/chat.js — HTTP chat proxy with SSE streaming & PoW solver
import { logInfo, logError, logWarn } from "../../../shared/logger/index.js";
import { CHAT_API_URL, DEEPSEEK_MODELS, REQUEST_TIMEOUT_MINUTES } from "../config.js";
import { getStoredCookies, getStoredAuthData } from "../browser/auth.js";

// Chat ID storage (simple JSON file)
const chatIds = new Map(); // conversation_id -> deepseek_chat_id

function generateId() {
  return "chat_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8);
}

export function getChatId(conversationId) {
  if (!conversationId) return null;
  return chatIds.get(conversationId);
}

export function setChatId(conversationId, deepseekId) {
  chatIds.set(conversationId, deepseekId);
}

// Resolve model config from DEEPSEEK_MODELS. Falls back to default.
function resolveModelConfig(modelId) {
  const id = (modelId || "deepseek-v3").toLowerCase();
  return DEEPSEEK_MODELS[id] ?? DEEPSEEK_MODELS["deepseek-v3"];
}

// Send message to DeepSeek and return streaming callback data
export async function sendMessage(
  messages,
  model = "default",
  onChunk = null,
  captureToolCalls = false
) {
  const cookies = getStoredCookies();

  if (!cookies.length) {
    logWarn("Нет сохранённых куки для DeepSeek. Запустите авторизацию.");
    return {
      success: false,
      error: "Сессия DeepSeek не найдена. Выполните вход через браузер.",
    };
  }

  const content = messages.length > 0 ? messages[messages.length - 1].content : "";

  // Build cookie string from array of objects
  const cookieStr = cookies.map((c) => `${c.name}=${c.value}`).join("; ");

  // Load auth data (token, headers, wasmUrl for PoW solving)
  const authData = getStoredAuthData();

  logInfo(
    `DeepSeek запрос (${model}): ${typeof content === "string" ? content.slice(0, 60) : "[array]"}`
  );

  return await executeApiRequest(content, model, cookieStr, authData, onChunk);
}

// ================= PoW Solver (DeepSeek Web API Protection) =================

/**
 * Fetches a challenge from DeepSeek and solves it using the local WASM module.
 * Returns the base64-encoded response required for the X-DS-PoW-Response header.
 */
async function solvePoW(wasmUrl, cookieStr) {
  if (!wasmUrl) throw new Error("No wasmUrl found in auth data.");

  // 1. Fetch the challenge from DeepSeek API
  const powResp = await fetch(`${CHAT_API_URL.replace("/completion", "")}/create_pow_challenge`, {
    method: "POST",
    headers: {
      Cookie: cookieStr,
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
  });

  if (!powResp.ok) {
    const errText = await powResp.text().catch(() => "");
    throw new Error(
      `Failed to get PoW challenge (HTTP ${powResp.status}): ${errText.slice(0, 150)}`
    );
  }

  let chalJson;
  try {
    chalJson = JSON.parse(await powResp.text());
  } catch (e) {
    throw new Error(`Non-JSON PoW response`);
  }

  const challenge = chalJson?.data?.biz_data?.challenge;
  if (!challenge) {
    throw new Error("PoW response has no data.biz_data.challenge.");
  }

  // 2. Load and instantiate WASM solver module from URL provided by auth flow
  try {
    const wasmResp = await fetch(wasmUrl);
    if (!wasmResp.ok) throw new Error(`Failed to download WASM module (HTTP ${wasmResp.status})`);

    const wasmBytes = await wasmResp.arrayBuffer();
    // Instantiate with empty imports for wbg (wasmparser bindings used by DeepSeek)
    const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
    const e = mod.instance.exports;

    // Prepare data in memory buffers using the WASM allocator helper
    const encoder = new TextEncoder();
    const prefix = challenge.salt + "_" + (challenge.expire_at || "") + "_";
    const cBytes = encoder.encode(challenge.challenge);
    const pBytes = encoder.encode(prefix);

    // Allocate space in WASM memory for our strings and write them
    const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
    const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
    new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
    new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);

    // Call wasm_solve with parameters: sp, challenge_ptr, challenge_len, prefix_ptr, prefix_len, difficulty
    const sp = e.__wbindgen_add_to_stack_pointer(-16);
    if (e.wasm_solve) {
      e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty || 4096);
    } else {
      throw new Error("wasm_solve function not found in WASM module");
    }

    // Read the result from stack pointer
    const dv = new DataView(e.memory.buffer);
    const code = dv.getInt32(sp, true);
    const ans = dv.getFloat64(sp + 8, true);
    e.__wbindgen_add_to_stack_pointer(16);

    if (code === 0 || !Number.isFinite(ans) || ans <= 0) {
      throw new Error(`PoW solve failed with code ${code}, answer: ${ans}`);
    }

    // 3. Encode result as base64 for header X-DS-PoW-Response
    const powAnswer = JSON.stringify({
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: Math.floor(ans),
      signature: challenge.signature || "",
      target_path: "/api/v0/chat/completion",
    });

    return Buffer.from(powAnswer).toString("base64");
  } catch (e) {
    logError(`[PoW] WASM solve failed: ${e.message}`);
    throw e;
  }
}

// ================= Main API Request Execution =================

async function executeApiRequest(content, model, cookieStr, authData = {}, onChunk) {
  const apiTimeoutMs = REQUEST_TIMEOUT_MINUTES * 60 * 1000;
  const cfg = resolveModelConfig(model);
  const startTime = Date.now();

  try {
    // === Solve Proof-of-Work (PoW) if we have the required data ===
    let powResponseHeader = undefined;

    if (authData.wasmUrl && authData.hif_dliq && authData.hif_leim) {
      logInfo("[PoW] Запрос челленджа для решения...");
      try {
        // Create PoW challenge URL dynamically based on current API base URL
        const powChallengeUrl = CHAT_API_URL.replace("/completion", "") + "/create_pow_challenge";

        const challengeResp = await fetch(powChallengeUrl, {
          method: "POST",
          headers: {
            Cookie: cookieStr,
            Origin: "https://chat.deepseek.com",
            Referer: "https://chat.deepseek.com/",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
        });

        if (challengeResp.ok) {
          const chalJson = JSON.parse(await challengeResp.text());
          const challenge = chalJson?.data?.biz_data?.challenge;

          if (challenge) {
            logInfo("[PoW] Решаю задачу...");

            // Download and execute WASM module to solve the challenge
            const wasmResp = await fetch(authData.wasmUrl);
            if (!wasmResp.ok) throw new Error(`WASM load failed (${wasmResp.status})`);

            const wasmBytes = await wasmResp.arrayBuffer();
            const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
            const e = mod.instance.exports;

            // Prepare data buffers for WASM execution
            const encoder = new TextEncoder();
            const prefix = challenge.salt + "_" + (challenge.expire_at || "") + "_";
            const cBytes = encoder.encode(challenge.challenge);
            const pBytes = encoder.encode(prefix);

            const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
            const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
            new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
            new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);

            const sp = e.__wbindgen_add_to_stack_pointer(-16);

            if (typeof e.wasm_solve === "function") {
              e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty || 4096);
            } else {
              throw new Error("wasm_solve function missing");
            }

            const dv = new DataView(e.memory.buffer);
            const code = dv.getInt32(sp, true);
            const ans = dv.getFloat64(sp + 8, true);
            e.__wbindgen_add_to_stack_pointer(16);

            if (code === 0 || !Number.isFinite(ans) || ans <= 0) {
              logWarn(`[PoW] Решение прошло с ошибкой или ответом ${ans}`);
            } else {
              // Format the solved PoW data into Base64 string for HTTP header
              const powData = JSON.stringify({
                algorithm: challenge.algorithm,
                challenge: challenge.challenge,
                salt: challenge.salt,
                answer: Math.floor(ans),
                signature: challenge.signature || "",
                target_path: "/api/v0/chat/completion",
              });

              powResponseHeader = Buffer.from(powData).toString("base64");
              logInfo("[PoW] Задача решена успешно!");
            }
          } else {
            logWarn("[PoW] В ответе челленджа нет данных о задаче.");
          }
        } else {
          const errText = await challengeResp.text();
          logError(`[PoW] Ошибка получения челленджа: ${errText.slice(0, 100)}`);
        }
      } catch (e) {
        // Log warning and try without PoW if something goes wrong with solving
        logWarn(`[PoW] Не удалось решить задачу (${e.message}), пробуем без PoW...`);
      }
    } else if (!authData.wasmUrl || !authData.hif_dliq || !authData.hif_leim) {
      logWarn(
        "[PoW] Данные для решения (wasm/hif) отсутствуют. Попробуйте выполнить авторизацию заново."
      );
    }

    // === Build request body according to DeepSeek Web API v0 spec ===
    const requestBody = JSON.stringify({
      model_type: cfg.model_type,
      prompt: content,
      thinking_enabled: cfg.thinking_enabled,
      search_enabled: cfg.search_enabled ?? false,
      ref_file_ids: [],
      action: null,
      preempt: false,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), apiTimeoutMs);

    // Build headers with auth data
    const headers = {
      Accept: "*/*",
      "Accept-Encoding": "gzip, deflate, br",
      "Content-Type": "application/json;charset=UTF-8",
      Origin: "https://chat.deepseek.com",
      Referer: "https://chat.deepseek.com/",
      Cookie: cookieStr,
      // Full browser imitation headers (required for DeepSeek Web validation)
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
      "x-client-platform": "web",
      "x-client-version": authData.x_client_version || "2.0.0",
    };

    // Add Authorization token if available (required for API access)
    if (authData.token) {
      headers["Authorization"] = `Bearer ${authData.token}`;
      logInfo(`DeepSeek: используем токен авторизации (${authData.token.slice(0, 8)}...)`);
    } else {
      logWarn("DeepSeek: токен авторизации не найден! Запрос может быть отклонен.");
    }

    // Add custom headers if available (hif_dliq, hif_leim)
    if (authData.hif_dliq) headers["x-hif-dliq"] = authData.hif_dliq;
    if (authData.hif_leim) headers["x-hif-leim"] = authData.hif_leim;

    // Add solved Proof-of-Work header if available
    if (powResponseHeader) {
      headers["X-DS-PoW-Response"] = powResponseHeader;
    }

    const response = await fetch(CHAT_API_URL, {
      method: "POST",
      headers,
      body: requestBody,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      const errorText = await response.text();
      logError(`DeepSeek API ошибка: ${response.status} - ${errorText.slice(0, 200)}`);
      return {
        success: false,
        status: response.status,
        errorBody: `HTTP ${response.status}: ${errorText.slice(0, 500)}`,
      };
    }

    // Check content type — DeepSeek uses text/event-stream for SSE
    const contentType = response.headers.get("content-type") || "";

    if (!contentType.includes("text/event-stream")) {
      logWarn("DeepSeek вернул JSON вместо SSE.");
      // Handle as single JSON chunk
      return handleNonSseResponse(response, onChunk);
    }

    // Parse SSE stream
    return await parseSSEStream(response.body, model, onChunk);
  } catch (err) {
    logError("Ошибка выполнения запроса к DeepSeek", err);
    if (err.name === "AbortError") {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      return { success: false, error: `Таймаут после ${elapsed}с` };
    }
    return { success: false, error: err.message };
  }

  function logDebug(msg) {
    if (process.env.LOG_LEVEL === "debug" || process.env.DEBUG) console.debug("[DS]", msg);
  }
}

async function parseSSEStream(stream, model, onChunk) {
  let fullContent = "";
  let thinkingContent = "";
  let inThinkingPhase = true; // DeepSeek outputs thinking first, then answer for R1 models
  let responseStarted = false;

  const decoder = new TextDecoder();
  let buffer = "";

  try {
    for await (const chunk of stream) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        if (!line.startsWith("data:")) continue;

        const dataStr = line.slice(5).trim();
        if (dataStr === "[DONE]" || !dataStr) continue;

        try {
          const json = JSON.parse(dataStr);

          // Track thinking elapsed => switch from thinking to answer phase
          if (json.p === "response/thinking_elapsed_secs") {
            inThinkingPhase = false;
            logInfo(`DeepSeek: дума${thinkingContent ? ` (${thinkingContent.length}симв)` : ""}`);
            continue;
          }

          // Extract content from SSE chunks
          const text = json.v || "";
          if (typeof text !== "string" || !text) continue;

          if (inThinkingPhase) {
            thinkingContent += text;
            if (onChunk && typeof onChunk === "function") {
              try {
                onChunk(text);
              } catch {}
            }
          } else {
            fullContent += text;
            if (onChunk && typeof onChunk === "function") {
              try {
                onChunk(text);
              } catch {}
            }
          }

          responseStarted = true;
        } catch (parseErr) {
          // Skip malformed SSE lines
        }
      }
    }
  } catch (streamErr) {
    if (streamErr.name !== "AbortError") {
      logWarn("Ошибка чтения потока DeepSeek:", streamErr.message);
    }
  }

  const totalLength = fullContent.length + thinkingContent.length;

  return {
    success: true,
    data: {
      content: fullContent,
      thinking: thinkingContent || null,
    },
    elapsedMs: Date.now() - startTime,
  };
}

async function handleNonSseResponse(response, onChunk) {
  const text = await response.text();

  if (onChunk && typeof onChunk === "function") {
    try {
      onChunk(text);
    } catch {}
  }

  return {
    success: true,
    data: { content: text },
  };
}

// Send message without streaming — returns full response
export async function sendMessageNonStreaming(messages, model = "default") {
  let result;

  const capturedChunks = [];

  return await sendMessage(
    messages,
    model,
    (chunk) => {
      capturedChunks.push(chunk);
    } // capture all chunks
  );
}
