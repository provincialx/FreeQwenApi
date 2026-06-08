import { getMappedModel } from "./modelMapping.js";
import { applyForceFolding, getForceResetModels } from "./chatSession.js";

// ─── OpenAI Message Parsing ──────────────────────────────────────────────────

export function parseOpenAIMessages(messages) {
  const systemMsg = messages.find((msg) => msg.role === "system");
  const systemMessage = systemMsg ? systemMsg.content : null;
  const lastUserMessage = messages.filter((msg) => msg.role === "user").pop();

  if (!lastUserMessage) {
    return { messageContent: null, systemMessage };
  }

  let messageContent = lastUserMessage.content;

  // Transform OpenAI format content array to internal format
  if (Array.isArray(messageContent)) {
    messageContent = messageContent.map((item) => {
      if (item.type === "text") {
        return { type: "text", text: item.text };
      } else if (item.type === "image_url" && item.image_url) {
        return { type: "image", image: item.image_url.url };
      } else if (item.type === "image") {
        return { type: "image", image: item.image };
      }
      return item;
    });
  }

  return { messageContent, systemMessage };
}

export function buildCombinedTools(tools, functions, toolChoice) {
  const combinedTools =
    tools ||
    (functions
      ? functions.map((fn) => ({ type: "function", function: fn }))
      : null);
  return { combinedTools, toolChoice };
}

// ─── Content Stringification ──────────────────────────────────────────────────

export function stringifyOpenAIContent(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item) return "";
        if (typeof item === "string") return item;
        if (item.type === "text") return item.text || "";
        if (item.type === "image_url")
          return `[image: ${item.image_url?.url || ""}]`;
        if (item.type === "image") return `[image: ${item.image || ""}]`;
        if (item.type === "file")
          return `[file: ${item.file || item.name || ""}]`;
        return JSON.stringify(item);
      })
      .filter(Boolean)
      .join("\n");
  }
  return JSON.stringify(content);
}

// ─── Stateless Transcript Builder ─────────────────────────────────────────────

/** Last message is tool result or assistant with tool_calls */
export function isLastMessageToolState(messages) {
  const last = [...(messages || [])].reverse().find((m) => m);
  if (!last) return false;
  return (
    last.role === "tool" ||
    last.role === "function" ||
    (last.role === "assistant" &&
      (last.tool_calls?.length > 0 || last.function_call))
  );
}

/** Compact signature for dedup tool results */
function _toolCallSignature(name, arguments_ = {}) {
  const argsStr = JSON.stringify(arguments_);
  return `${name}|${argsStr.substring(0, 200)}`;
}

/** Truncate text while preserving readability */
function compactText(text, maxLen = 8000) {
  if (!text || typeof text !== "string") return "";
  const trimmed = text.trim();
  if (trimmed.length <= maxLen) return trimmed;
  return trimmed.substring(0, maxLen).trimEnd() + "...[content truncated]";
}

/** Collect deduped tool results from current turn */
function collectCurrentToolTurn(messages) {
  const msgs = messages || [];
  let lastAssistIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (
      msgs[i]?.role === "assistant" &&
      (msgs[i].tool_calls?.length > 0 || msgs[i].function_call)
    ) {
      lastAssistIdx = i;
      break;
    }
  }
  const results = [];
  for (let i = lastAssistIdx + 1; i < msgs.length; i++) {
    if (msgs[i]?.role === "tool" || msgs[i]?.role === "function") {
      results.push({
        name: msgs[i].name || msgs[i].tool_call_id?.substring(0, 10) || "tool",
        arguments: {},
        content: stringifyOpenAIContent(msgs[i].content),
      });
    }
  }
  return [lastAssistIdx >= 0, results];
}

/** Build compact tool result summary (from Python fork).
 * Dedup identical calls and add explicit continuation instructions.
 * This prevents Qwen from echoing tool errors as its own response. */
export function buildCompactToolResults(messages) {
  const [, results] = collectCurrentToolTurn(messages);
  if (!results || !results.length) return null;

  // Dedup by signature, keep latest content per call pattern
  const order = [];
  const bySig = {};
  for (const r of results) {
    const sig =
      _toolCallSignature(r.name, r.arguments) || `idx:${order.length}`;
    if (!bySig[sig]) {
      order.push(sig);
    }
    bySig[sig] = r;
  }
  const deduped = order.map((s) => bySig[s]);

  // Find last user message as context anchor
  const msgs = messages || [];
  let lastUserIdx = -1;
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i]?.role === "user") {
      lastUserIdx = i;
      break;
    }
  }

  const parts = [];
  if (lastUserIdx >= 0) {
    const originalUser = compactText(
      stringifyOpenAIContent(msgs[lastUserIdx].content),
      8000,
    );
    if (originalUser)
      parts.push(`Исходная задача пользователя:\nUser: ${originalUser}`);
  }

  parts.push(
    "Уже выполненные инструменты и их результаты в этой задаче (это твоя память — НЕ выполняй их заново):",
  );

  for (const r of deduped) {
    const argsText = r.arguments ? JSON.stringify(r.arguments) : null;
    const header = argsText
      ? `${r.name || "tool"}(${argsText})`
      : `${r.name || "tool"}()`;
    parts.push(`\n${header}:\n${compactText(r.content, 1000)}`);
  }

  const resultTexts = deduped.map((r) => compactText(r.content, 1000));
  const readonlyDone = deduped
    .filter(
      (r) =>
        r.name &&
        [
          "list_directory",
          "read_file",
          "find_path",
          "grep",
          "diagnostics",
        ].includes(r.name),
    )
    .map((r) => `${r.name || "tool"}()`);

  // Error-specific instructions (from Python fork)
  const lowerContents = resultTexts.join("\n").toLowerCase();
  if (lowerContents.includes("outside the project")) {
    parts.push(
      "\nВажно: инструмент вернул ошибку про путь (outside the project). Повтори вызов с исправленным путём в том формате, который ожидает Zed; если повтор не помогает — объясни ограничение обычным текстом.",
    );
  }
  if (resultTexts.some((t) => !t.trim())) {
    parts.push(
      "\nВажно: пустой вывод инструмента со Status: Completed — это уже результат, а не повод повторять тот же вызов.",
    );
  }
  if (readonlyDone.length > 0) {
    parts.push(
      `\nТы уже осмотрел эти пути/файлы: ${readonlyDone.join("; ")}. НЕ вызывай list_directory/read_file повторно для них — вся информация уже есть выше.`,
    );
  }

  // Explicit continuation instruction (critical for agent loop)
  parts.push(
    "\nПродолжи исходную задачу, опираясь на эту память. Не повторяй уже выполненные вызовы. Переходи к следующему конкретному шагу: создавай недостающие файлы через write_file, и только когда всё готово — дай финальный обычный ответ. Если нужен инструмент, ответь только минифицированным JSON tool_calls.",
  );

  const text = parts.join("\n");
  const maxTotal = parseInt(process.env.TOOL_CONTEXT_MAX_CHARS || "32000", 10);
  if (text.length > maxTotal) {
    return (
      text.substring(0, maxTotal).trimEnd() +
      `\n\n...[tool context truncated to ${maxTotal} chars]`
    );
  }
  return text;
}

/** Build stateless transcript with compact tool results when agent loop active.
 * Uses Python-fork logic to prevent Qwen from echoing tool errors as its own response. */
export function buildStatelessTranscript(messages) {
  // When last message is tool result, use compact format for clean continuation
  if (isLastMessageToolState(messages)) {
    const compact = buildCompactToolResults(messages);
    if (compact) return compact;
  }

  // Fallback: standard transcript folding
  const parts = [];
  for (const msg of messages || []) {
    if (!msg || msg.role === "system") continue;
    if (msg.role === "user") {
      parts.push(`User: ${stringifyOpenAIContent(msg.content)}`);
    } else if (msg.role === "assistant") {
      const text = stringifyOpenAIContent(msg.content);
      if (text) parts.push(`Assistant: ${text}`);
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
        const actions = msg.tool_calls
          .map((tc) => tc?.function?.name || tc?.name)
          .join(", ");
        parts.push(`Assistant used tools: ${actions}`);
      }
    } else if (msg.role === "tool") {
      const name = msg.name || msg.tool_call_id || "tool";
      const toolResult = stringifyOpenAIContent(msg.content);
      if (isToolFailure(toolResult)) {
        parts.push(`Tool ${name} was not available.`);
      } else {
        parts.push(`Tool result (${name}): ${toolResult}`);
      }
    } else {
      parts.push(
        `${msg.role || "message"}: ${stringifyOpenAIContent(msg.content)}`,
      );
    }
  }
  return parts.join("\n\n");
}

// ─── Tool Failure Detection ──────────────────────────────────────────────────

export function isToolFailure(content) {
  if (typeof content !== "string" || !content.trim()) return false;
  const patterns = [
    /does not exist/i,
    /not found/i,
    /is not available/i, // Keep specific - matches OpenAI style
    /unknown tool/i,
    /invalid tool/i,
    /no such tool/i,
    /tool input was not fully received/i, // Zed Agent terminal truncation
    /arguments.*not.*received/i,
  ];
  return patterns.some((p) => p.test(content));
}

export function areAllToolsFailed(messages) {
  const toolMessages = (messages || []).filter(
    (msg) => msg?.role === "tool" || msg?.role === "function",
  );
  if (toolMessages.length === 0) return false;
  return toolMessages.every((msg) => {
    const content = stringifyOpenAIContent(msg.content);
    return isToolFailure(content);
  });
}

export function hasOpenAIToolState(messages) {
  return (messages || []).some(
    (msg) =>
      msg?.role === "tool" ||
      msg?.role === "function" ||
      (msg?.role === "assistant" &&
        Array.isArray(msg.tool_calls) &&
        msg.tool_calls.length > 0) ||
      (msg?.role === "assistant" && msg.function_call),
  );
}

// ─── Transcript Folding Decision ──────────────────────────────────────────────

export function shouldFoldOpenAITranscript(
  messages,
  combinedTools,
  effectiveChatId,
) {
  const nonSystemMessages = (messages || []).filter(
    (msg) => msg && msg.role !== "system",
  );
  if (nonSystemMessages.length === 0) return false;

  if (hasOpenAIToolState(messages)) return true;

  if (!effectiveChatId && nonSystemMessages.length > 1) return true;

  if (
    Array.isArray(combinedTools) &&
    combinedTools.length > 0 &&
    nonSystemMessages.length > 1
  )
    return true;

  return false;
}

// ─── Message Input Preparation ────────────────────────────────────────────────

export function prepareOpenAIMessageInput(
  messages,
  combinedTools,
  effectiveChatId,
  rawModel = null,
) {
  // Force Folding: compress accumulated tool history after auto-reset
  if (rawModel && hasOpenAIToolState(messages)) {
    const mm = getMappedModel(rawModel);
    const forceResetModels = getForceResetModels();
    if (forceResetModels.has(mm)) {
      messages = applyForceFolding(messages, mm);
    }
  }

  const lastUserMessage = (messages || [])
    .filter((msg) => msg && msg.role === "user")
    .pop();
  if (shouldFoldOpenAITranscript(messages, combinedTools, effectiveChatId)) {
    return {
      messageContent: buildStatelessTranscript(messages),
      files: lastUserMessage?.files || [],
      folded: true,
      missingUser: false,
    };
  }

  if (!lastUserMessage) {
    return {
      messageContent: null,
      files: [],
      folded: false,
      missingUser: true,
    };
  }

  return {
    messageContent: lastUserMessage.content,
    files: lastUserMessage.files || [],
    folded: false,
    missingUser: false,
  };
}
