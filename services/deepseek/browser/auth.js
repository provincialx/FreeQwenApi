import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { logInfo, logError, logWarn, logDebug } from "../../../shared/logger/index.js";
import { CHAT_PAGE_URL, PAGE_TIMEOUT, VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unified accounts storage (Qwen-style)
// Support BOTH old location (services/session/) and new (project root session/)
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

function getAccountsFile() {
  return resolveActiveFile();
}

puppeteer.use(StealthPlugin());

let globalBrowser = null;

// --- Storage Helpers (Qwen-style) ---

function loadAccounts() {
  const { file, dir } = getAccountsFile();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(file)) return [];

  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    console.log(`[DEEPSEEK] Считан файл сессий: ${file}`);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logError(`Ошибка чтения ${file}`, err);
    return [];
  }
}

function saveAccounts(accounts) {
  try {
    const { file, dir } = resolveActiveFile();
    // Ensure directory exists
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(accounts, null, 2), "utf8");
    console.log(`[DEEPSEEK] Файл сохранен: ${file} (${accounts.length} аккаунтов)`);
  } catch (e) {
    logError("КРИТ: Не удалось сохранить файл deepseek_accounts.json!", e);
  }
}

export async function initAuthBrowser() {
  if (globalBrowser) return true;

  try {
    logInfo("Запуск браузера для авторизации DeepSeek...");

    const browser = await puppeteer.launch({
      headless: false,
      args: [
        "--no-sandbox",
        "--disable-blink-features=AutomationControlled",
        "--lang=en-US,en",
        "--window-size=" + VIEWPORT_WIDTH + "," + VIEWPORT_HEIGHT,
      ],
    });

    globalBrowser = browser;
    return true;
  } catch (err) {
    logError("Ошибка запуска браузера DeepSeek", err);
    return false;
  }
}

export async function shutdownAuthBrowser() {
  if (!globalBrowser) return;

  try {
    // Try to save cookies before closing in case they changed
    const pages = globalBrowser.pages?.() || [];
    for (const page of Array.isArray(pages) ? pages : []) {
      try {
        await extractSessionToAccount(page);
      } catch {}
    }
  } finally {
    await globalBrowser.close().catch(() => {});
    globalBrowser = null;
    logInfo("Браузер DeepSeek закрыт");
  }
}

// === PoW Data Capture (hif_dliq, hif_leim, wasmUrl) ===
// DeepSeek adds custom headers via JS fetch. We need TWO capture methods:
// 1. JS-level interceptor: override fetch/XHR before page loads
// 2. CDP network capture: intercept actual wire-level requests as fallback

// CDP-based network capture — captures ALL requests including Service Worker ones
// We use Network.extraInfoReceived which fires AFTER JS adds custom headers (hif_*)
let cdpSession = null;
let networkEvents = [];
let wasmResourceUrls = []; // Captured WASM resource URLs from CDP

// === Aggressive JS-level intercept that works around bundler closures ===
async function injectJSCapture(page) {
  // Phase 1: Initialize the capture object before ANY scripts run
  await page.evaluateOnNewDocument(`(() => { window.__capturedHeaders__ = {}; })()`);
}

// Phase 2: After page loads, install interceptors on the live prototypes.
// This catches bundled fetch/XHR that captured `window.fetch` at module init time.
async function injectPostLoadCapture(page) {
  try {
    await page.evaluate(`(() => {
      // --- Aggressive XHR capture via object property override ---
      const XHRProto = XMLHttpRequest.prototype;

      // Save originals before touching anything
      if (!XHRProto.__origSend) XHRProto.__origSend = XHRProto.send;
      if (!XHRProto.__origOpen) XHRProto.__origOpen = XHRProto.open;

      XHRProto.open = function(method, url) {
        this._captureUrl = url;
        this._captureHeaders = {};
        return XHRProto.__origOpen.call(this, method, url);
      };

      // Intercept setRequestHeader by wrapping it at the PropertyDescriptor level
      const _origSetRH = Object.getOwnPropertyDescriptor(XHRProto, 'setRequestHeader');
      if (_origSetRH) {
        Object.defineProperty(XHRProto, 'setRequestHeader', {
          value: function(name, val) {
            if (!this._captureHeaders) this._captureHeaders = {};
            this._captureHeaders[name] = val;
            return _origSetRH.value.call(this, name, val);
          },
          writable: true,
          configurable: true
        });
      }

      const origSend = XHRProto.__origSend || XHRProto.send;
      Object.defineProperty(XHRProto, 'send', {
        value: function(body) {
          if (this._captureUrl && this._captureUrl.includes('deepseek.com') && this._captureHeaders) {
            window.__capturedHeaders__ = {...window.__capturedHeaders__, ...this._captureHeaders};
            // Log captured XHR headers
            console.log('[XHR_CAPTURE]', this._captureUrl.slice(0, 60), Object.keys(this._captureHeaders));
          }
          return origSend.call(this, body);
        },
        writable: true,
        configurable: true
      });

      // --- Aggressive fetch capture via descriptor override ---
      if (!window.__real_fetch__) {
        window.__real_fetch__ = fetch.bind(window);
      }

      Object.defineProperty(window, 'fetch', {
        value: async function(url, options) {
          const u = (url && url.toString()) || '';
          if (u.includes('deepseek.com') && options && options.headers) {
            let hObj = {};
            try { hObj = Object.fromEntries(options.headers.entries()); }
            catch(e) { hObj = {...options.headers}; }

            window.__capturedHeaders__ = {...window.__capturedHeaders__, ...hObj};
            // Log fetch headers for debugging
            console.log('[FETCH_CAPTURE]', u.slice(0, 60), Object.keys(hObj));
          }
          return window.__real_fetch__(url, options);
        },
        configurable: true,
        writable: true
      });
    })()`);

    logInfo("[Auth] Post-load interceptors installed (XHR + fetch descriptors)");
  } catch (e) {
    logWarn("[Auth] Post-load interceptor failed:", e.message);
  }
}

// Map to correlate requests across CDP events
const _requestMap = new Map();

async function enableNetworkCapture(page) {
  try {
    cdpSession = await page.createCDPSession();
    await cdpSession.send("Network.enable", { maxPostDataSize: 65536 });

    networkEvents = [];
    wasmResourceUrls = [];
    _requestMap.clear();

    // Track requests — captures all deepseek.com request headers
    cdpSession.on("Network.requestWillBeSent", (params) => {
      const url = params.request?.url || "";
      if (/\\.wasm/i.test(url)) {
        wasmResourceUrls.push(url);
        logInfo(`[Auth] CDP: Found WASM resource: ${url.slice(0, 120)}`);
      }

      const reqData = {
        url,
        method: params.request?.method || "",
        headers: params.request?.headers || {},
        timestamp: Date.now(),
      };

      _requestMap.set(params.requestId, reqData);

      // Push to networkEvents for API calls (where hif_* likely present)
      if (url.includes("deepseek.com") && !/\.(js|css|png|svg|woff)/.test(url)) {
        networkEvents.push(reqData);
      }
    });

    // Capture headers AFTER JS modification — extraInfoReceived fires after fetch/XHR interceptors run!
    cdpSession.on("Network.extraInfoReceived", (params) => {
      const reqInfo = _requestMap.get(params.requestId);
      if (!reqInfo) return;

      const headersAfterNet = params.headers || {}; // These are the FINAL headers with hif_*!

      logDebug(
        `[Auth] CDP extraInfo: ${reqInfo.url.slice(0, 60)} keys=[${Object.keys(headersAfterNet).join(", ")}]`
      );

      if (headersAfterNet) {
        // Store final headers — they contain PoW data added by JS interceptors
        reqInfo.finalHeaders = { ...(reqInfo.finalHeaders || reqInfo.headers), ...headersAfterNet };

        // Update in networkEvents too (find matching event)
        for (const ev of networkEvents) {
          if (ev.url === reqInfo.url && ev.timestamp === reqInfo.timestamp) {
            ev.finalHeaders = reqInfo.finalHeaders;
            break;
          }
        }
      }
    });

    // Capture response status for API calls (debug only)
    cdpSession.on("Network.responseReceived", (params) => {
      const reqInfo = _requestMap.get(params.requestId);
      if (!reqInfo) return;
      if (/\/api\//.test(reqInfo.url)) {
        logDebug(`[Auth] CDP response: ${params.response?.status} ${reqInfo.url.slice(0, 60)}`);
      }
    });

    logInfo("[Auth] CDP network observer enabled (non-blocking)");
  } catch (e) {
    logWarn("[Auth] Network capture failed:", e.message);
  }
}

// Extract PoW data from CDP events (includes finalHeaders from extraInfoReceived)
function extractPoWFromNetworkEvents() {
  let hif_dliq = "";
  let hif_leim = "";
  let wasmUrl = "";

  // Find WASM URL from captured resources
  if (wasmResourceUrls.length > 0) {
    wasmUrl = wasmResourceUrls[wasmResourceUrls.length - 1];
  }

  for (const event of networkEvents) {
    // Check BOTH initial headers AND finalHeaders (from extraInfoReceived, post-JS-modification)
    const allHdrs = [event.headers || {}, event.finalHeaders || {}];

    for (const hdrs of allHdrs) {
      if (!hdrs) continue;
      for (const [k, v] of Object.entries(hdrs)) {
        const lower = k.toLowerCase();
        if (lower === "x-hif-dliq" && !hif_dliq) {
          hif_dliq = String(v);
          logInfo(`[Auth] Found x-hif-dliq in ${event.url.slice(0, 50)} (${lower})`);
        }
        if (lower === "x-hif-leim" && !hif_leim) {
          hif_leim = String(v);
          logInfo(`[Auth] Found x-hif-leim in ${event.url.slice(0, 50)} (${lower})`);
        }
      }
    }
  }

  return { hif_dliq, hif_leim, wasmUrl };
}

function extractHifFromCaptured(capturedHeaders = {}) {
  let hif_dliq = "";
  let hif_leim = "";

  for (const [k, v] of Object.entries(capturedHeaders)) {
    if (k.toLowerCase() === "x-hif-dliq") hif_dliq = String(v);
    if (k.toLowerCase() === "x-hif-leim") hif_leim = String(v);
  }

  return { hif_dliq, hif_leim };
}
async function extractSessionToAccount(page, networkData = {}) {
  try {
    // Try specific domain first, fallback to ALL cookies (DeepSeek may set on .deepseek.com)
    let cookies = await page.cookies(CHAT_PAGE_URL);
    if (!cookies.length) {
      logWarn("[Auth] Куки для точного домена не найдены — получаю все куки страницы");
      cookies = await page.cookies(); // No domain filter
    }

    if (!cookies.length) {
      logError("[Auth] Нет cookie на странице. Возможно, вход не прошёл.");
      return false;
    }
    const rawData = await page.evaluate(() => {
      const result = { ls: {}, ss: {} };

      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          let val = localStorage.getItem(key);
          // Try parsing JSON values to find hidden configs
          if (val && (val.startsWith("{") || val.startsWith("["))) {
            try {
              result.ls[key] = JSON.parse(val);
            } catch {
              result.ls[key] = val;
            }
          } else {
            result.ls[key] = val;
          }
        }
      } catch {}

      try {
        for (let i = 0; i < sessionStorage.length; i++) {
          const key = sessionStorage.key(i);
          let val = sessionStorage.getItem(key);
          // Same JSON parsing as localStorage
          if (val && (val.startsWith("{") || val.startsWith("["))) {
            try {
              result.ss[key] = JSON.parse(val);
            } catch {
              result.ss[key] = val;
            }
          } else {
            result.ss[key] = val;
          }
        }
      } catch {}

      return result;
    });
    function deepSearch(rootObj, targetKeys, storageName = "storage", exactOnly = false) {
      let found = null;

      function iterate(current, path = "") {
        if (found || !current || typeof current !== "object") return;

        // If it's an array, check elements
        if (Array.isArray(current)) {
          for (let i = 0; i < current.length; i++) iterate(current[i], `${path}[${i}]`);
          return;
        }

        for (const key of Object.keys(current)) {
          const val = current[key];

          // Check direct match
          if (targetKeys.includes(key) && val !== undefined && val !== null) {
            found = val;
            logInfo(
              `[DeepSearch/${storageName}] Found '${key}' at: ${path ? path + "." : ""}${key}`
            );
            return;
          }

          // Partial match only when NOT exactOnly — avoids false positives like aws_waf_token_challenge_attempts ~token
          if (!exactOnly) {
            const lowerKey = key.toLowerCase();
            for (const tk of targetKeys) {
              if (
                lowerKey !== tk.toLowerCase() && // skip if already matched directly
                lowerKey.includes(tk.toLowerCase()) &&
                val !== undefined &&
                val !== null
              ) {
                found = val;
                logInfo(
                  `[DeepSearch/${storageName}] Found '${key}' (~${tk}) at: ${path ? path + "." : ""}${key}`
                );
                return;
              }
            }
          }

          // Recurse deeper
          iterate(val, path ? `${path}.${key}` : key);
        }
      }

      iterate(rootObj);
      return found;
    }

    // Search both localStorage AND sessionStorage — DeepSeek may store auth data in either
    function searchBoth(targetKeys, exactOnly = false) {
      const lsResult = deepSearch(rawData.ls, targetKeys, "ls", exactOnly);
      if (lsResult) return lsResult;

      const ssResult = deepSearch(rawData.ss, targetKeys, "ss", exactOnly);
      if (ssResult) return ssResult;

      return null;
    }

    // Extract important auth data from storage using robust search
    let token = "";
    let wasmUrl = "";
    let hif_dliq = "";
    let hif_leim = "";
    let x_client_version = "2.0.0"; // default fallback

    const cookieObjMap = {};
    for (const c of cookies) {
      cookieObjMap[c.name] = c.value;
    }

    // --- Extract auth tokens from cookies + localStorage (DeepSeek v2+) ---
    // DeepSeek uses TWO different tokens:
    // 1. aws-waf-token (cookie) — session cookie for WAF
    // 2. userToken (localStorage) — Bearer token for Authorization header

    let bearerToken = "";

    if (!token && cookieObjMap["aws-waf-token"]) {
      token = cookieObjMap["aws-waf-token"];
      logInfo("[Auth] Cookie token extracted from aws-waf-token");
    }

    // Extract userToken for Authorization Bearer header (from localStorage)
    const lsUserToken = rawData.ls?.userToken;
    if (lsUserToken && typeof lsUserToken === "object" && lsUserToken.value) {
      bearerToken = lsUserToken.value;
      logInfo(`[Auth] userToken extracted from localStorage (${bearerToken.slice(0, 12)}...)`);
    } else if (!token) {
      const lsData = rawData.ls;
      token = lsData.token || lsData.authorization || lsData.auth_token || "";
      bearerToken = searchBoth(["userToken", "access_token"], true) || "";
      // Handle object-wrapped values
      if (bearerToken && typeof bearerToken === "object") {
        bearerToken = bearerToken.value || "";
      }
    }

    // --- Extract from Network capture (from intercepted headers) ---
    if (!wasmUrl && networkData.wasmUrl) {
      wasmUrl = networkData.wasmUrl;
      logInfo("[Auth] wasmUrl from network/performance: OK");
    }

    if (!hif_dliq && networkData.hif_dliq) {
      hif_dliq = networkData.hif_dliq;
      logInfo("[Auth] hif_dliq from network capture: OK");
    } else {
      // Fallback: search localStorage
      const lsData = rawData.ls;
      hif_dliq =
        lsData.hif_dliq || cookieObjMap["hif_dliq"] || searchBoth(["hif_dliq", "HIF_DLIQ"]) || "";
    }
    logInfo(`[Auth] hif_dliq found: ${!!hif_dliq}`);

    if (!hif_leim && networkData.hif_leim) {
      hif_leim = networkData.hif_leim;
      logInfo("[Auth] hif_leim from network capture: OK");
    } else {
      // Fallback: search localStorage
      const lsData = rawData.ls;
      hif_leim =
        lsData.hif_leim || cookieObjMap["hif_leim"] || searchBoth(["hif_leim", "HIF_LEIM"]) || "";
    }
    logInfo(`[Auth] hif_leim found: ${!!hif_leim}`);

    // --- wasmUrl fallback from storage ---
    if (!wasmUrl) {
      wasmUrl = searchBoth(["wasmUrl", "wasm_url"]) || "";
      logInfo(`[Auth] wasmUrl from storage: ${!!wasmUrl}`);
    }

    const foundClientVersion =
      rawData.ls["x-client-version"] ||
      searchBoth(["client_version", "version", "VERSION", "_c2c_version"]);

    // Ensure x_client_version is a string — it can be stored as {value: 1, __version: "0"} which breaks headers
    if (foundClientVersion) {
      x_client_version =
        typeof foundClientVersion === "string"
          ? foundClientVersion
          : String(foundClientVersion.value || foundClientVersion);
    }

    // Deep DEBUG: show first-level values of config keys when PoW missing
    if (!wasmUrl || !hif_dliq || !hif_leim) {
      const lsData = rawData.ls;

      // Check APMPLUS cache — likely server config with wasm info
      if (lsData["APMPLUS_cache__server_config_675113"])
        logInfo(
          `[Debug/ServerConfig] ${JSON.stringify(lsData["APMPLUS_cache__server_config_675113"]).slice(0, 400)}`
        );

      // Check tea tokens — might contain auth data
      if (lsData["__tea_cache_tokens_20006317"])
        logInfo(
          `[Debug/TeaTokens] ${JSON.stringify(lsData["__tea_cache_tokens_20006317"]).slice(0, 400)}`
        );

      // Check ds_remote_feature_store — might have wasm hints
      if (lsData["__ds_remote_feature_store"])
        logInfo(
          `[Debug/FeatureStore] ${JSON.stringify(lsData["__ds_remote_feature_store"]).slice(0, 400)}`
        );

      // Show ALL cookie names + truncated values — PoW data may be in cookies
      const cookieNames = (await page.cookies()).map((c) => c.name);
      logInfo(`[Debug/Cookies] Names: ${cookieNames.join(", ")}`);
    }

    const allKeys = Object.keys(rawData.ls).concat(Object.keys(rawData.ss));
    logInfo(`DeepSeek Storage Keys: ${allKeys.join(", ")}`);

    const authData = { token, bearerToken, wasmUrl, hif_dliq, hif_leim, x_client_version };

    // Log status (without sensitive full values)
    if (!wasmUrl || !hif_dliq || !hif_leim) {
      logWarn(
        `DeepSeek: Критические данные PoW не найдены. wasmUrl=${!!wasmUrl}, hif_dliq=${!!hif_dliq}, hif_leim=${!!hif_leim}`
      );
    } else {
      logInfo("DeepSeek: Все данные для PoW найдены успешно!");
    }

    const accounts = loadAccounts();

    // Remove old deepseek accounts and add fresh one
    const filtered = accounts.filter((a) => !a.id?.startsWith("deepseek_"));

    filtered.push({
      id: "deepseek_" + Date.now().toString(36),
      cookies: cookies,
      authData: authData, // Store token and other headers here
      storage: rawData, // Full raw storage for debugging
      lastUsedAt: new Date().toISOString(),
      invalid: false,
      resetAt: null,
    });

    const { file } = resolveActiveFile();
    saveAccounts(filtered);
    logInfo(`Аккаунт DeepSeek сохранен: ${file}`);

    return true;
  } catch (err) {
    logError("Ошибка извлечения сессии DeepSeek", err);
    return false;
  }
}

export async function addAccountInteractive() {
  const ok = await initAuthBrowser();
  if (!ok) {
    logError("Не удалось запустить браузер.");
    return null;
  }

  try {
    // Close existing pages (browser may start with a blank page)
    const existingPages = globalBrowser.pages?.() || [];
    for (const p of Array.isArray(existingPages) ? existingPages : []) {
      try {
        p.close();
      } catch {}
    }

    const page = await globalBrowser.newPage();
    await page.setViewport({ width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT });

    // Phase 1: Init capture object (runs before any scripts)
    await injectJSCapture(page);

    // CDP network capture — captures WASM resources + request metadata
    await enableNetworkCapture(page);

    await page.goto(CHAT_PAGE_URL, { waitUntil: "networkidle2", timeout: 30000 });

    // Install post-load interceptors AFTER navigation (catches bundled fetch/XHR)
    await injectPostLoadCapture(page);

    console.log("\n------------------------------------------------------");
    console.log("               ОЖИДАНИЕ ВХОДА В DEEPSEEK");
    console.log("------------------------------------------------------");
    console.log("1. Нажмите Login в правом верхнем углу.");
    console.log("2. Войдите через GitHub / Google в браузере.");
    console.log("3. Отправьте короткое сообщение (напр. 'ok') — это обязательно!");
    console.log("   Сообщение заставляет DeepSeek загрузить PoW модуль и сохранить сессию.");
    console.log("4. ПОДОЖДИТЕ 5 секунд после отправки, затем нажмите ENTER здесь.");
    console.log("------------------------------------------------------\n");

    const { prompt } = await import("../../../shared/utils/prompt.js");
    await prompt("Нажмите ENTER после успешной авторизации...");
    logInfo("Вход подтверждён, извлекаю сессию...");

    // Wait for DeepSeek to finish loading WASM + PoW modules (they load AFTER first API call)
    logInfo("[Auth] Ожидание загрузки WASM модулей (8s)...");
    await new Promise((r) => setTimeout(r, 8000));

    // === Collect PoW data from ALL sources and merge ===

    // Source 1: JS-level interceptor (window.__capturedHeaders__)
    const jsAuthData = await page.evaluate(() => {
      return {
        fetchHeaders: window.__capturedHeaders__ || {},
        xhrHeaders: window.__lastXHRHeaders__ || {},
      };
    });

    // Log JS capture results — dump ALL keys for debugging
    const allJsHeaders = { ...jsAuthData.fetchHeaders, ...jsAuthData.xhrHeaders };
    logInfo(`[Auth] JS capture: headers_keys=[${Object.keys(allJsHeaders).join(", ")}]`);

    // Debug: show fetch-specific keys (they usually have PoW data)
    const fetchKeys = Object.keys(jsAuthData.fetchHeaders || {});
    if (fetchKeys.length > 0) {
      logInfo(`[Debug/JSFetch] ${JSON.stringify(fetchKeys).slice(0, 200)}`);
      for (const k of fetchKeys) {
        const v = jsAuthData.fetchHeaders[k];
        if (/hif|pow/i.test(k)) {
          logInfo(`[Debug/JSFetch] ${k} = ${String(v).slice(0, 80)}...`);
        }
      }
    }

    // Extract hif from JS source (prefer fetch over XHR if both have data)
    const jsPreferred =
      Object.keys(jsAuthData.fetchHeaders).length > 1
        ? jsAuthData.fetchHeaders
        : jsAuthData.xhrHeaders;
    const jsHif = extractHifFromCaptured(jsPreferred);

    // Source 2: CDP network capture (wire-level + WASM resources)

    // Debug dump: show ALL header keys from ALL intercepted events
    const cdpAllKeys = new Set();
    for (const ev of networkEvents) {
      for (const k of Object.keys(ev.headers || {})) {
        cdpAllKeys.add(k.toLowerCase());
      }
    }
    logInfo(`[Auth] CDP all header keys (${cdpAllKeys.size}): ${[...cdpAllKeys].join(", ")}`);

    // Debug: dump first 5 intercepted event details
    for (let i = 0; i < Math.min(5, networkEvents.length); i++) {
      const ev = networkEvents[i];
      logInfo(
        `[Debug/CDP#${i}] ${ev.method} ${ev.url.slice(0, 60)} | keys=[${Object.keys(
          ev.headers || {}
        )
          .slice(0, 15)
          .join(", ")}]`
      );
    }

    const cdpPoW = extractPoWFromNetworkEvents();
    logInfo(
      `[Auth] CDP capture: wasm=${!!cdpPoW.wasmUrl}, hif_dliq=${!!cdpPoW.hif_dliq}, hif_leim=${!!cdpPoW.hif_leim}, events=${networkEvents.length}`
    );

    // Source 3: Find WASM URL from page resources (performance API + config search)
    const resourceWasm = await page.evaluate(() => {
      // Method 1: performance.getEntriesByType for .wasm
      try {
        const entries = performance.getEntriesByType("resource");
        for (const entry of entries) {
          if (/\.wasm/i.test(entry.name)) return entry.name;
        }
      } catch {}

      // Method 1b: Extended search — solve, pow, challenge patterns
      try {
        const entries = performance.getEntriesByType("resource");
        for (const entry of entries) {
          if (/solve|pow|challenge/i.test(entry.name)) return entry.name;
        }
      } catch {}

      // Method 2: Script tags with wasm/pow references
      try {
        for (const script of document.querySelectorAll("script[src]")) {
          if (/wasm.*solve|pow.*wasm/i.test(script.src.toLowerCase())) return script.src;
        }
      } catch {}

      // Method 3: Global window variables
      try {
        if (window.__DS_WASM_URL__) return window.__DS_WASM_URL__;
        if (window.deepseekWasmUrl) return window.deepseekWasmUrl;
      } catch {}

      // Method 4: Search server config in localStorage for wasm CDN path
      try {
        const serverConfig = localStorage.getItem("APMPLUS__cache__server__config__675113");
        if (serverConfig) {
          const parsed = JSON.parse(serverConfig);
          const str = JSON.stringify(parsed);
          const match = str.match(/https?:\/\/[^"]*wasm[^"]*/i);
          if (match) return match[0];
        }
      } catch {}

      // Method 5: Remote feature store may have wasm URL hints
      try {
        const featureStore = localStorage.getItem("__ds_remote_feature_store");
        if (featureStore) {
          const parsed = JSON.parse(featureStore);
          const str = JSON.stringify(parsed);
          const match = str.match(/https?:\/\/[^"]*wasm[^"]*/i);
          if (match) return match[0];
        }
      } catch {}

      // Method 6: Dump candidates as last resort
      try {
        const entries = performance.getEntriesByType("resource");
        const candidates = entries.filter((e) => /wasm|pow|solve|challenge/i.test(e.name));
        if (candidates.length > 0 && candidates.length < 20) return candidates[0].name;
      } catch {}

      return null;
    });

    // === Merge: priority order for each field ===
    const mergedPoW = {
      hif_dliq: jsHif.hif_dliq || cdpPoW.hif_dliq || "",
      hif_leim: jsHif.hif_leim || cdpPoW.hif_leim || "",
      wasmUrl: resourceWasm || cdpPoW.wasmUrl || "", // Resource-based is most reliable
    };

    logInfo(
      `[Auth] Merged PoW: wasm=${!!mergedPoW.wasmUrl}, hif_dliq=${!!mergedPoW.hif_dliq}, hif_leim=${!!mergedPoW.hif_leim}`
    );

    // Debug: if WASM still not found, dump ALL performance resources to help diagnose
    if (!mergedPoW.wasmUrl) {
      const allResources = await page.evaluate(() => {
        try {
          return performance.getEntriesByType("resource").map((e) => e.name);
        } catch (e) {
          return [];
        }
      });
      logWarn(`[Auth] WASM не найден! Всего ресурсов: ${allResources.length}`);
      // Show only resources that might be related to WASM/PoW
      const interesting = allResources.filter((r) => /wasm|pow|solve|challenge|worker|js/i.test(r));
      if (interesting.length > 0 && interesting.length < 50)
        logWarn(`[Auth] Подозрительные ресурсы: ${interesting.join(" | ")}`);
    }

    const extracted = await extractSessionToAccount(page, mergedPoW);

    if (!extracted) {
      logWarn("Не удалось извлечь cookie. Возможно, вход не прошёл.");
      return null;
    }

    console.log("\n------------------------------------------------------");
    console.log("✅ Сессия DeepSeek сохранена!");
    console.log("Нажмите ENTER для закрытия браузера...");
    console.log("------------------------------------------------------\n");
    await prompt("ENTER для продолжения...");

    return { success: true };
  } catch (e) {
    logError("Ошибка при добавлении аккаунта DeepSeek", e);
    return null;
  } finally {
    await shutdownAuthBrowser();
  }
}

export function hasValidSession() {
  try {
    const accounts = loadAccounts();

    // Find the most recent deepseek account that is not invalid and has cookies or token
    const dsAccount = accounts.find(
      (a) => a.id?.startsWith("deepseek_") && !a.invalid && Array.isArray(a.cookies)
    );
    if (dsAccount) {
      return true;
    }
  } catch {}

  logWarn("Сессия DeepSeek не найдена или невалидна.");
  return false;
}

export function getStoredCookies() {
  try {
    const accounts = loadAccounts();
    // Find the most recent deepseek account that is not invalid
    const dsAccount = accounts.find((a) => a.id?.startsWith("deepseek_") && !a.invalid);

    if (dsAccount && Array.isArray(dsAccount.cookies)) {
      return dsAccount.cookies;
    }
  } catch {}

  return [];
}

export function getStoredAuthData() {
  try {
    const accounts = loadAccounts();
    // Find the most recent deepseek account that is not invalid
    const dsAccount = accounts.find((a) => a.id?.startsWith("deepseek_") && !a.invalid);

    if (dsAccount && dsAccount.authData) {
      return dsAccount.authData;
    }
  } catch {}

  return {};
}

export function clearSession() {
  try {
    const accounts = loadAccounts();
    // Remove all deepseek accounts
    const filtered = accounts.filter((a) => !a.id?.startsWith("deepseek_"));

    if (filtered.length === accounts.length) {
      logWarn("Аккаунты DeepSeek не найдены для очистки.");
      return;
    }

    saveAccounts(filtered);
    logInfo("Сессия DeepSeek очищена");
  } catch {}
}
