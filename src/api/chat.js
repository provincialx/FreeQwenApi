// chat.js — Auth token state + model/key loaders + re-exports.
// Core Qwen API logic lives in qwenApi.js; page pool management in browser/pagePool.js.

import { getBrowserContext } from "../browser/browser.js";
import { saveAuthToken } from "../browser/session.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { logInfo, logError, logWarn } from "../logger/index.js";

// Page pool (browser layer) — re-exported for backward compatibility:
// fileUpload.js, browser.js, auth.js import pagePool here.
export {
  evaluateWithTimeout,
  evaluateInBrowser,
  EVALUATE_HEALTH_TIMEOUT,
} from "../browser/pagePool.js";
import {
  setAuthTokenGetter,
  pagePool,
  createPage,
  evaluateInBrowser,
} from "../browser/pagePool.js";
export { pagePool, createPage };

// Qwen API layer — re-exported for backward compatibility:
// routes.js, adminRoutes.js, responseBuilders.js import here.
export { sendMessage, createChatV2, testToken } from "./qwenApi.js";

export async function clearPagePool() {
  await pagePool.clear();
}

// ─── Auth token state (owned by this module) ──────────────────────────────

/** @type {string|null} */
let _authToken = null;
export let browserTokenRateLimited = false;

export function getAuthToken() {
  return _authToken;
}

export function setAuthToken(value) {
  _authToken = value;
}

export function getBrowserTokenRateLimited() {
  return browserTokenRateLimited;
}

export function setBrowserTokenRateLimited(value) {
  browserTokenRateLimited = value;
}

// Wire pagePool with a callback to check cached token before extracting on fresh pages
setAuthTokenGetter(() => _authToken);

// ─── Token extraction (browser layer) ──────────────────────────────────────

import { CHAT_PAGE_URL, PAGE_TIMEOUT, RETRY_DELAY, DEFAULT_MODEL } from "../config.js";
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function extractAuthToken(context, forceRefresh = false) {
  if (_authToken && !forceRefresh) return _authToken;

  try {
    const page = await createPage(context);
    const shouldClosePage = page !== context;
    try {
      await page.goto(CHAT_PAGE_URL, {
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT,
      });
      await delay(RETRY_DELAY);

      const newToken = await evaluateInBrowser(page, () => localStorage.getItem("token"), [], 10_000);
      if (shouldClosePage) await page.close();

      if (newToken) {
        _authToken = newToken;
        logInfo("Токен авторизации успешно извлечен");
        saveAuthToken(_authToken);
        return _authToken;
      }
      logError("Токен авторизации не найден в браузере");
      return null;
    } catch (error) {
      if (shouldClosePage) await page.close().catch(() => {});
      throw error;
    }
  } catch (error) {
    logError("Ошибка при извлечении токена авторизации", error);
    return null;
  }
}

// ─── Models & keys from files ──────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const MODELS_FILE = path.join(__dirname, "..", "AvailableModels.txt");
const AUTH_KEYS_FILE = path.join(__dirname, "..", "Authorization.txt");

export let availableModels = null;
let authKeys = null;

export function getAvailableModelsFromFile() {
  try {
    if (!fs.existsSync(MODELS_FILE)) {
      logError(`Файл с моделями не найден: ${MODELS_FILE}`);
      return [DEFAULT_MODEL];
    }
    const models = fs
      .readFileSync(MODELS_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));

    logInfo("===== ДОСТУПНЫЕ МОДЕЛИ =====");
    if (models.length <= 3) {
      models.forEach((m) => logInfo(`- ${m}`));
    } else {
      models.slice(0, 3).forEach((m) => logInfo(`- ${m}`));
      logInfo(`... и ещё ${models.length - 3} моделей`);
    }
    logInfo("============================");
    return models;
  } catch (error) {
    logError("Ошибка при чтении файла с моделями", error);
    return [DEFAULT_MODEL];
  }
}

function getAuthKeysFromFile() {
  try {
    if (!fs.existsSync(AUTH_KEYS_FILE)) {
      const template = `# Файл API-ключей для прокси\n# --------------------------------------------\n# В этом файле перечислены токены, которые\n# прокси будет считать «действительными».\n# Один ключ — одна строка без пробелов.\n#\n# 1) Хотите ОТКЛЮЧИТЬ авторизацию целиком?\n#    Оставьте файл пустым — сервер перестанет\n#    проверять заголовок Authorization.\n#\n# 2) Хотите разрешить доступ нескольким людям?\n#    Впишите каждый ключ в отдельной строке:\n#      d35ab3e1-a6f9-4d...\n#      f2b1cd9c-1b2e-4a...\n#\n# Пустые строки и строки, начинающиеся с «#»,\n# игнорируются.`;
      try {
        fs.writeFileSync(AUTH_KEYS_FILE, template, {
          encoding: "utf8",
          flag: "wx",
        });
        logInfo(`Создан шаблон файла ключей: ${AUTH_KEYS_FILE}`);
      } catch (e) {
        logError("Не удалось создать шаблон Authorization.txt", e);
      }
      return [];
    }
    return fs
      .readFileSync(AUTH_KEYS_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
  } catch (error) {
    logError("Ошибка при чтении файла с ключами авторизации", error);
    return [];
  }
}

export function isValidModel(modelName) {
  if (!availableModels) availableModels = getAvailableModelsFromFile();
  return availableModels.includes(modelName);
}

export function getAllModels() {
  if (!availableModels) availableModels = getAvailableModelsFromFile();
  return {
    models: availableModels.map((model) => ({
      id: model,
      name: model,
      description: `Модель ${model}`,
    })),
  };
}

export function getApiKeys() {
  if (!authKeys) authKeys = getAuthKeysFromFile();
  return authKeys;
}
