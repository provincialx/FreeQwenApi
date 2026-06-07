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

export function toolsToPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const priorityNames = new Set([
    "skill_view",
    "skills_list",
    "skill_manage",
    "read_file",
    "search_files",
    "write_file",
    "patch",
    "terminal",
    "process",
    "web_search",
    "web_extract",
    "session_search",
    "todo",
    "clarify",
    "delegate_task",
  ]);

  const schemas = tools
    .map((tool) => {
      const fn = tool?.function || tool;
      if (!fn?.name) return null;
      return {
        name: fn.name,
        description: truncateForPrompt(
          fn.description || "",
          priorityNames.has(fn.name) ? 420 : 180,
        ),
        parameters: compactJsonSchema(
          fn.parameters || { type: "object", properties: {} },
        ),
        priority: priorityNames.has(fn.name) ? 0 : 1,
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  if (schemas.length === 0) return "";

  const toolNames = schemas.map((s) => s.name).join(", ");
  const skillRules = schemas.some((s) => s.name === "skill_view")
    ? `
SKILL RULES ARE HARD REQUIREMENTS:
- If the system prompt says a skill MUST be loaded, you MUST call skill_view before answering.
- If the user asks about Hermes Agent setup/config/providers/models/tools/skills/gateway/plugins/troubleshooting, FIRST call:
  {"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}}]}
- If a task is related to any listed skill category, call skill_view with the most relevant skill name before giving the final answer.
- After receiving a skill_view result, use it, then continue normally or call the next needed tool.
`
    : "";

  return `


OPENAI-COMPATIBLE TOOL CALLING ADAPTER ACTIVE.
You are behind a proxy that converts your JSON into real OpenAI tool_calls. Native prose like "I will use X" is NOT a tool call.

Available tool names exactly:
${toolNames}

${skillRules}GENERAL TOOL RULES:
- When an action, lookup, file read/write, command, web search, calculation, or verification is needed, CALL A TOOL instead of describing the action.
- If the user asks you to do something, and a suitable tool exists, respond with a tool call first.
- Never invent tool results. After tool results appear in the conversation, use them to continue.
- Use exact tool names from the list above. Do not prefix names with namespaces.

TOOL CALL OUTPUT FORMAT:
1. First write a brief sentence explaining what you are doing (e.g. "I will create test.py").
2. Then on a NEW LINE output minified JSON as your last line, no markdown:
{"tool_calls":[{"name":"tool_name","arguments":{}}]}

The proxy extracts the LAST JSON line as tool call. All text before it becomes visible assistant content.

Multiple calls are allowed:
{"tool_calls":[{"name":"skill_view","arguments":{"name":"hermes-agent"}},{"name":"terminal","arguments":{"command":"pwd"}}]}

Supported fallback shapes also work, but the format above is preferred.

Compact tool schemas:
${JSON.stringify(
  schemas.map(({ priority, ...schema }) => schema),
  null,
  2,
)}

If no tool is needed and no skill rule applies, answer normally.`;
}

export const lastRawContentForDebug = { value: null };

export function parseToolCallJson(content) {
  if (typeof content !== "string") return null;
  let text = content.trim();

  // Debug: save raw input
  lastRawContentForDebug.value = text.substring(0, 300);
  console.log(`[TOOL_PARSE] input=${text.substring(0, 200)}`);
  const fence = text.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fence) text = fence[1].trim();

  // Model now outputs reasoning text BEFORE JSON on last line.
  // Extract last JSON object: find { ... } starting from end of string.
  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  const parseAttempts = [text];
  // Qwen sometimes emits one missing brace in the common shape:
  // {"tool_calls":[{"name":"x","arguments":{...}}]} -> may become ..."arguments":{...}]}
  if (
    /^\s*\{\s*"tool_calls"\s*:\s*\[\s*\{/.test(text) &&
    /\}\]\}\s*$/.test(text)
  ) {
    parseAttempts.push(text.replace(/\}\]\}\s*$/, "}}]}"));
  }
  if (/^\s*\{\s*"tool_calls"\s*:\s*\[/.test(text) && !/\}\s*$/.test(text)) {
    parseAttempts.push(text + "}");
  }

  for (const candidate of parseAttempts) {
    try {
      const parsed = JSON.parse(candidate);
      let calls = null;
      if (Array.isArray(parsed.tool_calls)) {
        calls = parsed.tool_calls;
      } else if (parsed.function_call || parsed.tool_call) {
        calls = [parsed.function_call || parsed.tool_call];
      } else if (parsed.name && parsed.arguments !== undefined) {
        // Only treat as tool call if it has BOTH name AND arguments
        // Prevents parsing random JSON objects (e.g. {"content":"hello"}) as fake tools
        calls = [parsed];
      }
      if (!calls || calls.length === 0) continue;
      return calls
        .map((call, index) => {
          const name = call.name || call.tool || call.function?.name;
          const rawArgs =
            call.arguments ??
            call.args ??
            call.input ??
            call.function?.arguments ??
            {};
          const args =
            typeof rawArgs === "string"
              ? rawArgs
              : JSON.stringify(rawArgs || {});
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
    } catch {
      // try next repair candidate
    }
  }
  return null;
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

/** Light tool prompt for agent-loop: model has tool results, should synthesize answer */
export function toolsToLightPrompt(tools) {
  if (!Array.isArray(tools) || tools.length === 0) return "";

  const toolNames = tools
    .map((t) => (t?.function ? t.function.name : t?.name))
    .filter(Boolean)
    .join(", ");

  return `

TOOL CALLING ADAPTER (LIGHT MODE — results already available).
You have received results from prior tool calls. Use these results to form your answer.
Available tools if further action needed: ${toolNames}
To call another tool, respond with minified JSON (no markdown):
{"tool_calls":[{"name":"tool_name","arguments":{}}]}
Prefer natural language answer when you have enough information.`;
}
