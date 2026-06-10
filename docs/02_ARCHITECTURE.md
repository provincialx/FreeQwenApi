# 02 — Architecture

## High-level overview

FreeQwenApi is a browser-based proxy that replaces the Qwen Chat web account with a local OpenAI-compatible API endpoint (`localhost:3264`). It emulates Qwen API calls via JavaScript `fetch` inside Puppeteer-controlled Chromium pages.

```mermaid
graph TB
    subgraph Client["Zed Agent / Any OpenAI-compatible client"]
        Z[Agent process]
    end

    subgraph Proxy["FreeQwenApi (Node.js + Express)"]
        R[routes.js<br/>OpenAI endpoints]
        C[chatSession.js<br/>ID resolution, session persistence]
        U[openaiUtils.js<br/>Message parsing, folding]
        T[toolUtils.js<br/>Prompt injection, JSON parse]
        B2[qwenApi.js<br/>Qwen API interaction]
    end

    subgraph Browser["Chromium (Puppeteer)"]
        PP[pagePool.js<br/>Page lifecycle + health checks]
        EVAL["page.evaluate(fetch) → browser context"]
    end

    subgraph Upstream["chat.qwen.ai Web API v2"]
        Q[SSE streaming response<br/>or JSON completion]
    end

    Z --> R
    R --> C
    R --> U
    R --> T
    R --> B2
    B2 --> PP
    PP --> EVAL
    EVAL --> Q
```

## Request lifecycle — normal (no tools)

1. Client sends `POST /chat/completions` with OpenAI messages array
2. routes.js resolves `effectiveChatId` → `qwenChatId` via layered chat ID resolution (S03)
3. Message prepared: system message extracted, tool prompt injected if applicable (S04)
4. History folded when >60 messages or force-fold threshold reached (S10)
5. qwenApi.js sends payload via Puppeteer `page.evaluate(fetch)` to Qwen v2 API (S14)
6. SSE stream assembled, chunks written back as OpenAI-compatible data: events
7. Session state persisted (chat ID mapping, parentId tracking)

```mermaid
sequenceDiagram
    participant Zed as Client<br/>(Zed Agent)
    participant R as routes.js
    participant C as chatSession.js
    participant B2 as qwenApi.js
    browser as pagePool + evaluate
    QWEN as chat.qwen.ai API

    Zed->>R: POST /chat/completions<br/>{messages, model, stream:true}

    R->>C: resolveQwenChatId(effectiveChatId, model)
    Note right of C: 1. chatIdMap lookup<br/>2. modelDefaultChats fallback<br/>3. create new chat if needed
    C-->>R: qwenChatId (resolved)

    R->>B2: sendMessage(content, model, qwenChatId,<br/>parentId, systemMessage)

    B2->>browser: pagePool.getPage() + evaluate fetch
    browser->>QWEN: POST /api/v2/chat/completions

    QWEN-->>browser: SSE stream chunks
    Note right of browser: assemble content from<br/>delta.choices[0].delta.content

    browser-->>B2: {choices:[{message:{content}}]}
    B2-->>R: response.data

    R->>Zed: data: {"id":"...","object":"chat.completion.chunk", ...}<br/>data: [DONE]

    R->>C: persistSessionState(result, chatId)
```

## Request lifecycle — tool calling (agent loop)

When tools are present in the request:

1. Combined tools built from `tools[]` or `functions[]` array
2. Tool prompt injected into user message content via `applyToolPrompt()` + prepend to last text part (S20)
3. Qwen's internal tools disabled at payload level (no web search, no code interpreter — S18)
4. Response captured fully (not streamed), parsed for JSON tool_calls block
5. If tool calls found → write as incremental SSE deltas with reasoning prefix chunk first
6. Anti-loop checks: repeated/blocked tools blocked before delivery (S26)
7. Client executes tools, sends results back as `role:"tool"` messages
8. Next request detected as "in agent loop" — light prompt variant used

```mermaid
sequenceDiagram
    Zed->>R: POST {messages:[...],<br/>tools:["terminal", ...]}

    R->>R: buildCombinedTools(tools, functions)
    R->>R: toolsToPrompt(combinedTools)<br/>or toolsToLightPrompt if inAgentLoop

    Note over R: Inject tool protocol into<br/>user message content AND systemMessage

    R->>B2: sendMessage(with injected prompt,<br/>tools_enabled=false,<br/>builtin_tools_enabled=false)

    B2->>browser: evaluate fetch
    browser->>QWEN: POST /api/v2/chat/completions

    QWEN-->>browser: text response<br/>(contains JSON tool_calls block)

    browser-->>B2: assembled content
    B2-->>R: {choices:[{message:{content}}]}

    R->>T: parseToolCallParts(content)
    Note right of T: Split visible text + raw calls.<br/>Repair truncated braces.<br/>Normalize arguments.
    T-->>R: parts.visible, parts.calls[]

    alt Repeated/blocked tools detected (anti-loop)
        R->>Zed: Plain text fallback<br/>(finish_reason="stop")
    else New tool calls OK
        Note over R: cooldown 1s before next<br/>agent loop iteration
        R->>R: writeToolCallsSse()<br/>reasoning chunk →<br/>incremental args chunks (~500 chars)
        R->>Zed: data: {delta:{role:"assistant"}}<br/>data: {delta:{content:"thinking..."}}<br/>data: {delta:{tool_calls:[...]}}...<br/>data: [DONE]
    end

    Note over Zed: Execute tools locally,<br/>build results array

    Zed->>R: POST {messages: [...original<br/>+ assistant.tool_calls<br/>+ tool_results], tools:[...]}

    R->>R: hasOpenAIToolState → inAgentLoop=true
    R->>B2: sendMessage (same chat,<br/>parentId from prev response)

    alt "chat is in progress" race condition
        B2-->>B2: backoff retry same chat<br/>(~2s, ~4s delay — S42)
    else Normal send
        QWEN-->>browser: next response
    end

    Note over R: persistSessionState +<br/>auto-reset check at loop end
```

## Chat ID resolution (layered fallback)

Order of priority for determining which Qwen chat to use:

```mermaid
flowchart TD
    A[Client sends<br/>effectiveChatId] --> B{chatIdMap has mapping?}
    B -->|yes| C[return qwenChatId from map]
    B -->|no| D{modelDefaultChats has entry for model?}
    D -->|yes| E[return default chat +<br/>map to effectiveChatId]
    D -->|no| F{effectiveChatId starts with "chat_" ?}
    F -->|yes| G[create new Qwen chat<br/>via createChatV2]
    G --> H[map to effectiveChatId +<br/>save as model default]
    F -->|no| I[qwenChatId = null → sendMessage<br/>auto-creates chat at bottom]

    style C fill:#d4edda
    style E fill:#fff3cd
    style H fill:#cfe2ff
    style I fill:#f8d7da
```

## Error retry policy

| Error type | Strategy | Preserves parentId? | Preserves chatId? | Max attempts |
|---|---|---|---|---|
| `parent_id.*not exist` | Retry same chat, reset parentId to null | No (null) | Yes | 1 |
| `chat_not_exist` / `/not exist/i` | Create new chat via createChatV2 **with same token**, parentId=null, gated by `retryCount === 0` | No (null) | No (new) | 1 |
| `"chat is in progress"` | Wait + retry **same** chat with same parentId | Yes | Yes | 3, then escalate to new-chat fallback |

S42 fix: "in progress" retries wait 2s/4s before re-sending to the SAME chat. Only falls back to creating a new chat after all same-chat retries exhausted. Old behavior created a fresh chat immediately which broke tool-calling context continuity.
