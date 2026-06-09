import crypto from "crypto";

export function truncateForPrompt(text, maxLen = 100) {
  if (typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).trim() + "...";
}

export function compactJsonSchema(schema, depth = 0) {
  if (!schema || typeof schema !== "object" || depth > 2) return schema;
  if (Array.isArray(schema))
    return schema
      .slice(0, 20)
      .map((item) => compactJsonSchema(item, depth + 1));

  const out = {};
  for (const key of ["type", "enum", "required", "default"]) {
    if (schema[key] !== undefined) out[key] = schema[key];
  }
  if (schema.description)
    out.description = truncateForPrompt(
      schema.description,
      depth === 0 ? 180 : 90,
    );
  if (schema.properties && typeof schema.properties === "object") {
    out.properties = {};
    for (const [name, prop] of Object.entries(schema.properties)) {
      out.properties[name] = compactJsonSchema(prop, depth + 1);
    }
  }
  if (schema.items) out.items = compactJsonSchema(schema.items, depth + 1);
  if (schema.oneOf) out.oneOf = compactJsonSchema(schema.oneOf, depth + 1);
  if (schema.anyOf) out.anyOf = compactJsonSchema(schema.anyOf, depth + 1);
  return out;
}

/**
 * Build Zed tool protocol prompt. Matches Python fork's tools_to_prompt().
 * Sends FULL tool schemas so Qwen knows exact parameter format.
 */
// Shared helper: build compact tool definitions with compressed schemas
function _buildCompactTools(tools) {
  return tools
    .map((tool) => {
      const fn = tool?.function || tool;
      if (!fn?.name) return null;
      const item = { name: fn.name };
      if (fn.description)
        item.description = truncateForPrompt(fn.description, 120);
      if (fn.parameters && typeof fn.parameters === "object") {
        item.parameters = compactJsonSchema(fn.parameters);
      }
      return item;
    })
    .filter(Boolean);
}

/**
 * Build Zed tool protocol prompt. Matches Python fork's tools_to_prompt().
 * Uses compact schemas to keep context window under control.
 */
export function toolsToPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const compact = _buildCompactTools(tools);
  if (compact.length === 0) return "";

  // Cap total prompt size — prevent context window overflow with many tools.
  let schemaStr = JSON.stringify(compact, null, 0);
  const MAX_SCHEMA_LEN = 6000;
  if (schemaStr.length > MAX_SCHEMA_LEN) {
    // Strip descriptions from all but last few tools to save tokens
    const trimmed = compact.map((t, i) => {
      if (i < compact.length - 5)
        return { name: t.name, parameters: { type: "object" } };
      return t;
    });
    schemaStr = JSON.stringify(trimmed, null, 0);
  }

  return `ВАЖНО: инструменты выполняет только внешний клиент Zed, не Qwen Chat.
Запрещено использовать встроенные инструменты сайта Qwen: web search, online search, research, code interpreter, browser, plugins.
Когда нужен инструмент Zed, ты ДОЛЖЕН написать tool call прямо в своём ответе как СЛУЖЕБНЫЙ JSON.
Этот JSON будет перехвачен прокси и НЕ будет показан пользователю в чате.
Формат строго такой, без markdown, без \`\`\` и без пояснений вокруг:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}
НИКОГДА не пиши намерение вызвать инструмент как видимый текст.
Либо ТОЛЬКО tool_calls JSON, либо ТОЛЬКО обычный текстовый ответ. Никогда оба вместе.
Pосле результата tool/function НЕ повторяй тот же самый tool call с теми же arguments.
Не выдумывай инструменты. Используй только имена из списка.
Если инструмент не нужен, отвечай обычным текстом.
Доступные Zed tools:
${schemaStr}`;
}

// ─── Raw JSON parser helpers (from Python fork) ──────────────────────────────

function _hasToolProtocolKey(obj) {
  if (!obj || typeof obj !== "object") return false;
  const keys = ["tool_calls", "tool_call", "function_call"];
  for (const k of keys) {
    if (k in obj && obj[k] != null) return true;
  }
  // Top-level single call: { name, arguments } without wrapper
  if (obj.name && obj.arguments !== undefined) return false; // handled separately below
  if ("name" in obj && "arguments" in obj && !("content" in obj)) return false;
  return false;
}

function _extractCallsFromParsed(parsed, allowSingle = false) {
  if (!parsed || typeof parsed !== "object") return null;
  let calls = null;
  if (Array.isArray(parsed.tool_calls)) {
    calls = parsed.tool_calls;
  } else if (parsed.function_call || parsed.tool_call) {
    calls = [parsed.function_call || parsed.tool_call];
  } else if (
    allowSingle &&
    parsed.name &&
    parsed.arguments !== undefined &&
    !("content" in parsed)
  ) {
    calls = [parsed];
  }
  return calls;
}

function _normalizeArgs(rawArgs) {
  // Re-parse then re-stringify to guarantee minified balanced JSON
  if (typeof rawArgs === "string") {
    try {
      const obj = JSON.parse(rawArgs);
      return JSON.stringify(obj, null, 0);
    } catch {
      // Not valid JSON string — may already be {"key":"val"} with escaping issues.
      // Return as-is; Zed will handle it.
      return rawArgs;
    }
  }
  if (typeof rawArgs === "object") {
    try {
      return JSON.stringify(rawArgs, null, 0);
    } catch {
      return JSON.stringify({});
    }
  }
  return JSON.stringify({});
}

function _repairTruncatedBraces(text) {
  // Count open/close braces and append missing closing ones.
  let depth = 0;
  const brackets = [];
  for (const ch of text) {
    if (ch === "[") {
      depth++;
      brackets.push("[");
    } else if (ch === "{") {
      depth++;
      brackets.push("{");
    } else if (ch === "]" && brackets.length > 0) {
      const last = brackets.pop();
      if (last !== "[")
        return null; // mismatched
      else depth--;
    } else if (ch === "}" && brackets.length > 0) {
      const last = brackets.pop();
      if (last !== "{")
        return null; // mismatched
      else depth--;
    }
  }
  if (brackets.length === 0) return text || null; // already balanced or empty
  // Append closing braces in reverse order of opening ones
  const needed = [...brackets]
    .reverse()
    .map((b) => (b === "[" ? "]" : "}"))
    .join("");
  return text + needed;
}

/**
 * Split Qwen mixed answer into user-visible reasoning text and service tool_calls.
 * Mirrors Python fork's parse_tool_call_parts for Zed Agent compatibility.
 */
export function parseToolCallParts(content) {
  if (typeof content !== "string" || !content.trim())
    return { visible: null, calls: null };

  let text = content.trim();

  // Debug trace (silent in production — use lastRawContentForDebug.value for inspection)
  lastRawContentForDebug.value = text.substring(0, 300);

  // Strip full-fence markdown if entire response is fenced JSON
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) {
    text = fence[1].trim();
  }

  // Normalize tool protocol XML artifacts
  text = text.replace(/<\/?(?:function|parameter|tool_call|tool)[^>]*>/gi, "");

  // --- Step 1: Try full parse (complete JSON object / array) ----
  try {
    const parsed = JSON.parse(text);
    const calls = _extractCallsFromParsed(parsed, true);
    if (calls && calls.length > 0) return { visible: "", calls: calls };
  } catch {}

  // --- Step 2: Find the first tool protocol marker and extract balanced JSON ----
  const markerPositions = [
    text.indexOf('"tool_calls"'),
    text.indexOf('"tool_call"'),
    text.indexOf('"function_call"'),
  ].filter((p) => p >= 0);

  if (markerPositions.length > 0) {
    const markerPos = Math.min(...markerPositions);
    // Find the outer wrapper { — search BACKWARD from marker first.
    // The tool_calls key lives INSIDE {"tool_calls":[...]}, so the
    // opening brace is typically BEFORE or AT the marker position.
    let jsonStart = text.lastIndexOf("{", markerPos);
    if (jsonStart < 0) {
      // Fallback: try forward search for nested/odd structures
      jsonStart = text.indexOf("{", markerPos);
    }

    // --- Step 2: Extract tool_calls JSON near marker ----
    let visible;
    let calls;

    if (jsonStart >= 0) {
      // Try balanced extraction from the {
      let depth = 0;
      for (let i = jsonStart; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{" || ch === "[") depth++;
        else if (ch === "}" || ch === "]") depth--;
        if (depth <= 0 && i > jsonStart) {
          try {
            const candidate = text.slice(jsonStart, i + 1);
            const parsed = JSON.parse(candidate);
            calls = _extractCallsFromParsed(parsed);
            if (calls && calls.length > 0) {
              visible = text
                .slice(0, jsonStart - 1)
                .replace(/```(?:json)?\s*```/gi, "")
                .trim();
              return { visible: visible || null, calls };
            }
          } catch {}
        }
      }

      // Repair truncated braces as last resort
      const slice = text.slice(jsonStart);
      const repaired = _repairTruncatedBraces(slice);
      if (repaired) {
        try {
          const parsed = JSON.parse(repaired);
          calls = _extractCallsFromParsed(parsed);
          if (calls && calls.length > 0) {
            visible = text
              .slice(0, jsonStart - 1)
              .replace(/```(?:json)?\s*```/gi, "")
              .trim();
            return { visible: visible || null, calls };
          }
        } catch {}
      }

      // Marker found but JSON unparseable — suppress leak
      visible = text
        .slice(0, jsonStart)
        .replace(/```(?:json)?\s*```/gi, "")
        .trim();
      return { visible: visible || null, calls: [] };
    }
  }

  // --- Step 3: Legacy fallback — find first/last brace ----
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidateSlice = text.slice(firstBrace, lastBrace + 1);

    // Try parse as-is, then with legacy repair patterns
    const attempts = [candidateSlice];
    if (
      /^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(candidateSlice) &&
      /\}\]\}\s*$/.test(candidateSlice)
    ) {
      attempts.push(candidateSlice.replace(/\}\]\}\s*$/, "}}]}"));
    }
    if (
      /^\s*\{\s*"tool_calls"\s*:\s*\[/.test(candidateSlice) &&
      !/\}\s*$/.test(candidateSlice)
    ) {
      attempts.push(candidateSlice + "}");
    }

    for (const attempt of attempts) {
      try {
        const parsed = JSON.parse(attempt);
        const calls = _extractCallsFromParsed(parsed, true);
        if (calls && calls.length > 0) {
          return { visible: text.slice(0, firstBrace).trim() || null, calls };
        }
      } catch {}
    }
  }

  // No tool_calls found — return full text as visible
  return { visible: content.trim(), calls: null };
}

// ─── Debug state ────────────────────────────────────────────────────────────

export const lastRawContentForDebug = { value: null };

/** @deprecated use parseToolCallParts and read .calls instead */
export function parseToolCallJson(content) {
  const parts = parseToolCallParts(content);
  if (!parts.calls || parts.calls.length === 0) return null;

  // Normalize arguments through JSON.parse/stringify to guarantee balanced minified output
  return normalizeToolCalls(parts.calls);
}

/** Take raw call objects and normalize into OpenAI-compatible format */
export function normalizeToolCalls(calls) {
  return calls
    .map((call, index) => {
      const name = call.name || call.tool || call.function?.name;
      const rawArgs =
        call.arguments ??
        call.args ??
        call.input ??
        call.function?.arguments ??
        {};
      const args = _normalizeArgs(rawArgs);
      if (!name) return null;
      return {
        id:
          call.id ||
          `call_${crypto.randomUUID().replace(/-/g, "").slice(0, 24)}`,
        type: "function",
        function: { name, arguments: args },
        index,
      };
    })
    .filter(Boolean);
}

export function applyToolPrompt(systemMessage, tools, inAgentLoop = false) {
  if (!Array.isArray(tools) || tools.length === 0) return systemMessage;

  let prompt;
  if (inAgentLoop) {
    // Light mode: model already has tool results. Don't coerce into more tool calls.
    // Just remind it can parse tool JSON if needed, but prefer natural language answer.
    prompt = toolsToLightPrompt(tools);
  } else {
    prompt = toolsToPrompt(tools);
  }

  return prompt ? `${systemMessage || ""}${prompt}`.trim() : systemMessage;
}

/** Agent-loop prompt: model has tool results.
 * Light version — don't coerce into more tool calls, but keep anti-loop guard.
 * Uses compact schemas to fit context window. */
export function toolsToLightPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const compact = _buildCompactTools(tools);

  // Cap schema size — same limit as full prompt to prevent context overflow
  let schemaStr = JSON.stringify(compact, null, 0);
  const MAX_SCHEMA_LEN = 6000;
  if (schemaStr.length > MAX_SCHEMA_LEN) {
    schemaStr = JSON.stringify(
      compact.map((t, i) =>
        i < compact.length - 5
          ? { name: t.name, parameters: { type: "object" } }
          : t,
      ),
      null,
      0,
    );
  }

  return `=== TOOL USAGE RULES ===
You are in AGENT LOOP with tools. Your task is to EXECUTE actions, not explain them:
- Received error from a tool? ANALYZE the error → CALL another tool with CORRECTED arguments OR give final answer
- NEVER output "Терминал недоступен" or similar errors as your own message — those are TOOL results, call next step
- AFTER receiving a tool result, DO NOT repeat the SAME tool call with the SAME arguments
- If Status: Completed — consider the result received even if output is empty
- Task COMPLETE → Write plain text answer with findings WITHOUT any JSON
- NEVER output your intention to call a tool as visible text
- Either output ONLY the tool_calls JSON OR ONLY plain text answer. Never both.

When you NEED to call another tool, output ONLY this minified JSON (no surrounding text, no markdown):
{"tool_calls":[{"name":"","arguments":{}}]}
Available Zed tools:
${schemaStr}`;
}
