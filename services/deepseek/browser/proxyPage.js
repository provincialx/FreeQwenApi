/**
 * Browser proxy page — executes DeepSeek API calls inside an authenticated browser context.
 */
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { logInfo, logWarn, logDebug } from "../../../shared/logger/index.js";
import { CHAT_PAGE_URL, DEEPSEEK_MODELS } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.resolve(__dirname, "..", "..", "session"); // Project root session/
const LEGACY_ACCOUNTS_PATH = path.resolve(__dirname, "..", "session"); // services/session/ (old location)

// Resolve active file once at module load to prevent split reads/writes
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

let browser = null;
let page = null;
let cdpSession = null; // CDP session for network interception
let activeInterceptId = null; // Pending request ID to intercept
let interceptedRequest = null; // Captured { requestId, url, headers }

// Cached session data loaded once at init
let cachedAuthData = {};
let cachedStorage = { ls: {}, ss: {} };

/** Load full session: cookies + authData + storage from file */
function loadSavedSession() {
  try {
    const { file } = resolveActiveFile();
    if (!fs.existsSync(file)) return null;

    const data = JSON.parse(fs.readFileSync(file, "utf8"));

    if (Array.isArray(data) && data.length > 0) {
      // Find last deepseek_ account (file may contain Qwen accounts too)
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
    logWarn(`[BrowserProxy] Ошибка чтения сессии: ${err.message}`);
  }
  return null;
}

/** Restore localStorage BEFORE navigation via evaluateOnNewDocument */
async function restoreLocalStorage(page, storage) {
  if (!storage || !storage.ls) return;

  const lsEntries = Object.entries(storage.ls);
  if (lsEntries.length === 0) return;

  // Use evaluateOnNewDocument so localStorage is set BEFORE any site scripts run
  await page.evaluateOnNewDocument((entries) => {
    for (const [key, val] of entries) {
      try {
        const strVal = typeof val === "string" ? val : JSON.stringify(val);
        if (!localStorage.getItem(key)) localStorage.setItem(key, strVal);
      } catch {}
    }
  }, lsEntries);

  logInfo(`[BrowserProxy] Предварительно загружено ${lsEntries.length} записей localStorage`);
}

/** Check if user is authenticated — verify cookies exist on the target domain */
async function checkAuthViaApi(page) {
  try {
    // DeepSeek's /api/v0/user requires PoW headers (hif-dliq/hif-leim)
    // which we don't have → returns MISSING_HEADER even with valid cookies.
    // Instead, just verify the essential cookie exists on page cookies().
    const cookies = await page.cookies(CHAT_PAGE_URL);
    if (!cookies.length) return false;

    // Check for essential auth cookies (set by DeepSeek SSO)
    const hasAuthCookie = cookies.some(
      (c) => c.name === "aws-waf-token" || c.name === "ds_session_id"
    );
    return hasAuthCookie;
  } catch {
    logDebug("[BrowserProxy] Cookie проверка недоступна, fallback на localStorage");
    // Fallback: check if we have userToken in restored localStorage
    try {
      const ls = await page.evaluate(() => !!localStorage.getItem("userToken"));
      return !!ls;
    } catch {
      return false;
    }
  }
}

// ─── Context setup: must run BEFORE page creation ──────────
let contextSetupDone = false;

async function setupExecutionContext() {
  if (contextSetupDone) return;
  contextSetupDone = true;

  puppeteer.use(StealthPlugin());
  browser = await puppeteer.launch({
    headless: "new",
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
}

export async function initBrowserPage() {
  if (page) return true;

  try {
    // Step 1: Setup browser context first
    await setupExecutionContext();

    // Load full session data (cookies + authData + storage)
    const savedSession = loadSavedSession();

    if (savedSession && savedSession.cookies.length > 0) {
      cachedAuthData = savedSession.authData;
      cachedStorage = savedSession.storage;
    } else {
      logWarn("[BrowserProxy] Сессионные данные не найдены — запуск без авторизации");
      cachedAuthData = {};
      cachedStorage = { ls: {}, ss: {} };
    }

    // Step 2: Create page with localStorage restoration FIRST (before any navigation)
    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // CRITICAL: Restore localStorage BEFORE cookies — some DeepSeek features depend on it
    if (cachedStorage.ls && Object.keys(cachedStorage.ls).length > 0) {
      await restoreLocalStorage(page, cachedStorage);
    }

    // Restore cookies BEFORE navigation (browser sends them with the request)
    if (savedSession && savedSession.cookies.length > 0) {
      await page.setCookie(...savedSession.cookies);
      logInfo(`[BrowserProxy] Загружено ${savedSession.cookies.length} cookie из сессии`);
    }

    // Step 4: Navigate to DeepSeek
    await page.goto(CHAT_PAGE_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    // Wait for ALL resources to load (including .wasm which DeepSeek fetches dynamically)
    logInfo("[BrowserProxy] Ожидание полной загрузки ресурсов страницы...");
    await page.evaluate(async () => {
      return new Promise((resolve) => setTimeout(resolve, 3000));
    });

    // Step 5: Reliable auth check via API instead of document.cookie sniffing
    const loggedIn = await checkAuthViaApi(page);

    if (!loggedIn) {
      logWarn("[BrowserProxy] 🔴 Cookie истекли! Запустите авторизацию заново (меню → пункт 1)");
    } else {
      logInfo("✅ Браузерная страница готова (авторизован)");
    }
  } catch (err) {
    logWarn("[BrowserProxy] Ошибка инициализации:", err.message);
  }

  return !!page;
}

// ─── Chat session management ────────────────────────────────
// Stores conversation_hint → { sessionId, parentMessageId }
const chatSessions = new Map();

async function ensureSession(conversationHint) {
  // Return existing session or create one
  const hint = conversationHint || "_default";
  if (chatSessions.has(hint)) return chatSessions.get(hint);

  try {
    const result = await page.evaluate(async () => {
      const resp = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
        method: "POST",
        headers: {
          Accept: "*/*",
          "Content-Type": "application/json;charset=UTF-8",
          Origin: "https://chat.deepseek.com",
          Referer: "https://chat.deepseek.com/",
          "Accept-Language": "en-US,en;q=0.9",
          "x-client-platform": "web",
        },
        credentials: "include",
        body: JSON.stringify({}),
      });

      const text = await resp.text();
      if (!resp.ok) return { error: `HTTP ${resp.status}: ${text.slice(0, 300)}` };

      let json = null;
      try {
        json = JSON.parse(text);
        // Detect INVALID_TOKEN — session cookies expired, need re-auth
        if (
          json?.code === 40003 ||
          (json?.msg && String(json.msg).toLowerCase().includes("token"))
        ) {
          return { error: "INVALID_TOKEN", raw: text.slice(0, 500) };
        }
      } catch {}

      const sessionId = json?.data?.biz_data?.chat_session?.id || json?.data?.biz_data?.id || null;
      return { sessionId, raw: text.slice(0, 300) };
    });

    if (result.error && result.error.includes("INVALID_TOKEN")) {
      logWarn(`[BrowserProxy] 🔴 Cookie истекли! Запустите авторизацию заново (меню → пункт 1)`);
      chatSessions.clear();
    } else if (result.error) {
      logWarn(`[BrowserProxy] createSession failed: ${result.error}`);
    }

    if (result.sessionId) {
      logInfo(`[BrowserProxy] Создана сессия: ${result.sessionId.slice(0, 12)}...`);
      const session = { sessionId: result.sessionId, parentMessageId: null };
      chatSessions.set(hint, session);
      return session;
    }
  } catch (err) {
    logWarn(`[BrowserProxy] createSession exception: ${err.message}`);
  }

  // Fallback: use random UUID — messages will work but chats won't be visible on web
  const fallback = { sessionId: crypto.randomUUID(), parentMessageId: null };
  chatSessions.set(hint, fallback);
  return fallback;
}

/** Find WASM URL in the page context using multiple strategies */
async function findWasmUrl() {
  if (!page) return null;

  const wasmUrlResult = await page.evaluate(async () => {
    try {
      // Method 1: Check performance API for .wasm resources
      const entries = performance.getEntriesByType("resource");
      for (const entry of entries) {
        if (/\.wasm/i.test(entry.name)) return entry.name;
      }
    } catch {}

    try {
      // Method 2: Check all scripts for wasm-related names
      for (const script of document.querySelectorAll("script[src]")) {
        const src = script.src.toLowerCase();
        if (/wasm/.test(src) || /solve/i.test(src)) return script.src;
      }
    } catch {}

    try {
      // Method 3: Look for wasm URLs in global variables set by the app
      const win = window;
      if (win.__DS_WASM_URL__) return win.__DS_WASM_URL__;
      if (win.deepseekWasmUrl) return win.deepseekWasmUrl;
    } catch {}

    try {
      // Method 4: Check loaded modules from service worker or caches
      for (const cacheName of ["ds-cache", "pow-cache", "app-cache"]) {
        if (caches) {
          const cache = await caches.open(cacheName);
          const keys = await cache.keys();
          for (const req of keys) {
            if (/\.wasm/i.test(req.url)) return req.url;
          }
        }
      }
    } catch {}

    try {
      // Method 5: DeepSeek may store wasm URL in localStorage or sessionStorage after loading
      const lsKeys = Object.keys(localStorage);
      for (const key of lsKeys) {
        if (/wasm/.test(key)) return localStorage.getItem(key);
      }
      const ssKeys = Object.keys(sessionStorage);
      for (const key of ssKeys) {
        if (/wasm/.test(key)) return sessionStorage.getItem(key);
      }
    } catch {}

    return null;
  });

  return wasmUrlResult;
}

export async function sendViaBrowser(messages, model, conversationHint) {
  if (!page) {
    logWarn("[BrowserProxy] Страница не инициализирована.");
    return { success: false, error: "Нет активной страницы браузера" };
  }

  // Ensure we have a valid chat session for this conversation
  const session = await ensureSession(conversationHint);

  try {
    const lastMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    // Resolve model config from DEEPSEEK_MODELS (handles aliases properly)
    const cfg = DEEPSEEK_MODELS[model] ?? DEEPSEEK_MODELS["deepseek-v3"];

    // Build message history context (Human:/Assistant: format for DeepSeek v0 API)
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

    logInfo(
      `[BrowserProxy] Запрос: model_type=${cfg.model_type}, thinking=${cfg.thinking_enabled}`
    );

    logInfo(
      `[BrowserProxy] Сессия: ${session.sessionId}${session.parentMessageId ? `, parentMsg: ${session.parentMessageId}` : ``}`
    );

    // Auth data from cached session
    const authData = { ...cachedAuthData };

    // Find WASM URL inside the browser context (DeepSeek loads it dynamically on every visit)
    logInfo("[BrowserProxy] Поиск WASM модуля для PoW...");
    let wasmUrlResult = await findWasmUrl();

    let powResponseHeader = "";
    if (wasmUrlResult) {
      logInfo(`[BrowserProxy] WASM найден: ${wasmUrlResult.slice(0, 60)}...`);

      // Solve PoW challenge INSIDE the browser context using real WASM solver
      powResponseHeader = await page.evaluate(async (url) => {
        try {
          const baseUrl = "https://chat.deepseek.com/api/v0/chat/completion";

          // 1. Get challenge
          const chalResp = await fetch(baseUrl + "/create_pow_challenge", {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json;charset=UTF-8" },
            body: JSON.stringify({ target_path: baseUrl }),
          });

          if (!chalResp.ok) throw new Error(`Challenge failed HTTP ${chalResp.status}`);
          const chalData = await chalResp.json();
          const challenge = chalData?.data?.biz_data?.challenge;
          if (!challenge) throw new Error("No challenge in response");

          // 2. Load and run WASM solver (same logic as chat.js)
          const wasmResp = await fetch(url);
          const wasmBytes = await wasmResp.arrayBuffer();
          const { instance } = await WebAssembly.instantiate(wasmBytes, { wbg: {} });
          const e = instance.exports;

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
          e.wasm_solve(sp, cP, cBytes.length, pP, pBytes.length, challenge.difficulty || 4096);

          const dv = new DataView(e.memory.buffer);
          const code = dv.getInt32(sp, true);
          const ans = dv.getFloat64(sp + 8, true);
          e.__wbindgen_add_to_stack_pointer(16);

          if (code === 0 || !Number.isFinite(ans) || ans <= 0)
            throw new Error(`PoW solve failed (code=${code}, ans=${ans})`);

          // 3. Encode as Base64 for header
          const powData = JSON.stringify({
            algorithm: challenge.algorithm,
            challenge: challenge.challenge,
            salt: challenge.salt,
            answer: Math.floor(ans),
            signature: challenge.signature || "",
            target_path: baseUrl,
          });

          return btoa(unescape(encodeURIComponent(powData))); // safe Base64 in browser
        } catch (err) {
          console.warn("[PoW] Solve failed:", err.message);
          return null;
        }
      }, wasmUrlResult);

      if (powResponseHeader) {
        logInfo("[BrowserProxy] ✅ PoW решён успешно");
      } else {
        logWarn("[BrowserProxy] ⚠️ Не удалось решить PoW — пробуем без заголовка");
      }
    } else {
      logWarn("[BrowserProxy] ⚠️ WASM модуль не найден — PoW пропущен");
    }

    // Pass PoW header + auth headers into the evaluation context
    return await page.evaluate(
      async ({ prompt, cfg, session, authData, powHeader }) => {
        const apiUrl = "https://chat.deepseek.com/api/v0/chat/completion";

        // Extract userToken from localStorage (set by PoW interceptor or restored storage)
        let bearerToken = "";
        try {
          const userTokenRaw = localStorage.getItem("userToken");
          if (userTokenRaw) {
            try {
              const parsed = JSON.parse(userTokenRaw);
              bearerToken = parsed?.value || userTokenRaw;
            } catch {
              bearerToken = userTokenRaw;
            }
          }
        } catch {}

        // Fallback: use cached authData if localStorage miss (shouldn't happen with restored storage)
        if (!bearerToken && authData.bearerToken) {
          bearerToken = authData.bearerToken;
        }

        // Use session ID passed from Node.js layer (created via ensureSession)
        const chatSessionId = session?.sessionId || crypto.randomUUID();
        const parentMessageId = session?.parentMessageId || null;

        const body = {
          model_type: cfg.model_type || "default",
          prompt,
          thinking_enabled: cfg.thinking_enabled ?? false,
          search_enabled: false,
          ref_file_ids: [],
          action: null,
          preempt: false,
          chat_session_id: chatSessionId,
        };

        // Build headers — include all anti-fingerprint headers from authData
        const authHeaders = (authData && typeof authData === "object") || {};
        const headers = {
          Accept: "*/*",
          "Content-Type": "application/json;charset=UTF-8",
          Origin: "https://chat.deepseek.com",
          Referer: "https://chat.deepseek.com/",
          "Accept-Language": "en-US,en;q=0.9",
          "Sec-Ch-Ua": '"Not_A Brand";v="8", "Chromium";v="131", "Google Chrome";v="131"',
          "Sec-Ch-Ua-Mobile": "?0",
          "Sec-Ch-Ua-Platform": '"Windows"',
          "x-client-platform": "web",
        };

        // CRITICAL: Add hif-dliq and hif-leim from authData (anti-fingerprint headers)
        if (authHeaders.hif_dliq) {
          headers["hif-dliq"] = authHeaders.hif_dliq;
        }
        if (authHeaders.hif_leim) {
          headers["hif-leim"] = authHeaders.hif_leim;
        }

        // Add x-client-version if available
        if (authHeaders.x_client_version) {
          headers["x-client-version"] = authHeaders.x_client_version;
        }

        // Add Bearer token if available (for Authorization header)
        if (bearerToken && !String(headers["Authorization"] || "").startsWith("Bearer")) {
          headers["Authorization"] = `Bearer ${bearerToken}`;
        }

        // CRITICAL: Add solved PoW response header (X-DS-PoW-Response) — required by DeepSeek API!
        if (powHeader) {
          headers["X-DS-PoW-Response"] = powHeader;
        }

        const response = await fetch(apiUrl, {
          method: "POST",
          headers,
          credentials: "include", // send cookies automatically
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, error: `HTTP ${response.status}: ${errText.slice(0, 200)}` };
        }

        // Check content-type — DeepSeek may return JSON instead of SSE
        const contentType = response.headers.get("content-type") || "";

        if (!contentType.includes("text/event-stream")) {
          // Handle as single JSON response
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

          // Debug info for diagnostics
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

        // Parse SSE stream (same format as chat.js)
        let fullContent = "";
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let firstChunkSample = null;

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const line of lines) {
              if (!line.startsWith("data:")) continue;

              const dataStr = line.slice(5).trim();
              if (!dataStr || dataStr === "[DONE]") continue;

              try {
                const json = JSON.parse(dataStr);

                // Skip thinking elapsed marker
                if (json.p === "response/thinking_elapsed_secs") continue;

                // CRITICAL: Check for errors in SSE stream (e.g., MISSING_HEADER, INVALID_TOKEN)
                if (json.code && json.msg) {
                  throw new Error(`DeepSeek API error: ${json.code} - ${json.msg}`);
                }
                if (typeof json === "object" && json.error) {
                  throw new Error(
                    `DeepSeek stream error: ${JSON.stringify(json.error).slice(0, 200)}`
                  );
                }

                // Debug: capture first chunk structure
                if (!firstChunkSample) {
                  firstChunkSample = {
                    keys: Object.keys(json),
                    sample: JSON.stringify(json).slice(0, 300),
                  };
                }

                // Extract text from delta chunks (v field)
                if (json.v && typeof json.v === "string") {
                  fullContent += json.v;
                }
              } catch (err) {
                // Only throw real errors, ignore JSON parse failures on partial lines
                if (!err.message.includes("Unexpected end") && !err.message.includes("JSON")) {
                  console.error(`[SSE Parser Error]:`, err);
                  throw err; // Bubble up to break the reader loop
                }
              }
            }
          } // close while(true)
        } catch (e) {}

        return {
          success: true,
          data: { content: fullContent },
          _debug: {
            contentType: "sse",
            firstChunk: firstChunkSample,
            contentLength: fullContent.length,
          },
        };
      },
      {
        prompt: promptText || lastMsg,
        cfg: {
          model_type: cfg.model_type,
          thinking_enabled: cfg.thinking_enabled,
          search_enabled: cfg.search_enabled ?? false,
        },
        session: { sessionId: session.sessionId, parentMessageId: session.parentMessageId },
        authData,
        powHeader: powResponseHeader, // Solve PoW before each request
      }
    );
  } catch (err) {
    logWarn("[BrowserProxy] Ошибка отправки через браузер:", err.message);
    return { success: false, error: err.message };
  }
}

export async function shutdownBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
  // Reset all state so next init reloads fresh session data
  contextSetupDone = false;
  cachedAuthData = {};
  cachedStorage = { ls: {}, ss: {} };
}
