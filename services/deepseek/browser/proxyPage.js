/**
 * Browser proxy page — direct Node.js fetch with saved DeepSeek credentials.
 * No Puppeteer for API calls. Browser used only for one-time auth via auth.js.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { logInfo, logWarn } from "../../../shared/logger/index.js";
import { DEEPSEEK_MODELS } from "../config.js";
import { solvePoW } from "../utils/powSolver.js";

// Hardcoded WASM URL fallback (reference: FreeDeepseekAPI/scripts/deepseek_chrome_auth.js line 372-374)
const DEFAULT_WASM_URL = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.resolve(__dirname, "..", "..", "session");
const LEGACY_ACCOUNTS_PATH = path.resolve(__dirname, "..", "session");

let ACTIVE_FILE = null;
function resolveActiveFile() {
  if (ACTIVE_FILE) return ACTIVE_FILE;
  const newFile = path.join(ACCOUNTS_PATH, "deepseek_accounts.json");
  const oldFile = path.join(LEGACY_ACCOUNTS_PATH, "deepseek_accounts.json");
  if (fs.existsSync(newFile)) {
    ACTIVE_FILE = { file: newFile, dir: ACCOUNTS_PATH };
  } else if (fs.existsSync(oldFile)) {
    ACTIVE_FILE = { file: oldFile, dir: LEGACY_ACCOUNTS_PATH };
  } else {
    ACTIVE_FILE = { file: newFile, dir: ACCOUNTS_PATH };
  }
  return ACTIVE_FILE;
}

// Cached credentials loaded once at init
let cachedAuthData = {};
let initialised = false;

function loadSavedSession() {
  try {
    const { file } = resolveActiveFile();
    if (!fs.existsSync(file)) return null;
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    if (Array.isArray(data) && data.length > 0) {
      const dsAccounts = data.filter((a) => a.id?.startsWith("deepseek_") && !a.invalid);
      if (dsAccounts.length === 0) return null;
      const acc = dsAccounts[dsAccounts.length - 1];
      return {
        cookies: acc.cookies || [],
        authData: acc.authData || {},
        storage: acc.storage || { ls: {}, ss: {} },
      };
    }
  } catch (err) {
    logWarn(`[DS-API] Error reading session: ${err.message}`);
  }
  return null;
}

/** Build cookie string from saved cookies (name=value; name=value...) */
function buildCookieString(cookies) {
  if (!cookies || !Array.isArray(cookies) || cookies.length === 0) return "";
  return cookies
    .filter((c) => c.name && c.value)
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
}

/** Build base headers for DeepSeek API requests */
function buildApiHeaders(authData, cookieStr, powResponseHeader) {
  const bearerToken = authData.bearerToken || "";
  const headers = {
    Accept: "*/*",
    "Content-Type": "application/json;charset=UTF-8",
    Origin: "https://chat.deepseek.com",
    Referer: "https://chat.deepseek.com/",
    "Accept-Language": "en-US,en;q=0.9",
    "x-client-platform": "web",
    "x-client-version": authData.x_client_version || "2.0.0",
    "x-client-locale": "ru",
    "x-client-timezone-offset": "14400",
    "x-app-version": "2.0.0",
  };
  if (bearerToken) headers["Authorization"] = `Bearer ${bearerToken}`;
  if (cookieStr) headers["Cookie"] = cookieStr;
  if (authData.hif_dliq) headers["x-hif-dliq"] = authData.hif_dliq;
  if (authData.hif_leim) headers["x-hif-leim"] = authData.hif_leim;
  if (powResponseHeader) headers["X-DS-PoW-Response"] = powResponseHeader;
  return headers;
}

// ─── API functions ─────────────────────────────────────────────────

/**
 * Create a DeepSeek chat session via Node.js fetch.
 * Returns { sessionId, error }.
 */
async function createChatSession(headers) {
  const resp = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
    method: "POST",
    headers,
    body: "{}",
  });
  const text = await resp.text();
  if (!resp.ok) {
    return { error: `chat_session/create: HTTP ${resp.status}: ${text.slice(0, 200)}` };
  }
  try {
    const json = JSON.parse(text);
    // Detect INVALID_TOKEN
    if (json?.code === 40003 || (json?.msg && String(json.msg).toLowerCase().includes("token"))) {
      return { error: "INVALID_TOKEN", raw: text.slice(0, 500) };
    }
    const sessionId = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id || null;
    return { sessionId };
  } catch {
    return { error: `Non-JSON response: ${text.slice(0, 200)}` };
  }
}

/**
 * Fetch PoW challenge from DeepSeek.
 * Returns { challenge, targetPath } or throws.
 */
async function fetchChallenge(headers) {
  const url = "https://chat.deepseek.com/api/v0/chat/create_pow_challenge";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({ target_path: "/api/v0/chat/completion" }),
    });
    clearTimeout(timeoutId);

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error(`Challenge request failed: HTTP ${resp.status}: ${text.slice(0, 200)}`);
    }
    const json = JSON.parse(text);
    const challenge =
      json?.data?.biz_data?.challenge || json?.data?.challenge || json?.challenge || null;
    if (!challenge) {
      throw new Error(`Challenge response has no challenge data: ${text.slice(0, 200)}`);
    }
    return { challenge, targetPath: "/api/v0/chat/completion" };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Solve PoW using WASM module.
 * Tries cachedAuthData.wasmUrl first, falls back to hardcoded DEFAULT_WASM_URL.
 * If WASM unavailable, falls back to pure JS solver (PoW_SHA3 only).
 */
async function solvePoWV1(challenge, targetPath) {
  const algorithm = challenge.algorithm || "";
  const wasmUrl = cachedAuthData.wasmUrl || DEFAULT_WASM_URL;

  // Try WASM first for DeepSeekHashV1 or unknown algorithms
  if (algorithm !== "PoW_SHA3") {
    try {
      logInfo("[DS-API] Solving PoW via WASM...");
      const wasmResp = await fetch(wasmUrl);
      if (!wasmResp.ok) throw new Error(`WASM download failed: HTTP ${wasmResp.status}`);

      const wasmBytes = await wasmResp.arrayBuffer();
      const mod = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
      const e = mod.instance.exports;

      const encoder = new TextEncoder();
      const prefix = challenge.salt + "_" + (challenge.expire_at || "") + "_";
      const cBytes = encoder.encode(challenge.challenge);
      const pBytes = encoder.encode(prefix);

      const cP = e.__wbindgen_export_0(cBytes.length, 1) >>> 0;
      const pP = e.__wbindgen_export_0(pBytes.length, 1) >>> 0;
      new Uint8Array(e.memory.buffer, cP, cBytes.length).set(cBytes);
      new Uint8Array(e.memory.buffer, pP, pBytes.length).set(pBytes);

      const sp = e.__wbindgen_add_to_stack_pointer(-16);
      if (typeof e.wasm_solve !== "function") throw new Error("wasm_solve not found");
      e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty || 144000);

      const dv = new DataView(e.memory.buffer);
      const code = dv.getInt32(sp, true);
      const ans = dv.getFloat64(sp + 8, true);
      e.__wbindgen_add_to_stack_pointer(16);

      if (code === 0 || !Number.isFinite(ans) || ans <= 0) {
        throw new Error(`WASM solve failed (code=${code}, ans=${ans})`);
      }

      const nonce = Math.floor(ans);
      const powData = JSON.stringify({
        algorithm,
        challenge: challenge.challenge,
        salt: challenge.salt,
        answer: nonce,
        signature: challenge.signature || "",
        target_path: targetPath,
      });
      const b64 = Buffer.from(powData, "utf8").toString("base64");
      logInfo(`[DS-API] ✅ PoW solved via WASM (nonce=${nonce})`);
      return b64;
    } catch (wasmErr) {
      logWarn(`[DS-API] WASM failed: ${wasmErr.message}`);
      if (algorithm !== "PoW_SHA3") throw wasmErr; // No fallback for non-SHA3 algorithms
    }
  }

  // Fallback: pure JS for PoW_SHA3
  const result = solvePoW(challenge);
  logInfo(`[DS-API] ✅ PoW solved (pure JS, nonce=${result.nonce})`);
  return result.powData;
}

// ─── SSE parsing (moved from sendViaBrowser evaluate context) ─────

function parseSSEStream(response) {
  return new Promise((resolve, reject) => {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullContent = "";
    let thinkingContent = "";
    let newMessageId = null;
    let lastPath = null;
    const fragments = [];
    let firstChunkSample = null;

    function rebuildText() {
      fullContent = fragments
        .filter((f) => f && f.type === "RESPONSE" && typeof f.content === "string")
        .map((f) => f.content)
        .join("");
      thinkingContent = fragments
        .filter(
          (f) =>
            f && (f.type === "THINK" || f.type === "REASONING") && typeof f.content === "string"
        )
        .map((f) => f.content)
        .join("");
    }

    function appendFragments(value) {
      const incoming = Array.isArray(value) ? value : [value];
      for (const fragment of incoming) {
        if (fragment && typeof fragment === "object") fragments.push({ ...fragment });
      }
      rebuildText();
    }

    function pump() {
      reader
        .read()
        .then(({ done, value }) => {
          if (done) {
            resolve({
              success: true,
              data: { content: fullContent },
              messageId: newMessageId,
              _debug: {
                contentType: "sse",
                firstChunk: firstChunkSample,
                contentLength: fullContent.length,
                thinkingLength: thinkingContent.length,
                fragments: fragments.length,
              },
            });
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data:")) continue;
            const dataStr = line.slice(5).trim();
            if (!dataStr || dataStr === "[DONE]") continue;

            try {
              const d = JSON.parse(dataStr);

              // Track message ID (from metadata event)
              if (d.response_message_id !== undefined && !newMessageId) {
                newMessageId = d.response_message_id;
              }

              // Debug: first chunk structure
              if (!firstChunkSample) {
                firstChunkSample = {
                  keys: Object.keys(d),
                  sample: JSON.stringify(d).slice(0, 300),
                };
              }

              // Track path for grouped events
              if (d.p !== undefined) lastPath = d.p;

              // Legacy format: response/metadata with content + fragments
              if (d.v && typeof d.v === "object" && d.v.response) {
                if (d.v.response.content !== undefined) {
                  fullContent = d.v.response.content;
                }
                if (Array.isArray(d.v.response.fragments)) {
                  fragments.length = 0;
                  appendFragments(d.v.response.fragments);
                }
                continue;
              }

              // Fragment-based format (current DeepSeek API)
              if (lastPath === "response/fragments" && d.v !== undefined) {
                appendFragments(d.v);
                continue;
              }
              if (lastPath === "response/fragments/-1/content" && d.v !== undefined) {
                if (typeof d.v !== "object" && fragments.length > 0) {
                  const last = fragments[fragments.length - 1];
                  last.content = (last.content || "") + String(d.v);
                  rebuildText();
                }
                continue;
              }

              // Legacy format: response/content
              if (lastPath === "response/content" && d.v !== undefined && typeof d.v !== "object") {
                fullContent += String(d.v);
                continue;
              }

              // Check for errors
              if (d.type === "error" && d.content) {
                throw new Error(`DeepSeek error: ${d.content}`);
              }

              // Finish reason
              if (lastPath === "response/finish_reason" && d.v !== undefined) {
                // No-op: just a marker
                continue;
              }
            } catch (err) {
              if (
                !err.message.includes("Unexpected end") &&
                !err.message.includes("JSON") &&
                !err.message.includes("token")
              ) {
                reader.cancel();
                reject(err);
                return;
              }
            }
          }
          // Yield to avoid stack overflow
          setImmediate(pump);
        })
        .catch((err) => {
          resolve({
            success: fullContent.length > 0,
            data: { content: fullContent },
            _debug: {
              contentType: "sse_partial",
              error: err.message,
              contentLength: fullContent.length,
            },
          });
        });
    }
    pump();
  });
}

async function parseNonSSEResponse(response) {
  const text = await response.text();
  let fullContent = text;
  try {
    const json = JSON.parse(text);
    if (json?.data?.delta) {
      fullContent = json.data.delta;
    } else if (json?.message) {
      fullContent = json.message;
    } else if (Array.isArray(json)) {
      fullContent = json
        .map((item) => {
          try {
            const parsed =
              typeof item === "string" ? JSON.parse(item.replace(/^data: /, "")) : item;
            return parsed?.v || parsed?.delta || parsed?.content || "";
          } catch {
            return "";
          }
        })
        .join("");
    }
  } catch {}

  let debugKeys = null;
  try {
    debugKeys = Object.keys(JSON.parse(text)).slice(0, 10);
  } catch {}

  return {
    success: true,
    data: { content: fullContent },
    _debug: {
      contentType: "json",
      keys: debugKeys,
      rawLength: text.length,
      sample: text.slice(0, 300),
    },
  };
}

// ─── Session management ──────────────────────────────────────────

const chatSessions = new Map();

async function ensureSession(conversationHint) {
  const hint = conversationHint || "_default";
  if (chatSessions.has(hint)) return chatSessions.get(hint);

  const cookieStr = buildCookieString(loadSavedSession()?.cookies || []);
  const headers = buildApiHeaders(cachedAuthData, cookieStr);

  const result = await createChatSession(headers);

  if (result.error && result.error.includes("INVALID_TOKEN")) {
    logWarn("[DS-API] 🔴 Session expired! Re-auth required (menu → option 1)");
    chatSessions.clear();
  } else if (result.error) {
    logWarn(`[DS-API] createSession failed: ${result.error}`);
  }

  if (result.sessionId) {
    logInfo(`[DS-API] Session created: ${result.sessionId.slice(0, 12)}...`);
    const session = { sessionId: result.sessionId, parentMessageId: null };
    chatSessions.set(hint, session);
    return session;
  }

  // Fallback: random UUID
  const fallback = { sessionId: crypto.randomUUID(), parentMessageId: null };
  chatSessions.set(hint, fallback);
  return fallback;
}

// ─── Exported API ────────────────────────────────────────────────

/**
 * Initialize API client: load saved credentials.
 * No browser needed — we use direct Node.js fetch.
 */
export async function initBrowserPage() {
  if (initialised) return true;

  const savedSession = loadSavedSession();
  if (savedSession && savedSession.cookies.length > 0) {
    cachedAuthData = savedSession.authData;
    logInfo("[DS-API] Credentials loaded (browser-free mode)");
  } else {
    logWarn("[DS-API] No session data found — run auth first (menu → option 1)");
    cachedAuthData = {};
  }

  initialised = true;
  return true;
}

/**
 * Send message via direct DeepSeek API with PoW solving.
 * No browser involved — uses Node.js fetch + WASM solver.
 */
export async function sendViaBrowser(messages, model, conversationHint) {
  if (!initialised) {
    return { success: false, error: "API not initialized" };
  }

  try {
    // Build prompt from messages
    const lastMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";
    const cfg = DEEPSEEK_MODELS[model] ?? DEEPSEEK_MODELS["deepseek-v3"];

    let promptText = "";
    const nonSystem = messages.filter((m) => m.role !== "system");
    for (const msg of nonSystem) {
      const label = msg.role === "user" ? "\nHuman: " : "\nAssistant: ";
      if (Array.isArray(msg.content)) {
        promptText += label + msg.content.map((p) => p.text || JSON.stringify(p)).join("");
      } else {
        promptText += label + (msg.content || "");
      }
    }

    logInfo(`[DS-API] Request: model_type=${cfg.model_type}, thinking=${cfg.thinking_enabled}`);

    // Ensure session
    const session = await ensureSession(conversationHint);
    logInfo(`[DS-API] Session: ${session.sessionId}`);

    // Build base headers (without PoW header initially)
    const cookieStr = buildCookieString(loadSavedSession()?.cookies || []);
    const baseHeaders = buildApiHeaders(cachedAuthData, cookieStr);

    // Step 1: Get PoW challenge
    logInfo("[DS-API] Fetching PoW challenge...");
    const { challenge, targetPath } = await fetchChallenge(baseHeaders);

    // Step 2: Solve PoW
    logInfo("[DS-API] Solving PoW...");
    const powResponseHeader = await solvePoWV1(challenge, targetPath);

    // Step 3: Send completion request
    const chatSessionId = session?.sessionId || crypto.randomUUID();
    const parentMessageId = session?.parentMessageId || null;

    const body = {
      model_type: cfg.model_type || "default",
      prompt: promptText || lastMsg,
      thinking_enabled: cfg.thinking_enabled ?? false,
      search_enabled: false,
      ref_file_ids: [],
      action: null,
      preempt: false,
      chat_session_id: chatSessionId,
      parent_message_id: parentMessageId,
    };

    // Headers WITH PoW response
    const completionHeaders = buildApiHeaders(cachedAuthData, cookieStr, powResponseHeader);

    logInfo("[DS-API] Sending completion request...");
    const response = await fetch("https://chat.deepseek.com/api/v0/chat/completion", {
      method: "POST",
      headers: completionHeaders,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errText = await response.text();
      // Detect session expiry and invalidate cache
      if (response.status === 400 && errText.includes("INVALID_TOKEN")) {
        chatSessions.delete(conversationHint || "_default");
      }
      return { success: false, error: `HTTP ${response.status}: ${errText.slice(0, 200)}` };
    }

    // Parse response (SSE or JSON)
    const contentType = response.headers.get("content-type") || "";
    let result;
    if (contentType.includes("text/event-stream")) {
      result = await parseSSEStream(response);
      // Save newMessageId for follow-up requests
      if (result.messageId && session) {
        session.parentMessageId = result.messageId;
        logInfo(`[DS-API] Message ID: ${result.messageId}`);
      }
    } else {
      result = await parseNonSSEResponse(response);
    }
    return result;
  } catch (err) {
    logWarn(`[DS-API] Error: ${err.message}`);
    return { success: false, error: err.message };
  }
}

export async function checkPageAuth() {
  // No browser page to check — just verify credentials exist
  return !!(cachedAuthData.bearerToken || cachedAuthData.token);
}

export async function shutdownBrowser() {
  chatSessions.clear();
  initialised = false;
  cachedAuthData = {};
}
