/**
 * Browser proxy page — executes DeepSeek API calls inside an authenticated browser context.
 */
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { logInfo, logWarn } from "../../../shared/logger/index.js";
import { CHAT_PAGE_URL, DEEPSEEK_MODELS } from "../config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ACCOUNTS_PATH = path.resolve(__dirname, "..", "..", "session");
const DEEPSEEK_ACCOUNTS_FILE = path.join(ACCOUNTS_PATH, "deepseek_accounts.json");

let browser = null;
let page = null;

function loadSavedCookies() {
  try {
    const data = JSON.parse(fs.readFileSync(DEEPSEEK_ACCOUNTS_FILE, "utf8"));
    if (Array.isArray(data) && data.length > 0) {
      // First account is the latest saved session
      return data[0].cookies || [];
    }
  } catch {}
  return null;
}

export async function initBrowserPage() {
  if (page) return true;

  try {
    puppeteer.use(StealthPlugin());
    browser = await puppeteer.launch({
      headless: "new",
      args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
    });

    page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });

    // Restore saved cookies BEFORE navigation (authentication is in cookies)
    const savedCookies = loadSavedCookies();
    if (savedCookies && savedCookies.length > 0) {
      await page.setCookie(...savedCookies);
      logInfo(`[BrowserProxy] Загружено ${savedCookies.length} cookie из сессии`);
    }

    await page.goto(CHAT_PAGE_URL, { waitUntil: "networkidle2", timeout: 30_000 });

    const loggedIn = await page.evaluate(() => {
      return !!document.cookie.match(/aws-waf-token/);
    });

    if (!loggedIn) {
      logWarn("[BrowserProxy] Страница не авторизована.");
    } else {
      logInfo("[BrowserProxy] Браузерная страница готова (авторизован)");
    }
  } catch (err) {
    logWarn("[BrowserProxy] Ошибка инициализации:", err.message);
  }

  return !!page;
}

export async function sendViaBrowser(messages, model) {
  if (!page) {
    logWarn("[BrowserProxy] Страница не инициализирована.");
    return { success: false, error: "Нет активной страницы браузера" };
  }

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

    return await page.evaluate(
      async ({ prompt, cfg }) => {
        const apiUrl = "https://chat.deepseek.com/api/v0/chat/completion";

        const body = {
          model_type: cfg.model_type || "default",
          prompt,
          thinking_enabled: cfg.thinking_enabled ?? false,
          search_enabled: false,
          ref_file_ids: [],
          action: null,
          preempt: false,
          chat_session_id: crypto.randomUUID(),
        };

        const response = await fetch(apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const errText = await response.text();
          return { success: false, error: `HTTP ${response.status}: ${errText.slice(0, 200)}` };
        }

        // Parse SSE stream
        let fullContent = "";
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

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
              if (!dataStr) continue;

              try {
                const json = JSON.parse(dataStr);
                // Skip thinking elapsed marker, extract text from delta chunks (v field)
                if (json.p === "response/thinking_elapsed_secs") continue;
                if (json.v && typeof json.v === "string") {
                  fullContent += json.v;
                }
              } catch {}
            }
          }
        } catch (e) {}

        logInfo(`[BrowserPage] Ответ от DeepSeek API: ${fullContent.length} символов`);
        return { success: true, data: { content: fullContent } };
      },
      {
        prompt: promptText || lastMsg,
        cfg: {
          model_type: cfg.model_type,
          thinking_enabled: cfg.thinking_enabled,
          search_enabled: cfg.search_enabled ?? false,
        },
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
}
