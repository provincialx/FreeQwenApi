import crypto from "crypto";
import { logInfo, logDebug } from "../logger/index.js";
import { ALLOW_UNSCOPED_SESSION_CHAT_RESTORE } from "../config.js";
import { createChatV2 } from "./chat.js";
import { getMappedModel } from "./modelMapping.js";

// ─── Idempotency / Dedup Cache ────────────────────────────────────────────────
const idempotencyCache = new Map();
const IDEM_CACHE_TTL_MS = 5000;

export function getIdempotencyKey(messages, chatId) {
  if (!Array.isArray(messages) || messages.length === 0) return null;
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return null;
  let contentStr = "";
  if (typeof lastUser.content === "string") {
    contentStr = lastUser.content.substring(0, 200);
  } else if (Array.isArray(lastUser.content)) {
    const texts = lastUser.content.filter((x) => x.type === "text").map((x) => x.text || "");
    contentStr = texts.join("").substring(0, 200);
  }
  if (!contentStr) return null;
  const contentHash = crypto.createHash("md5").update(contentStr).digest("hex");
  return `idemp::${chatId || "none"}::${contentHash}`;
}

export function getCachedResult(key) {
  if (!key) return null;
  const entry = idempotencyCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.timestamp > IDEM_CACHE_TTL_MS) {
    idempotencyCache.delete(key);
    return null;
  }
  logInfo(`⚡️ Idempotency hit: returning cached result`);
  return entry.result;
}

export function cacheResult(key, result) {
  if (!key || !result) return;
  idempotencyCache.set(key, { result, timestamp: Date.now() });
  if (idempotencyCache.size > 1000) {
    const now = Date.now();
    for (const [k, v] of idempotencyCache) {
      if (now - v.timestamp > IDEM_CACHE_TTL_MS) idempotencyCache.delete(k);
    }
  }
}

// ─── Chat ID Generation & Normalization ──────────────────────────────────────

export function generateChatIdFromHistory(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return null;

  const realMessages = messages.filter((m) => {
    if (m.role !== "user") return true;
    const content = typeof m.content === "string" ? m.content : "";
    return !content.startsWith("### Task:") && !content.startsWith("History:");
  });

  const messagesToUse = realMessages.length > 0 ? realMessages : messages;

  const userMessages = messagesToUse
    .filter((m) => m.role === "user")
    .slice(0, 1)
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("||");

  if (!userMessages) return null;

  const hash = crypto.createHash("sha256").update(userMessages).digest("hex").substring(0, 16);

  return `chat_${hash}`;
}

export function normalizeIdValue(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return String(value);
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const lower = trimmed.toLowerCase();
  if (lower === "null" || lower === "undefined") return null;

  return trimmed;
}

function pickFirstId(candidates) {
  for (const candidate of candidates) {
    const normalized = normalizeIdValue(candidate);
    if (normalized) return normalized;
  }
  return null;
}

export function buildInternalChatIdFromHint(hint) {
  const normalizedHint = normalizeIdValue(hint);
  if (!normalizedHint) return null;

  const hash = crypto
    .createHash("sha256")
    .update(`client-conversation:${normalizedHint}`)
    .digest("hex")
    .substring(0, 16);

  return `chat_${hash}`;
}

export function extractConversationHint(req) {
  const body = req.body || {};
  const metadata = body && typeof body.metadata === "object" ? body.metadata : {};

  return pickFirstId([
    body.conversation_id,
    body.conversationId,
    body.chat_id,
    metadata.conversation_id,
    metadata.conversationId,
    metadata.chat_id,
    metadata.chatId,
    req.get?.("x-conversation-id"),
    req.get?.("x-openwebui-conversation-id"),
    req.get?.("x-chat-id"),
    req.get?.("x-openwebui-chat-id"),
  ]);
}

export function extractParentHint(req) {
  const body = req.body || {};
  const metadata = body && typeof body.metadata === "object" ? body.metadata : {};

  return pickFirstId([
    body.parentId,
    body.parent_id,
    body.x_qwen_parent_id,
    body.response_id,
    metadata.parentId,
    metadata.parent_id,
    metadata.response_id,
    req.get?.("x-parent-id"),
    req.get?.("x-openwebui-parent-id"),
  ]);
}

function isTruthyFlag(value) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function shouldForceNewChat(req) {
  const body = req.body || {};

  return [
    body.newChat,
    body.new_chat,
    body.resetChat,
    body.reset_chat,
    req.get?.("x-new-chat"),
    req.get?.("x-reset-chat"),
  ].some(isTruthyFlag);
}

export function shouldPersistSessionContext(scope = null) {
  const normalizedScope = normalizeIdValue(scope);
  return Boolean(normalizedScope) || ALLOW_UNSCOPED_SESSION_CHAT_RESTORE;
}

// ─── Model Default Chats ──────────────────────────────────────────────────────
// One chat per model for agents without conversation_hint.
const modelDefaultChats = new Map();

/**
 * Auto-reset Qwen chat context after N tool calls.
 * Accumulated tool context makes qwen3.7-max answer text instead of JSON.
 * Config: TOOL_CALL_RESET_THRESHOLD (default: 8)
 */
export const TOOL_CALL_RESET_THRESHOLD = Number(process.env.TOOL_CALL_RESET_THRESHOLD) || 8;

// Tracks models invalidated by auto-reset. Force Folding applied on NEXT request.
const forceResetModels = new Set();
export const FORCE_FOLD_HEAD = 5;
export const FORCE_FOLD_TAIL = 10;

export function applyForceFolding(messages, mappedModel) {
  if (!forceResetModels.has(mappedModel)) return messages;
  const systemMsgs = messages.filter((m) => m?.role === "system");
  let nonSys = messages.filter((m) => m?.role !== "system");
  if (nonSys.length < FORCE_FOLD_HEAD + FORCE_FOLD_TAIL) {
    forceResetModels.delete(mappedModel);
    return messages;
  }
  const head = nonSys.slice(0, FORCE_FOLD_HEAD);
  const tailStart = Math.max(FORCE_FOLD_HEAD, nonSys.length - FORCE_FOLD_TAIL);
  const tail = nonSys.slice(tailStart);
  const discarded = nonSys.slice(FORCE_FOLD_HEAD, tailStart);
  const toolSummary = summarizeDiscardedTools(discarded);
  logInfo(
    "🔁 Force Folding: " +
      messages.length +
      "→" +
      (head.length + tail.length) +
      " msgs. " +
      discarded.length +
      " turns compressed"
  );
  forceResetModels.delete(mappedModel);
  return [...systemMsgs, ...head, toolSummary, ...tail];
}

function summarizeDiscardedTools(messages) {
  const toolCounts = {};
  let assistantCount = 0;
  let toolResultCount = 0;
  for (const msg of messages) {
    if (!msg) continue;
    if (msg.role === "assistant") {
      assistantCount++;
      if (Array.isArray(msg.tool_calls))
        for (const tc of msg.tool_calls) {
          const name = tc?.function?.name || tc?.name || "unknown";
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
    } else if (msg.role === "tool") {
      toolResultCount++;
    }
  }
  let summaryText =
    "\n[Previous agent work (compressed for context):\n" +
    assistantCount +
    " assistant turns across " +
    toolResultCount +
    " tool executions]\n";
  if (Object.keys(toolCounts).length > 0) {
    const usage = Object.entries(toolCounts)
      .sort((a, b) => b[1] - a[1])
      .map(function (p) {
        return "  " + p[0] + ": " + p[1] + "x";
      })
      .join("\n");
    summaryText += "\nTool usage:\n" + usage;
  }
  return { role: "user", content: summaryText };
}

export function getOrCreateModelDefaultChat(model) {
  const existing = modelDefaultChats.get(model);
  if (existing && Date.now() - existing.timestamp < 3600000 * 24) {
    return { chatId: existing.chatId, parentId: existing.parentId };
  }
  return null; // Will be created in resolveQwenChatId
}

export function saveModelDefaultChat(model, chatId, parentId) {
  const existing = modelDefaultChats.get(model);
  modelDefaultChats.set(model, {
    chatId,
    parentId,
    timestamp: Date.now(),
    toolCallCount: existing?.toolCallCount || 0,
  });
  logDebug(`Default чат для ${model}: ${chatId}`);
}

export function invalidateModelDefaultChat(model) {
  const removed = modelDefaultChats.delete(model);
  if (removed) {
    logInfo(`🗑 Инвалидирован default-чат для ${model}: ${removed.chatId}`);
  }
  for (const [key, val] of chatIdMap.entries()) {
    if (val === removed?.chatId) {
      chatIdMap.delete(key);
      logDebug(`Очищен маппинг: ${key} -> (удалён)`);
    }
  }
  forceResetModels.add(model);
}

/**
 * Invalidate a specific Qwen chat ID across all maps.
 * Call this when sendMessage receives "chat not exist" from Qwen API,
 * so the stale entry doesn't get reused on the next request.
 */
export function invalidateQwenChatId(qwenChatId) {
  let removed = false;

  // Remove from chatIdMap — any generated ID mapping to this dead chat
  for (const [key, val] of chatIdMap.entries()) {
    if (val === qwenChatId) {
      chatIdMap.delete(key);
      logDebug(`🗑 Очишен маппинг на несуществующий чат: ${key} -> ${qwenChatId}`);
      removed = true;
    }
  }

  // Remove from modelDefaultChats — any model defaulting to this dead chat
  for (const [model, entry] of modelDefaultChats.entries()) {
    if (entry.chatId === qwenChatId) {
      modelDefaultChats.delete(model);
      logInfo(`🗑 Удалён stale default-чат для ${model}: ${qwenChatId}`);
      removed = true;
    }
  }

  // Remove from sessionToChatMap — any session holding this dead chat reference
  for (const [key, val] of sessionToChatMap.entries()) {
    if (val.chatId === qwenChatId) {
      sessionToChatMap.delete(key);
      logDebug(`🗑 Очищена сессия со stale чатом: ${key.substring(0, 8)}...`);
      removed = true;
    }
  }

  // Clean chatTokenOwner mapping for this stale chat
  chatTokenOwner.delete(qwenChatId);

  if (removed) {
    logInfo(`♻️ Инвалидирован несуществующий Qwen чат: ${qwenChatId}`);
  }
}

// ─── Chat-to-Token Ownership ──────────────────────────────────────────────
// Each Qwen chat is owned by the account that created it. Prevents cross-account "not exist" errors.
const chatTokenOwner = new Map(); // qwenChatId -> tokenObj.id

export function setChatTokenOwner(qwenChatId, tokenId) {
  if (qwenChatId && tokenId) {
    chatTokenOwner.set(qwenChatId, tokenId);
    logDebug(`Привязка чата ${qwenChatId} -> аккаунт ${tokenId}`);
  }
}

export function getChatTokenOwner(qwenChatId) {
  return qwenChatId ? chatTokenOwner.get(qwenChatId) : null;
}

// Expose for auto-reset increment in routes
export function getModelDefaultChats() {
  return modelDefaultChats;
}

// ─── Chat ID Resolution ──────────────────────────────────────────────────────

export function isChatNotExistError(result) {
  const body = result?.details || "";
  return typeof body === "string" && /not exist/i.test(body);
}

const chatIdMap = new Map();

function mapChatId(generatedId, qwenChatId) {
  if (generatedId) {
    chatIdMap.set(generatedId, qwenChatId);
    logDebug(`Маппинг чата: ${generatedId} -> ${qwenChatId}`);
  }
}

function getChatIdFromMap(generatedId) {
  return generatedId ? chatIdMap.get(generatedId) : null;
}

// ─── OpenWebUI Meta Request Detection ────────────────────────────────────────

function isOpenWebUiMetaRequest(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return false;
  const lastUserMessage = messages.filter((m) => m && m.role === "user").pop();
  if (!lastUserMessage) return false;

  const content = lastUserMessage.content;
  if (Array.isArray(content)) return false;
  if (typeof content !== "string") return false;

  const text = content.trimStart();

  if (text.startsWith("### Task:")) return true;
  if (text.startsWith("History:")) return true;

  if (text.includes("<chat_history>") && text.includes("### Task:")) return true;

  return false;
}
export { isOpenWebUiMetaRequest };

// ─── Chat ID Resolution (async) ──────────────────────────────────────────────

export async function resolveQwenChatId(effectiveChatId, mappedModel) {
  let qwenChatId = effectiveChatId;
  const mapped = getChatIdFromMap(effectiveChatId);

  if (mapped) {
    qwenChatId = mapped;
    logInfo(`🔁 Используется сопоставленный Qwen chatId: ${qwenChatId} (from ${effectiveChatId})`);
    return qwenChatId;
  }

  // If no effective ID or it's generated — try default for model
  let defaultResolved = false;
  if (!qwenChatId || effectiveChatId?.startsWith("chat_")) {
    const defaultForModel = getOrCreateModelDefaultChat(mappedModel);
    if (defaultForModel) {
      logInfo(`♻️ Дефолтный Qwen чат для ${mappedModel}: ${defaultForModel.chatId}`);
      qwenChatId = defaultForModel.chatId;

      if (effectiveChatId && effectiveChatId.startsWith("chat_")) {
        mapChatId(effectiveChatId, qwenChatId);
      }

      defaultResolved = true;
    }
  }

  // Create new Qwen chat if we're still holding a proxy-generated ID and no default was found.
  // defaultResolved === false means modelDefaultChats had no valid entry for this model
  // (server restart, 24h expiry). Without creating here, the proxy-hash reaches Qwen → "not exist".
  if (!defaultResolved && effectiveChatId?.startsWith("chat_") && qwenChatId === effectiveChatId) {
    try {
      const created = await createChatV2(mappedModel, "Сессия OpenWebUI");
      if (created && created.chatId) {
        mapChatId(effectiveChatId, created.chatId);
        qwenChatId = created.chatId;

        saveModelDefaultChat(mappedModel, qwenChatId, null);

        logInfo(`🔨 Создан Qwen chat ${qwenChatId} и привязан к ${effectiveChatId}`);
      }
    } catch (error) {
      logDebug(`Не удалось создать Qwen chat для ${effectiveChatId}: ${error.message}`);
    }
  }

  // When effective ID is null and no default was found — rely on sendMessage() to create one.
  // This happens for meta-requests or explicit null-chat scenarios.
  if (!qwenChatId && !effectiveChatId) {
    return null;
  }

  return qwenChatId;
}

// ─── Scoped Sessions ──────────────────────────────────────────────────────────

// Scoped-session tracking. Unscoped fallback only via ALLOW_UNSCOPED_SESSION_CHAT_RESTORE.
const sessionToChatMap = new Map();

function getSessionKey(req) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const userAgent = req.get("user-agent") || "unknown";
  return crypto.createHash("sha256").update(`${ip}||${userAgent}`).digest("hex");
}

function getScopedSessionKey(req, scope = null) {
  const baseKey = getSessionKey(req);
  const normalizedScope = normalizeIdValue(scope);
  return normalizedScope ? `${baseKey}::${normalizedScope}` : baseKey;
}

export function getSavedChatId(req, scope = null) {
  const keysToTry = [getScopedSessionKey(req, scope)];

  for (const sessionKey of keysToTry) {
    const sessionData = sessionToChatMap.get(sessionKey);
    if (sessionData && Date.now() - sessionData.timestamp < 3600000) {
      return sessionData;
    }
  }

  return null;
}

export function saveChatIdForSession(req, chatId, parentId, scope = null) {
  const sessionKey = getScopedSessionKey(req, scope);
  const normalizedScope = normalizeIdValue(scope);

  sessionToChatMap.set(sessionKey, {
    chatId,
    parentId,
    scope: normalizedScope,
    timestamp: Date.now(),
  });

  const scopeSuffix = normalizedScope ? ` (scope=${normalizedScope})` : "";
  logDebug(`Saved chatId ${chatId} for session ${sessionKey.substring(0, 8)}${scopeSuffix}`);
}

// ─── Chat ID Map Access ───────────────────────────────────────────────────────

export function mapChatIdExport(generatedId, qwenChatId) {
  if (generatedId) {
    chatIdMap.set(generatedId, qwenChatId);
    logDebug(`Маппинг чата: ${generatedId} -> ${qwenChatId}`);
  }
}

// Expose forceResetModels for prepareOpenAIMessageInput
export function getForceResetModels() {
  return forceResetModels;
}

// ─── Session Persistence (shared by streaming + non-streaming) ───────────────
// Extracts the ~46-line duplicate block that ran in both /chat/completions paths.
export function persistSessionState(
  result,
  qwenChatId,
  isMeta,
  effectiveChatId,
  conversationScope,
  mappedModel,
  req,
  effectiveParentId
) {
  const resolvedChatId = result.chatId || qwenChatId;

  if (isMeta || !resolvedChatId) return;

  // Map generated export ID → Qwen internal ID
  if (effectiveChatId && effectiveChatId.startsWith("chat_") && resolvedChatId) {
    mapChatIdExport(effectiveChatId, resolvedChatId);
    logDebug(`Маппинг сохранён: ${effectiveChatId} -> ${resolvedChatId}`);
  }

  // Persist to scoped session storage
  if (shouldPersistSessionContext(conversationScope)) {
    saveChatIdForSession(req, resolvedChatId, result.parentId, conversationScope);
  }

  // Update model default chat — next request without chatId reuses it
  const existing = getOrCreateModelDefaultChat(mappedModel);
  if ((existing && existing.chatId === resolvedChatId) || result.newChatId) {
    // If retry created a new chat, invalidate old stale caches first.
    // This prevents next request from resolveQwenChatId returning dead chat ID
    // before persistSessionState had a chance to update the default.
    if (result.newChatId && existing?.chatId !== resolvedChatId) {
      // Don't invalidate mid-agent-loop — Qwen loses context of prior
      // assistant.tool_calls in fresh chat and writes explanatory text
      // instead of continuing. Only reset when loop naturally ends.
      const inLoop =
        existing?.inAgentLoop ||
        (result.choices?.[0]?.message?.content || "").includes("tool_calls");
      if (inLoop) {
        logInfo(`♻️ Retry-newChatId during active loop — skipping invalidation for ${mappedModel}`);
      } else {
        invalidateModelDefaultChat(mappedModel);
      }
    }
    saveModelDefaultChat(mappedModel, resolvedChatId, result.parentId || effectiveParentId);
    if (result.newChatId) {
      logInfo(
        `♻️ Обновлён default-чат после создания нового: ${resolvedChatId} для ${mappedModel}`
      );
    } else {
      logDebug(`Обновлён parentId в default-чате: ${result.parentId}`);
    }
  }
}

// Cleanup stale sessions every 10 minutes
setInterval(() => {
  const now = Date.now();
  const oneHourAgo = now - 3600000;
  let cleaned = 0;
  for (const [key, value] of sessionToChatMap.entries()) {
    if (value.timestamp < oneHourAgo) {
      sessionToChatMap.delete(key);
      cleaned++;
    }
  }
  if (cleaned > 0) {
    logDebug(`Очищено ${cleaned} старых сессий в sessionToChatMap`);
  }

  // Also clean modelDefaultChats — expire entries older than 24h that are no longer needed.
  // modelDefaultChats checked on read but stale keys accumulate forever without this.
  const dayAgo = now - 86400000;
  let modelCleaned = 0;
  for (const [key, value] of modelDefaultChats.entries()) {
    if (value.timestamp < dayAgo) {
      modelDefaultChats.delete(key);
      modelCleaned++;
    }
  }

  // Clean chatIdMap — cap at reasonable size. Evict oldest entries to prevent unbounded growth.
  // Each entry is ~100 bytes; unlimited map grows with unique conversation IDs from OpenWebUI/Zed.
  const MAX_CHAT_MAP_SIZE = 500;
  if (chatIdMap.size > MAX_CHAT_MAP_SIZE) {
    const toEvict = chatIdMap.size - Math.floor(MAX_CHAT_MAP_SIZE / 2);
    let evicted = 0;
    for (const key of chatIdMap.keys()) {
      if (evicted >= toEvict) break;
      chatIdMap.delete(key);
      evicted++;
    }
    logDebug(
      `chatIdMap GC: evicted ${evicted} entries, ${chatIdMap.size} remaining (cap ${MAX_CHAT_MAP_SIZE})`
    );
  }

  // Also clean idempotency cache aggressively — 5s TTL means old keys are garbage.
  let idemCleaned = 0;
  for (const [k, v] of idempotencyCache.entries()) {
    if (now - v.timestamp > IDEM_CACHE_TTL_MS) {
      idempotencyCache.delete(k);
      idemCleaned++;
    }
  }

  // Clean chatTokenOwner — cap at reasonable size to prevent unbounded growth.
  const MAX_OWNER_SIZE = 500;
  if (chatTokenOwner.size > MAX_OWNER_SIZE) {
    const ownerToEvict = chatTokenOwner.size - Math.floor(MAX_OWNER_SIZE / 2);
    let ownerEvicted = 0;
    for (const key of chatTokenOwner.keys()) {
      if (ownerEvicted >= ownerToEvict) break;
      // Only evict if this qwenChatId is no longer referenced elsewhere
      const stillReferenced = [...chatIdMap.values()].includes(key);
      if (!stillReferenced) {
        chatTokenOwner.delete(key);
        ownerEvicted++;
      }
    }
    logDebug(
      `chatTokenOwner GC: evicted ${ownerEvicted} entries, ${chatTokenOwner.size} remaining`
    );
  }

  const total = cleaned + modelCleaned + idemCleaned;
  if (total > 0) {
    logInfo(
      `♻️ Cache GC: session=${cleaned}, modelDefault=${modelCleaned}, idempotency=${idemCleaned}`
    );
  }
}, 600000);
