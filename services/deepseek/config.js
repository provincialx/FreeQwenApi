// services/deepseek/config.js — DeepSeek-specific configuration
function toBoolean(value) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

const BASE_URL = process.env.DEEPSEEK_BASE_URL || "https://chat.deepseek.com";

// ─── API URLs ────────────────────────────────────────────────────────
export const CHAT_API_URL =
  process.env.DEEPSEEK_CHAT_API_URL || `${BASE_URL}/api/v0/chat/completion`;
export const CHAT_PAGE_URL = process.env.DEEPSEEK_CHAT_PAGE_URL || `${BASE_URL}`;

// ─── Таймауты (мс) ──────────────────────────────────────────────────
export const PAGE_TIMEOUT = Number(process.env.PAGE_TIMEOUT) || 60_000;
export const RETRY_DELAY = Number(process.env.RETRY_DELAY) || 2_000;

// ─── Пути сессий (относительно сервиса) ─────────────────────────────
export const SESSION_DIR = process.env.SESSION_DIR || "session";
export const ACCOUNTS_DIR = "accounts";

// ─── Модели DeepSeek Web ────────────────────────────────────────────
// model_type: default (Быстрый/V4-Flash) | expert (Эксперт/V4-Pro)
export const DEEPSEEK_MODELS = {
  // Обычный chat (V4 Flash — Быстрый режим)
  "deepseek-v3": { model_type: "default", thinking_enabled: false, search_enabled: false },
  "deepseek-chat": { model_type: "default", thinking_enabled: false, search_enabled: false },
  "deepseek-default": { model_type: "default", thinking_enabled: false, search_enabled: false },

  // Thinking / Reasoning режимы
  "deepseek-r1": { model_type: "default", thinking_enabled: true, search_enabled: false },
  "deepseek-reasoner": { model_type: "default", thinking_enabled: true, search_enabled: false },

  // Экспертные модели (V4 Pro — Expert режим)
  "deepseek-expert": { model_type: "expert", thinking_enabled: false, search_enabled: false },
  "deepseek-v4-pro": { model_type: "expert", thinking_enabled: true, search_enabled: false },
};

// ─── Браузер (для аутентификации через браузер) ──────────────────────
export const VIEWPORT_WIDTH = Number(process.env.VIEWPORT_WIDTH) || 1920;
export const VIEWPORT_HEIGHT = Number(process.env.VIEWPORT_HEIGHT) || 1080;

// ─── Timeouts (minutes) for model response ──────────────────────────
export const REQUEST_TIMEOUT_MINUTES = Number(process.env.DEEPSEEK_REQUEST_TIMEOUT) || 5;
