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
import { solvePoW } from "../utils/powSolver.js";

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
let pageReady = false; // true only after initBrowserPage completes fully
let cdpSession = null; // CDP session for network interception
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
    // Check cookies on BOTH domains — DeepSeek sets aws-waf-token on .deepseek.com,
    // ds_session_id on chat.deepseek.com. After WAF refresh, new token may replace old.
    // Puppeteer takes URL or no domain filter. Use chat subdomain and all-cookies to catch both domains.
    const cookiesChat = await page.cookies("https://chat.deepseek.com");
    let cookiesAll = [];
    try {
      cookiesAll = await page.cookies(); // Catch .deepseek.com root cookies
    } catch {}
    // Merge unique by name+domain path
    const cookieMap = new Map();
    for (const c of [...cookiesChat, ...cookiesAll]) {
      cookieMap.set(`${c.name}@${c.domain}:${c.path}`, c);
    }
    const allCookies = [...cookieMap.values()];

    if (!allCookies.length) {
      logDebug(`[BrowserProxy] Нет cookie на странице`);
      return false;
    }

    // Check for essential auth cookies (set by DeepSeek SSO)
    const hasAuthCookie = allCookies.some(
      (c) => c.name === "aws-waf-token" || c.name === "ds_session_id"
    );

    if (!hasAuthCookie) {
      const cookieNames = allCookies.map((c) => c.name);
      logDebug(
        `[BrowserProxy] Cookie на странице (${allCookies.length}): ${cookieNames.join(", ")}`
      );
    }

    if (!hasAuthCookie) {
      // Fallback: check for userToken in restored localStorage
      try {
        const ls = await page.evaluate(() => {
          const token = localStorage.getItem("userToken");
          return token ? JSON.parse(token)?.value || "" : "";
        });
        if (ls) {
          logInfo(`[BrowserProxy] Fallback: userToken найден в localStorage`);
        } else {
          return false;
        }
      } catch {
        return false;
      }
    }

    // Validate cookies via lightweight API call — cookies may exist but be stale/expired
    try {
      const valid = await page.evaluate(async () => {
        const resp = await fetch("https://chat.deepseek.com/api/v0/chat_session/create", {
          method: "POST",
          credentials: "include",
          headers: {
            Accept: "*/*",
            "Content-Type": "application/json;charset=UTF-8",
            Origin: "https://chat.deepseek.com",
            Referer: "https://chat.deepseek.com/",
            "Accept-Language": "en-US,en;q=0.9",
            "x-client-platform": "web",
          },
          body: JSON.stringify({}),
        });
        const text = await resp.text();
        if (resp.ok) {
          // Check for auth errors in JSON response body
          try {
            const json = JSON.parse(text);
            if (
              json?.code === 40003 ||
              (json?.msg && String(json.msg).toLowerCase().includes("token"))
            ) {
              return false;
            }
          } catch {}
          return true;
        }
        if (resp.status === 400) {
          // HTTP 400 may be mis-param, not auth error — check body
          if (text.includes("INVALID_TOKEN") || text.toLowerCase().includes("token")) return false;
          return true;
        }
        return false;
      });
      if (valid) {
        logInfo("✅ Браузерная страница готова (авторизован)");
        return true;
      }
      logWarn("[BrowserProxy] 🔴 Cookie истекли (API проверка не прошла)");
      return false;
    } catch (apiErr) {
      logDebug(`[BrowserProxy] API проверка недоступна: ${apiErr.message}`);
      // If API check fails, trust cookie presence as best-effort
      return hasAuthCookie;
    }
  } catch (e) {
    logDebug(`[BrowserProxy] Cookie проверка недоступна: ${e.message}`);
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

// Windows Chrome 131 stable user-agent for realistic fingerprint
const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

async function setupExecutionContext() {
  if (contextSetupDone) return;
  contextSetupDone = true;

  puppeteer.use(StealthPlugin());
  browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-features=IsolateOrigins,site-per-process",
      "--disable-web-security",
      "--disable-features=BlockInsecurePrivateNetworkRequests",
    ],
  });
}

export async function initBrowserPage() {
  if (page && pageReady) return true;
  if (page && !pageReady) {
    // Page exists but still initializing — wait for it
    logInfo("[BrowserProxy] Ожидание завершения инициализации страницы...");
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (pageReady) return true;
    }
    logWarn("[BrowserProxy] Таймаут ожидания инициализации страницы");
    return false;
  }

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

    // Set realistic Chrome user-agent (important for DeepSeek WAF)
    await page.setUserAgent(DEFAULT_UA);

    // ─── Anti-detection measures (Qwen-style) ───────────────────────────
    // DeepSeek WAF may detect headless/automated browser and invalidate session.
    // These overrides run before any page scripts.
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => false });
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          app: {},
          csi: () => {},
          loadTimes: () => {},
        };
      }
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "language", { get: () => "en-US" });
      Object.defineProperty(navigator, "plugins", {
        get: () => [
          {
            0: {
              type: "application/x-google-chrome-pdf",
              suffixes: "pdf",
              description: "Portable Document Format",
            },
            description: "Portable Document Format",
            filename: "internal-pdf-viewer",
            length: 1,
            name: "Chrome PDF Plugin",
          },
        ],
      });
    });

    // CRITICAL: Restore localStorage BEFORE any navigation — DeepSeek features depend on it
    if (cachedStorage.ls && Object.keys(cachedStorage.ls).length > 0) {
      await restoreLocalStorage(page, cachedStorage);
    }

    // Step 3: Enable CDP session early for cookie restoration (bypass domain restrictions)
    try {
      cdpSession = await page.createCDPSession();
      await cdpSession.send("Network.enable", { maxPostDataSize: 65536 });
    } catch (e) {
      logWarn(`[BrowserProxy] CDP init failed: ${e.message}`);
    }

    // Restore cookies BEFORE navigation — use CDP to bypass domain restrictions
    // (page.setCookie may silently drop cookies for domains different from current page URL)
    if (savedSession && savedSession.cookies.length > 0) {
      try {
        logInfo(`[BrowserProxy] Установка ${savedSession.cookies.length} cookie через CDP...`);
        for (const c of savedSession.cookies) {
          // Session cookie params for CDP (omit expires for session cookies)
          const cookieParams = {
            name: c.name,
            value: c.value,
            domain: c.domain || ".deepseek.com",
            path: c.path || "/",
            secure: c.secure ?? true,
            httpOnly: c.httpOnly ?? false,
            sameSite: c.sameSite || "Lax",
          };
          // Include expires only for non-session cookies
          if (!c.session && c.expires && c.expires > 0) {
            cookieParams.expires = c.expires;
          }
          // Restore ALL cookies including session-only (ds_session_id is critical for auth)
          await cdpSession.send("Network.setCookie", cookieParams);
        }
        // Verify by reading back
        const verifyCookies = await page.cookies();
        logInfo(`[BrowserProxy] После CDP установки: ${verifyCookies.length} cookie на странице`);
        const cookieNames = verifyCookies.map(
          (c) => `${c.name}=${(c.value || "").slice(0, 20)}... (${c.domain})`
        );
        logWarn(`[BrowserProxy] Cookie ДО навигации: ${cookieNames.join(", ")}`);
      } catch (e) {
        logWarn(`[BrowserProxy] CDP cookie restore failed: ${e.message}`);
        // Fallback: try page.setCookie
        await page.setCookie(...savedSession.cookies).catch(() => {});
      }
    }

    // Step 4: Navigate to DeepSeek
    await page.goto(CHAT_PAGE_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    // Wait for ALL resources to load (including .wasm which DeepSeek fetches dynamically)
    logInfo("[BrowserProxy] Ожидание полной загрузки ресурсов страницы...");
    await page.evaluate(async () => {
      return new Promise((resolve) => setTimeout(resolve, 5000));
    });

    // Debug: check cookies after navigation — WAF may refresh/replace them
    try {
      const afterCookies = await page.cookies();
      const afterNames = afterCookies.map(
        (c) => `${c.name}=${c.value.slice(0, 20)}... (${c.domain})`
      );
      logWarn(
        `[BrowserProxy] Cookie после навигации (${afterCookies.length}): ${afterNames.join(", ")}`
      );
    } catch (e) {
      logDebug(`[BrowserProxy] Не удалось прочитать cookie: ${e.message}`);
    }

    // Step 5: Informational auth check — WAF may still be challenging at this point
    // (PoW not yet solved, so API calls will fail until PoW is handled in sendViaBrowser)
    // This check is for diagnostics only; does NOT block the request.
    const loggedIn = await checkAuthViaApi(page).catch(() => false);
    if (loggedIn) {
      logInfo("[BrowserProxy] ✅ Сессия валидна (preflight)");
    } else {
      logDebug("[BrowserProxy] Preflight auth check failed (expected — PoW not yet solved)");
    }
  } catch (err) {
    logWarn("[BrowserProxy] Ошибка инициализации:", err.message);
  }

  if (page) pageReady = true;
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

export async function sendViaBrowser(messages, model, conversationHint) {
  if (!page || !pageReady) {
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

    // ─── PoW: Solve via Node.js SHA3-256 solver (no WASM needed) ──
    logInfo("[BrowserProxy] Решение PoW (SHA3-256, Node.js)...");
    let powResponseHeader = "";
    try {
      // Step 1: Get challenge from DeepSeek via browser (needs cookies)
      const challengeData = await page.evaluate(async () => {
        const results = [];

        // Get Bearer token from localStorage (required for challenge endpoint)
        let bearerToken = "";
        try {
          const raw = localStorage.getItem("userToken");
          if (raw) {
            const parsed = JSON.parse(raw);
            bearerToken = parsed?.value || raw;
          }
        } catch {}

        const authHeaders = {
          "Content-Type": "application/json;charset=UTF-8",
          Origin: "https://chat.deepseek.com",
          Referer: "https://chat.deepseek.com/",
        };
        if (bearerToken) {
          authHeaders["Authorization"] = `Bearer ${bearerToken}`;
        }

        // Try multiple target_path values (the path to be called with PoW response)
        const targetPaths = [
          "https://chat.deepseek.com/api/v0/chat/completion",
          "/api/v0/chat/completion",
          "https://chat.deepseek.com/api/v0/chat/create_pow_challenge",
          "",
        ];
        const chalUrl = "https://chat.deepseek.com/api/v0/chat/create_pow_challenge";

        for (const tPath of targetPaths) {
          try {
            const bodyData = tPath ? { target_path: tPath } : {};
            const chalResp = await fetch(chalUrl, {
              method: "POST",
              credentials: "include",
              headers: authHeaders,
              body: JSON.stringify(bodyData),
            });
            const raw = await chalResp.text();
            results.push({
              target_path: tPath || "(empty)",
              status: chalResp.status,
              body: raw.slice(0, 400),
            });
            if (chalResp.ok) {
              try {
                const chalData = JSON.parse(raw);
                const challenge =
                  chalData?.data?.biz_data?.challenge ||
                  chalData?.data?.challenge ||
                  chalData?.challenge ||
                  null;
                if (challenge) return { challenge, endpoint: chalUrl, targetPath: tPath };
              } catch {}
            }
          } catch (e) {
            results.push({ target_path: tPath || "(empty)", error: e.message });
          }
        }
        return { error: "No challenge from any endpoint", debug: results };
      });

      if (challengeData.error) {
        logWarn(`[BrowserProxy] Challenge request failed: ${challengeData.error}`);
        if (challengeData.debug) {
          for (const d of challengeData.debug) {
            logWarn(
              `[BrowserProxy]   → ${d.url}: HTTP ${d.status || "ERR"} ${d.body || d.error || ""}`
            );
          }
        }
      } else {
        // Step 2: Solve PoW in Node.js (pure SHA3-256, no WASM)
        const result = solvePoW(challengeData.challenge);
        powResponseHeader = result.powData;
        logInfo(`[BrowserProxy] ✅ PoW решён (nonce=${result.nonce})`);
      }
    } catch (e) {
      logWarn(`[BrowserProxy] PoW solving error: ${e.message}`);
    }

    if (!powResponseHeader) {
      logWarn("[BrowserProxy] ⚠️ PoW не решён — запрос без X-DS-PoW-Response");
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

export async function checkPageAuth() {
  if (!page || !pageReady) return false;
  return checkAuthViaApi(page);
}

export async function shutdownBrowser() {
  if (browser) {
    await browser.close().catch(() => {});
    browser = null;
    page = null;
  }
  // Reset all state so next init reloads fresh session data
  pageReady = false;
  contextSetupDone = false;
  cachedAuthData = {};
  cachedStorage = { ls: {}, ss: {} };
}
