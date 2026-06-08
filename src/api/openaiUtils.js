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

export function buildStatelessTranscript(messages) {
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
    /unavailable/i,
    /not supported/i,
    /is not available/i,
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
