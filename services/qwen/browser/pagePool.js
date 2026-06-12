import { getBrowserContext, isBrowserRestarting, restartBrowserIfLeaking } from "./browser.js";
import { saveAuthToken } from "./session.js";
import { logWarn, logDebug, logInfo, logError } from "../../../shared/logger/index.js";
import {
  CHAT_PAGE_URL,
  PAGE_TIMEOUT,
  RETRY_DELAY,
  PAGE_POOL_SIZE,
  MAX_ACTIVE_PAGES,
  PAGE_IDLE_TTL_MS,
  PAGE_GC_INTERVAL_MS,
  BROWSER_RESTART_RSS_MB,
  MEMORY_CHECK_INTERVAL,
} from "../config.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Safely closes a Puppeteer page, suppressing "Target closed" errors.
 * These occur when the CDP target is already gone (browser shutdown, crashed tab).
 */
export async function safeClosePage(page) {
  try {
    if (page && !page.isClosed()) {
      await page.close();
    }
  } catch (e) {
    const msg = e?.message || "";
    if (/target closed|session closed|protocol error/i.test(msg)) return;
    logDebug(`safeClosePage: suppressed error: ${msg.substring(0, 80)}`);
  }
}

// ─── Page creation helper ────────────────────────────────────────────────────

/**
 * Creates a Puppeteer page. Handles both BrowserContext and Page inputs:
 * - If context has newPage() → calls it directly
 * - If passed a Page that supports browser() → creates new tab from same browser to avoid races
 * - Otherwise returns the Page itself (with closure safety check)
 */
export async function createPage(context) {
  if (context && typeof context.newPage === "function") {
    return await context.newPage();
  }

  if (context && typeof context.goto === "function") {
    // If passed a Puppeteer Page, don't reuse it as working page:
    // create a separate tab from the same browser to avoid races
    // and accidental closure of the base page.
    if (typeof context.browser === "function") {
      try {
        const browser = context.browser();
        if (browser && typeof browser.newPage === "function") {
          return await browser.newPage();
        }
      } catch (error) {
        logWarn(`Не удалось создать новую страницу из текущего контекста: ${error.message}`);
      }
    }

    if (typeof context.isClosed === "function" && context.isClosed()) {
      throw new Error("Базовая страница браузера закрыта");
    }

    return context;
  }

  throw new Error("Неверный контекст: не страница Puppeteer, не контекст Playwright");
}

// ─── Evaluate with timeout helper ────────────────────────────────────────────
// page.evaluate без таймаута блокирует пул страниц бесконечно.
// Promise.race выбрасывает Error если CDP-соединение деградировало.
// fast sync check
export const EVALUATE_HEALTH_TIMEOUT = Number(process.env.EVALUATE_HEALTH_TIMEOUT) || 5_000;
// slow async API calls can take minutes — give plenty of room (default: REQUEST_TIMEOUT * 2)
const REQ_TIMEOUT_MIN = Number(process.env.REQUEST_TIMEOUT_MINUTES) || 5; // default 5 min
const longTimeout = Math.max(REQ_TIMEOUT_MIN * 60_000 + 30_000, 180_000);

export async function evaluateWithTimeout(page, fn, timeoutMs = EVALUATE_HEALTH_TIMEOUT) {
  return Promise.race([
    page.evaluate(fn),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`page.evaluate timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

export async function evaluateInBrowser(page, fn, args = [], timeoutMs = longTimeout) {
  return Promise.race([
    page.evaluate(fn, ...args),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`page.evaluate timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);
}

// ─── Page Pool ────────────────────────────────────────────────────────────────

/**
 * Manages a pool of Chromium pages. Health-checks on checkout via evaluateWithTimeout.
 * Reuses pages to avoid expensive browser tab creation/teardown overhead.
 *
 * Memory leak mitigation:
 * - Hard limit on total active pages (MAX_ACTIVE_PAGES) prevents unbounded growth.
 * - Periodic GC closes idle pages older than PAGE_IDLE_TTL_MS.
 * - Each pooled page tracks lastUsed timestamp for TTL-based eviction.
 * - GC timer is started lazily on first getPage()/releasePage() to avoid
 *   keeping Node.js alive during unit tests that import this module transitively.
 */
let _getPageCallCount = 0;

/** Get cookies from the base auth page. Returns empty array if no context available. */
async function getBaseContextCookies() {
  const baseCtx = getBrowserContext();
  try {
    return (await baseCtx.cookies(CHAT_PAGE_URL)) || [];
  } catch {
    return [];
  }
}

const pagePool = {
  pages: [], // { page, lastUsed } entries
  maxSize: PAGE_POOL_SIZE,
  activeCount: 0, // pages currently checked out (not in pool)
  _gcTimer: null,

  /**
   * Ensures GC timer is running. Called lazily from getPage/releasePage.
   */
  _ensureGC() {
    if (!this._gcTimer) this.startGC();
  },

  /**
   * Acquires a working page from the pool or creates a new one.
   * Health-checks pooled pages; drops dead ones and creates fresh tabs on failure.
   * Retry goto up to 3 times with exponential backoff on network errors.
   * Blocks if MAX_ACTIVE_PAGES reached until a page is returned.
   */
  async getPage(context) {
    this._ensureGC();

    // ─── Memory Guard ──────────────────────────────────────────────────────
    // Periodically check Node.js RSS. If Chromium has leaked past threshold,
    // trigger a background restart. Current request will fail and caller retries.
    if (BROWSER_RESTART_RSS_MB > 0) {
      _getPageCallCount++;
      if (_getPageCallCount % MEMORY_CHECK_INTERVAL === 0 && !isBrowserRestarting()) {
        const rssMb = process.memoryUsage().rss / (1024 * 1024);
        if (rssMb > BROWSER_RESTART_RSS_MB) {
          logWarn(
            `🔥 Memory guard: RSS ${rssMb.toFixed(0)} MB > ${BROWSER_RESTART_RSS_MB} MB — triggering restart`
          );
          // Fire-and-forget: restart runs async, current getPage throws below
          restartBrowserIfLeaking(rssMb).catch((e) => logError("Memory guard restart failed", e));
          throw new Error(
            `Chromium restarting due to high memory (${rssMb.toFixed(0)} MB). Retry in a few seconds.`
          );
        }
      }
    }

    // Enforce hard limit on active pages — fail after 10s instead of blocking forever
    const waitDeadline = Date.now() + 10_000;
    while (this.activeCount >= MAX_ACTIVE_PAGES && Date.now() < waitDeadline) {
      logWarn(`🔒 Active page limit reached (${MAX_ACTIVE_PAGES}), waiting for page release...`);
      await delay(500);
    }

    if (this.activeCount >= MAX_ACTIVE_PAGES) {
      throw new Error(
        `Page pool exhausted: ${MAX_ACTIVE_PAGES} pages active, timeout after 10s. Increase MAX_ACTIVE_PAGES env var.`
      );
    }

    const baseContext = getBrowserContext();
    while (this.pages.length > 0) {
      const entry = this.pages.pop();
      const page = entry.page;
      try {
        if (page === baseContext) {
          logWarn("Базовая страница не должна быть в пуле, пропускаем");
          continue;
        }
        if (page.isClosed()) {
          logWarn("Страница из пула закрыта, пропускаем");
          continue;
        }
        // Limit health-check timeout: if CDP connection degraded,
        // page dies quickly instead of hanging forever.
        await evaluateWithTimeout(page, () => document.readyState);
        this.activeCount++;
        return page;
      } catch (e) {
        logWarn(`Страница из пула протухла (${e.message?.substring(0, 60)}), создаём новую`);
        if (page !== baseContext) {
          try {
            await safeClosePage(page);
          } catch {
            /* already dead */
          }
        }
      }
    }

    const maxGotoAttempts = 3;
    let lastError;
    for (let attempt = 1; attempt <= maxGotoAttempts; attempt++) {
      try {
        const newPage = await createPage(context);

        // Bypass CSP — Qwen Studio blocks XMLHttpRequest/fetch via Content-Security-Policy headers.
        // Without this, all XHR in evaluate() throws "XHR network error" even with valid auth.
        try {
          await newPage.setBypassCSP(true);
        } catch {
          /* ignore if page already closed */
        }

        // Ensure fresh page inherits browser-level cookies from base context.
        // New pages created via browser.newPage() SHOULD inherit, but race conditions or restarts can leave them empty.
        const baseCookies = await getBaseContextCookies();
        if (baseCookies?.length > 0) {
          try {
            const newPageCookies = await newPage.cookies(CHAT_PAGE_URL);
            if (newPageCookies.length === 0) {
              logDebug(
                `Fresh page missing cookies, restoring ${baseCookies.length} from base context`
              );
              await newPage.setCookie(...baseCookies);
            }
          } catch {
            /* ignore — cookie operations can fail on fresh pages */
          }
        }

        await newPage.goto(CHAT_PAGE_URL, {
          waitUntil: "domcontentloaded",
          timeout: PAGE_TIMEOUT,
        });

        // Extract token on fresh page if not yet cached.
        // After headless restart, pages may be clean (no cookies/localStorage) even though we have tokens.
        const currentToken = getAuthToken();
        let tokenFromBrowser = null;
        try {
          tokenFromBrowser = await newPage.evaluate(() => localStorage.getItem("token"));
        } catch (e) {
          /* ignore */
        }

        if (!currentToken && tokenFromBrowser) {
          saveAuthToken(tokenFromBrowser);
          logDebug("Токен авторизации получен из новой страницы в пуле");
        } else if (tokenFromBrowser !== currentToken) {
          // Token mismatch or one side is empty — sync them.
          const tokenToUse = currentToken || tokenFromBrowser;
          if (!currentToken && tokenToUse) saveAuthToken(tokenToUse);

          try {
            await newPage.evaluate((t) => localStorage.setItem("token", t), tokenToUse);
            logDebug(
              `Токен синхронизирован в странице: ${String(tokenToUse || "").slice(0, 20)}...`
            );

            // After writing JWT to localStorage, reload so Qwen sets session cookies based on it.
            await newPage.reload({ waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });
          } catch (e) {
            logWarn(`Не удалось записать токен в страницу: ${e.message}`);
          }
        }

        this.activeCount++;
        return newPage;
      } catch (e) {
        lastError = e;
        logWarn(
          `goto CHAT_PAGE_URL попытка ${attempt}/${maxGotoAttempts} не удалась: ${e.message?.substring(0, 80)}`
        );
        if (attempt < maxGotoAttempts) {
          await delay(RETRY_DELAY * attempt); // exponential backoff
        }
      }
    }
    throw lastError;
  },

  /**
   * Returns a page to the pool for reuse. Skips closed pages and base context.
   * Tracks lastUsed timestamp for TTL-based GC.
   */
  releasePage(page) {
    this._ensureGC();
    this.activeCount = Math.max(0, this.activeCount - 1);

    try {
      if (page.isClosed()) return;
    } catch {
      return;
    }

    const baseContext = getBrowserContext();
    if (page === baseContext) {
      // Keep base page separate from pool.
      return;
    }

    if (this.pages.length < this.maxSize) {
      this.pages.push({ page, lastUsed: Date.now() });
    } else {
      safeClosePage(page);
    }
  },

  /**
   * Closes all pooled pages and clears the array. Used during auth restart / shutdown.
   */
  async clear() {
    const baseContext = getBrowserContext();
    for (const entry of this.pages) {
      if (entry.page === baseContext) continue;
      try {
        await safeClosePage(entry.page);
      } catch {
        /* ignore close errors during cleanup */
      }
    }
    this.pages = [];
    this.activeCount = 0;
  },

  /**
   * Periodic GC: closes pooled pages idle longer than PAGE_IDLE_TTL_MS.
   * Runs every PAGE_GC_INTERVAL_MS.
   */
  _runGC() {
    const now = Date.now();
    const baseContext = getBrowserContext();
    const before = this.pages.length;
    const kept = [];

    for (const entry of this.pages) {
      const idle = now - entry.lastUsed;
      if (idle > PAGE_IDLE_TTL_MS) {
        if (entry.page !== baseContext) {
          safeClosePage(entry.page);
          logDebug(`🗑 GC: closed idle page (idle ${Math.round(idle / 1000)}s)`);
        }
      } else {
        kept.push(entry);
      }
    }

    this.pages = kept;
    const evicted = before - kept.length;
    if (evicted > 0) {
      logInfo(`🗑 Page GC: evicted ${evicted} idle pages, ${kept.length} remaining in pool`);
    }
  },

  /**
   * Starts the periodic GC timer if not already running.
   */
  startGC() {
    if (this._gcTimer) return;
    this._gcTimer = setInterval(() => this._runGC(), PAGE_GC_INTERVAL_MS);
    // Allow Node to exit even if timer is still running
    if (this._gcTimer.unref) this._gcTimer.unref();
    logDebug(
      `🔄 Page GC started (interval ${PAGE_GC_INTERVAL_MS / 1000}s, TTL ${PAGE_IDLE_TTL_MS / 1000}s)`
    );
  },

  /**
   * Stops the periodic GC timer. Called during shutdown.
   */
  stopGC() {
    if (this._gcTimer) {
      clearInterval(this._gcTimer);
      this._gcTimer = null;
    }
  },

  /**
   * Returns pool stats for debugging/monitoring.
   */
  getStats() {
    return {
      size: this.pages.length,
      maxSize: this.maxSize,
      activeCount: this.activeCount,
      maxActivePages: MAX_ACTIVE_PAGES,
      idleTtlMs: PAGE_IDLE_TTL_MS,
      gcIntervalMs: PAGE_GC_INTERVAL_MS,
    };
  },
};

// GC is started lazily on first getPage() or releasePage() call.
// This prevents the setInterval from keeping Node.js alive during unit tests
// that import modules which transitively import pagePool.

export { pagePool };

/** @deprecated Use `getAuthToken()` from chat.js instead. Only for getPage token hint. */
let _authTokenGetter = () => null;
export function setAuthTokenGetter(fn) {
  _authTokenGetter = fn;
}
function getAuthToken() {
  return typeof _authTokenGetter === "function" ? _authTokenGetter() : null;
}
