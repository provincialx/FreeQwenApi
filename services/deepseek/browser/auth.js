import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import { logInfo, logError, logWarn } from "../../../shared/logger/index.js";
import { CHAT_PAGE_URL, PAGE_TIMEOUT, VIEWPORT_WIDTH, VIEWPORT_HEIGHT } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Unified accounts storage (Qwen-style)
const ACCOUNTS_PATH = path.resolve(__dirname, "..", "..", "session");
const DEEPSEEK_ACCOUNTS_FILE = path.join(ACCOUNTS_PATH, "deepseek_accounts.json");

puppeteer.use(StealthPlugin());

let globalBrowser = null;

// --- Storage Helpers (Qwen-style) ---

function loadAccounts() {
  if (!fs.existsSync(ACCOUNTS_PATH)) fs.mkdirSync(ACCOUNTS_PATH, { recursive: true });

  if (!fs.existsSync(DEEPSEEK_ACCOUNTS_FILE)) {
    return [];
  }

  try {
    const data = JSON.parse(fs.readFileSync(DEEPSEEK_ACCOUNTS_FILE, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch (err) {
    logError(`Ошибка чтения ${DEEPSEEK_ACCOUNTS_FILE}`, err);
    return [];
  }
}

function saveAccounts(accounts) {
  fs.writeFileSync(DEEPSEEK_ACCOUNTS_FILE, JSON.stringify(accounts, null, 2), "utf8");
}

export async function initAuthBrowser() {
  if (globalBrowser) return true;

  try {
    logInfo("Запуск браузера для авторизации DeepSeek...");

    const browser = await puppeteer.launch({
      headless: false, // Must be visible for login + CAPTCHA solving
      args: ["--no-sandbox"],
      defaultViewport: null,
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

async function extractSessionToAccount(page) {
  try {
    const cookies = await page.cookies(CHAT_PAGE_URL);
    if (!cookies.length) return false;

    // Extract localStorage and sessionStorage data (contains auth token, wasmUrl, headers)
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
          result.ss[key] = sessionStorage.getItem(key);
        }
      } catch {}

      return result;
    });

    // Deep recursive search across all nested objects/arrays for a target key
    function deepSearch(rootObj, targetKeys) {
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
          if (targetKeys.includes(key) && val !== undefined && val !== null) {
            found = val;
            logInfo(`[DeepSearch] Found '${key}' at: ${path ? path + "." : ""}${key}`);
            return;
          }
          // Recurse deeper
          iterate(val, path ? `${path}.${key}` : key);
        }
      }

      iterate(rootObj);
      return found;
    }

    // Extract important auth data from storage using robust search
    const lsData = rawData.ls;

    let token = "";
    let wasmUrl = "";
    let hif_dliq = "";
    let hif_leim = "";
    let x_client_version = "2.0.0"; // default fallback

    // Deep search for keys in nested objects
    token =
      lsData.token ||
      lsData.authorization ||
      lsData.auth_token ||
      lsData["authorization"] ||
      deepSearch(lsData, ["token", "auth_token", "Authorization"]) ||
      "";
    wasmUrl =
      lsData.wasmUrl ||
      lsData.wasm_url ||
      lsData["wasm-url"] ||
      deepSearch(lsData, ["wasmUrl", "wasm_url", "_c2c_wasm_url", "wasmURL", "WASM_URL"]) ||
      "";
    hif_dliq = lsData.hif_dliq || deepSearch(lsData, ["hif_dliq", "HIF_DLIQ"]) || "";
    hif_leim = lsData.hif_leim || deepSearch(lsData, ["hif_leim", "HIF_LEIM"]) || "";
    x_client_version =
      lsData["x-client-version"] ||
      deepSearch(lsData, ["client_version", "version", "VERSION", "_c2c_version"]) ||
      x_client_version;

    // Log all storage keys to help debugging if nothing is found
    const allKeys = Object.keys(rawData.ls).concat(Object.keys(rawData.ss));
    logInfo(`DeepSeek Storage Keys: ${allKeys.join(", ")}`);

    const authData = { token, wasmUrl, hif_dliq, hif_leim, x_client_version };

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

    saveAccounts(filtered);
    logInfo("Аккаунт DeepSeek сохранен в " + DEEPSEEK_ACCOUNTS_FILE);

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

    await page.goto(CHAT_PAGE_URL, { waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT });

    console.log("\n------------------------------------------------------");
    console.log("               ОЖИДАНИЕ ВХОДА В DEEPSEEK");
    console.log("------------------------------------------------------");
    console.log("1. Нажмите Login в правом верхнем углу.");
    console.log("2. Войдите через GitHub / Google в браузере.");
    console.log("3. После входа нажмите ENTER здесь.");
    console.log("------------------------------------------------------\n");

    const { prompt } = await import("../../../shared/utils/prompt.js");
    await prompt("Нажмите ENTER после успешной авторизации...");
    logInfo("Вход подтверждён, извлекаю сессию...");

    // Wait for page to stabilize after login redirect
    await new Promise((r) => setTimeout(r, 3000));

    const extracted = await extractSessionToAccount(page);
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
