import puppeteer from "puppeteer-extra";
import { safeClosePage } from "./pagePool.js";
import StealthPlugin from "puppeteer-extra-plugin-stealth";
import { saveSession, saveAuthToken } from "./session.js";
import { startManualAuthentication } from "./auth.js";
import { pagePool } from "./pagePool.js";
import { getAuthToken, setAuthToken as chatSetToken } from "../api/chat.js";
import fs from "fs";
import path from "path";
import { logInfo, logError, logWarn, logDebug } from "../../../shared/logger/index.js";
import {
  CHAT_PAGE_URL,
  NAVIGATION_TIMEOUT,
  RETRY_DELAY,
  VIEWPORT_WIDTH,
  VIEWPORT_HEIGHT,
  USER_AGENT,
  SESSION_DIR,
  ACCOUNTS_DIR,
} from "../config.js";

puppeteer.use(StealthPlugin());

let browserInstance = null;
let browserContext = null;
export let isAuthenticated = false;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function initBrowser(visibleMode = true, skipManualRestart = false) {
  if (browserInstance) return true;

  logInfo("Инициализация браузера с Puppeteer Stealth...");
  try {
    const chromeArgs = [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-blink-features=AutomationControlled",
      "--disable-dev-shm-usage",
      "--disable-web-security",
      "--disable-features=IsolateOrigins,site-per-process",
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      "--start-maximized",
      "--disable-infobars",
      "--no-first-run",
      "--no-default-browser-check",
      "--ignore-certificate-errors",
      "--ignore-certificate-errors-spki-list",
    ];

    browserInstance = await puppeteer.launch({
      headless: !visibleMode,
      slowMo: visibleMode ? 30 : 0,
      executablePath: process.env.CHROME_PATH || undefined,
      // Protocol timeout MUST exceed max Qwen generation time. Aliyun WAF forces us
      // to run fetch() INSIDE browser context, which locks the CDP channel during long SSE.
      // Default: max(env, 15min). If this fires during a generation, it means the model hung.
      protocolTimeout:
        Number(process.env.PROTOCOL_TIMEOUT) ||
        (Number(process.env.REQUEST_TIMEOUT_MINUTES) || 3 + 5) * 60_000 * 2,
      args: chromeArgs,
      defaultViewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
      ignoreHTTPSErrors: true,
      dumpio: false,
    });

    const pages = await browserInstance.pages();
    const page = pages.length > 0 ? pages[0] : await browserInstance.newPage();

    await page.setUserAgent(USER_AGENT);
    await page.setViewport({
      width: VIEWPORT_WIDTH,
      height: VIEWPORT_HEIGHT,
      deviceScaleFactor: 1,
    });
    await page.setExtraHTTPHeaders({
      "Accept-Language": "en-US,en;q=0.9",
      "Accept-Encoding": "gzip, deflate, br",
      Accept:
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
      Connection: "keep-alive",
      "Upgrade-Insecure-Requests": "1",
    });

    // Bypass CSP on main page — XHR inside evaluate() blocked by Qwen Studio CSP.
    // Pool pages also get this in pagePool.getPage(), but main context must have it too.
    try {
      await page.setBypassCSP(true);
    } catch {
      /* CSP bypass is best-effort */
    }

    await page.evaluateOnNewDocument(() => {
      // ─── CRITICAL: Remove webdriver flag ────────────────────────────────────
      // Aliyun WAF actively checks navigator.webdriver. Puppeteer's default is `true`.
      // Override at the prototype level so it stays hidden even after page reloads.
      Object.defineProperty(navigator, "webdriver", { get: () => false });

      // ─── Chrome runtime objects ─────────────────────────────────────────────
      // Real Chrome has `chrome` object with runtime, app, etc.
      // WAF may check for these as a bot-detection signal.
      if (!window.chrome) {
        window.chrome = {
          runtime: {},
          app: {},
          csi: () => {},
          loadTimes: () => {},
        };
      }

      // ─── Navigator overrides ────────────────────────────────────────────────
      Object.defineProperty(navigator, "platform", { get: () => "Win32" });
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => 8 });
      Object.defineProperty(navigator, "deviceMemory", { get: () => 8 });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      // Set language to match Accept-Language header
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
      Object.defineProperty(navigator, "connection", {
        get: () => ({
          effectiveType: "4g",
          rtt: 50,
          downlink: 10,
          saveData: false,
        }),
      });
      if (!navigator.getBattery) {
        navigator.getBattery = () =>
          Promise.resolve({
            charging: true,
            chargingTime: 0,
            dischargingTime: Infinity,
            level: 1,
          });
      }

      // ─── Permission query override ──────────────────────────────────────────
      // WAF can check permissions.query to detect headless Chrome.
      const originalQuery = navigator.permissions?.query.bind(navigator.permissions);
      if (navigator.permissions && originalQuery) {
        navigator.permissions.query = (desc) => {
          if (desc.name === "notifications" || desc.name === "clipboard-read") {
            return Promise.resolve({ state: "prompt" });
          }
          return originalQuery(desc);
        };
      }

      // ─── Event listener randomization (anti-fingerprinting) ─────────────────
      const originalAddEventListener = EventTarget.prototype.addEventListener;
      EventTarget.prototype.addEventListener = function (type, listener, options) {
        if (type === "mousemove" || type === "mousedown" || type === "mouseup") {
          const wrappedListener = function (event) {
            setTimeout(() => listener.call(this, event), Math.random() * 3);
          };
          return originalAddEventListener.call(this, type, wrappedListener, options);
        }
        return originalAddEventListener.call(this, type, listener, options);
      };

      // ─── Canvas fingerprint noise ───────────────────────────────────────────
      const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function (type) {
        const context = this.getContext("2d");
        if (context) {
          const imageData = context.getImageData(0, 0, this.width, this.height);
          const data = imageData.data;
          for (let i = 0; i < data.length; i += 4) {
            const noise = Math.floor(Math.random() * 5) - 2;
            data[i] = Math.max(0, Math.min(255, data[i] + noise));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + noise));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + noise));
          }
          context.putImageData(imageData, 0, 0);
        }
        return originalToDataURL.apply(this, arguments);
      };
    });

    browserContext = page;
    logInfo("Браузер инициализирован с максимальной защитой от обнаружения");

    // Auto-restore session on headless init — pool pages need cookies for fetch() inside evaluate.
    if (!visibleMode) {
      const { loadAuthToken, hasSession } = await import("./session.js");
      const savedToken = loadAuthToken();

      try {
        if (savedToken && !getAuthToken()) {
          logInfo("Восстановлен сохраненный токен авторизации при запуске");
          chatSetToken(savedToken);
          saveAuthToken(savedToken);
        }

        // Restore cookies from the most recent account session file.
        const accountsDir = path.join(process.cwd(), SESSION_DIR, ACCOUNTS_DIR);
        if (fs.existsSync(accountsDir) && hasSession()) {
          try {
            const accDirs = fs.readdirSync(accountsDir).filter((d) => d.startsWith("acc_"));
            let restoredCookies = false;
            for (const dir of accDirs.sort().reverse()) {
              // newest first
              const cookieFile = path.join(accountsDir, dir, "cookies.json");
              if (fs.existsSync(cookieFile)) {
                try {
                  const cookies = JSON.parse(fs.readFileSync(cookieFile, "utf8"));
                  await page.setCookie(...cookies);
                  logInfo(`Восстановлено ${cookies.length} cookies из сессии ${dir}`);
                  restoredCookies = true;
                  break;
                } catch {
                  /* skip corrupted file */
                }
              }
            }
            if (!restoredCookies) {
              logWarn("Файлы cookies найдены но не удалось восстановить");
            }
          } catch (e) {
            logWarn(`Ошибка при чтении директории аккаунтов: ${e.message}`);
          }
        }

        // Navigate to Qwen so cookies/localStorage take effect for subsequent pool pages.
        await page.goto(CHAT_PAGE_URL, {
          waitUntil: "domcontentloaded",
          timeout: NAVIGATION_TIMEOUT,
        });
        await delay(RETRY_DELAY);

        const existing = await page.evaluate(() => localStorage.getItem("token"));
        if (savedToken && existing !== savedToken) {
          logInfo("Токен синхронизирован в localStorage fresh страницы");
          await page.evaluate((t) => localStorage.setItem("token", t), savedToken);
        }
      } catch (e) {
        logWarn(`Не удалось восстановить сессию при запуске: ${e.message}`);
      }
    }

    // When CAPTCHA resolver calls initBrowser(true, true), it handles auth itself.
    // skipManualRestart=true means: "don't run manual auth flow". We only need visible browser.
    if (visibleMode && !skipManualRestart) {
      await startManualAuthenticationPuppeteer(page);
    }
    // loadSessionPuppeteer removed — was dead code (always returned false)

    return true;
  } catch (error) {
    logError("Ошибка при инициализации браузера", error);
    return false;
  }
}

async function saveSessionPuppeteer(page) {
  try {
    const cookies = await page.cookies();
    const sessionDir = path.join(process.cwd(), SESSION_DIR, ACCOUNTS_DIR);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    const accountId = `acc_${Date.now()}`;
    const accountDir = path.join(sessionDir, accountId);
    if (!fs.existsSync(accountDir)) fs.mkdirSync(accountDir, { recursive: true });

    fs.writeFileSync(path.join(accountDir, "cookies.json"), JSON.stringify(cookies, null, 2));
    logInfo(`Cookies сохранены для аккаунта ${accountId}`);
    return accountId;
  } catch (error) {
    logError("Ошибка при сохранении сессии", error);
    return null;
  }
}

async function startManualAuthenticationPuppeteer(page, skipManualRestart) {
  try {
    logInfo("Открытие страницы для ручной авторизации...");
    // Use domcontentloaded instead of networkidle2 — Qwen Studio never truly goes idle
    // (constant analytics/telemetry requests) which causes 60s timeout.
    await page.goto(CHAT_PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });
    await delay(5000);

    console.log("------------------------------------------------------");
    console.log("               НЕОБХОДИМА АВТОРИЗАЦИЯ");
    console.log("------------------------------------------------------");
    console.log("Пожалуйста, выполните следующие действия:");
    console.log("1. Войдите в систему в открытом браузере");
    console.log("2. ВАЖНО: Двигайте мышью естественно, не спешите");
    console.log("3. Если появится слайдер капчи - решите её медленно");
    console.log("4. Дождитесь полной загрузки главной страницы");
    console.log("5. После успешной авторизации нажмите ENTER в консоли");
    console.log("------------------------------------------------------");
    console.log("После успешной авторизации нажмите ENTER для продолжения...");

    await new Promise((resolve) => {
      if (process.stdin.isTTY) process.stdin.setRawMode(false);
      process.stdin.resume();
      process.stdin.setEncoding("utf8");
      const onData = (key) => {
        if (key === "\n" || key === "\r" || key.charCodeAt(0) === 13) {
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          logInfo("Получено подтверждение, продолжаем...");
          resolve();
        }
      };
      process.stdin.on("data", onData);
    });

    const cookies = await page.cookies();
    logInfo(`Сохранено ${cookies.length} cookies`);

    const token = await page.evaluate(
      () =>
        localStorage.getItem("token") ||
        localStorage.getItem("auth_token") ||
        localStorage.getItem("access_token") ||
        sessionStorage.getItem("token") ||
        sessionStorage.getItem("auth_token") ||
        null
    );

    if (token) {
      logInfo("Токен найден и будет сохранен");
      saveAuthToken(token);
    } else {
      logWarn("Токен не найден в localStorage/sessionStorage");
      logInfo("Попытка извлечь токен из cookies...");
      const tokenCookie = cookies.find(
        (c) => c.name.toLowerCase().includes("token") || c.name.toLowerCase().includes("auth")
      );
      if (tokenCookie) {
        logInfo(`Токен найден в cookie: ${tokenCookie.name}`);
        saveAuthToken(tokenCookie.value);
      }
    }

    const accountId = await saveSessionPuppeteer(page);
    if (accountId) logInfo(`Сессия сохранена с ID: ${accountId}`);

    setAuthenticationStatus(true);
    logInfo("Авторизация завершена успешно");

    if (!skipManualRestart) await restartBrowserInHeadlessMode();
  } catch (error) {
    logError("Ошибка при ручной авторизации", error);
    throw error;
  }
}

export async function restartBrowserInHeadlessMode() {
  logInfo("Перезапуск браузера в фоновом режиме...");
  const token = getAuthToken();
  if (token) {
    logDebug("Сохранение токена...");
    saveAuthToken(token);
    await delay(1000);
  }

  // Save cookies BEFORE shutdown so we can restore after fresh browser launch.
  // Without this, headless restart loses session → fetch() fails in pool pages.
  const savedCookies = await saveBrowserCookies();
  logDebug(`Сохранено ${savedCookies?.length || 0} cookies перед перезапуском`);

  await shutdownBrowser();
  await delay(RETRY_DELAY);

  // Restore saved auth-token to the new browser context first.
  if (token) chatSetToken(token);
  const success = await initBrowser(false, true); // skipManualAuth — no interactive login needed
  if (!success) return;

  // Restore cookies and validate session on base page.
  const basePage = getBrowserContext();
  if (basePage && savedCookies?.length > 0) {
    await restoreBrowserCookies(basePage, savedCookies);
    // Navigate to Qwen so cookies take effect + localStorage populated
    await basePage.goto(CHAT_PAGE_URL, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT,
    });
    await delay(RETRY_DELAY);
  }

  logInfo(success ? "Браузер перезапущен в фоновом режиме" : "Ошибка при перезапуске браузера");
}

export function getBrowserInstance() {
  return browserInstance;
}

/**
 * Saves cookies from all pages in the current browser session.
 * Returns cookie array or null if browser not initialized.
 */
export async function saveBrowserCookies() {
  try {
    const baseCtx = getBrowserContext();
    if (!baseCtx) return null;
    // Get cookies from current page (they apply to the whole context)
    return await baseCtx.cookies(CHAT_PAGE_URL);
  } catch {
    return null;
  }
}

/**
 * Restores cookies to a browser context.
 */
export async function restoreBrowserCookies(page, cookies) {
  if (!cookies || !page) return false;
  try {
    await page.setCookie(...cookies);
    logInfo(`Восстановлено ${cookies.length} cookies`);
    return true;
  } catch (e) {
    logWarn(`Не удалось восстановить cookies: ${e.message}`);
    return false;
  }
}

export async function shutdownBrowser() {
  try {
    try {
      await pagePool.clear();
    } catch (e) {
      logError("Ошибка при очистке пула страниц", e);
    }
    if (browserInstance) {
      try {
        const pages = await browserInstance.pages();
        for (const page of pages) await safeClosePage(page);
        await browserInstance.close();
      } catch (e) {
        logError("Ошибка при закрытии браузера", e);
      }
    }
    browserContext = null;
    browserInstance = null;
    logInfo("Браузер закрыт");
  } catch (error) {
    logError("Ошибка при завершении работы браузера", error);
  }
}

export function getBrowserContext() {
  return browserContext;
}
export function setAuthenticationStatus(status) {
  isAuthenticated = status;
}
export function getAuthenticationStatus() {
  return isAuthenticated;
}

// ─── Memory Guard: safe restart for active requests ─────────────────────────

let _isRestarting = false;

/**
 * Returns true if a browser restart is currently in progress.
 * Callers should wait or retry rather than starting a second restart.
 */
export function isBrowserRestarting() {
  return _isRestarting;
}

/**
 * Restarts Chromium when RSS exceeds threshold.
 * Safe to call from within an active getPage() — the current request
 * will fail gracefully and the caller should retry.
 *
 * Flow: save token → clear pool → shutdown → re-init headless.
 * Uses a lock to prevent concurrent restarts.
 */
export async function restartBrowserIfLeaking(rssMb) {
  if (_isRestarting) return false;
  _isRestarting = true;

  try {
    logWarn(`🔥 Memory guard: RSS ${rssMb.toFixed(0)} MB — restarting Chromium...`);
    const token = getAuthToken();
    if (token) {
      saveAuthToken(token);
      await delay(500);
    }
    await shutdownBrowser();
    await delay(RETRY_DELAY);
    const success = await initBrowser(false, true);
    if (success) {
      logInfo(`✅ Chromium restarted successfully (was ${rssMb.toFixed(0)} MB)`);
    } else {
      logError("❌ Chromium restart failed after memory guard trigger");
    }
    return success;
  } catch (error) {
    logError("Ошибка при аварийном перезапуске браузера", error);
    return false;
  } finally {
    _isRestarting = false;
  }
}
