# 03 — Code Map

## Module layout

```
src/
├── index.js                        # Entry point: Express app, browser init, auth flow
│   ├── puppeteer launch (browser.js)
│   ├── express router (routes.js + adminRoutes.js)
│   └── graceful shutdown hooks
│
├── config.js                       # Constants: timeouts, limits, URLs, server settings
│
├── api/                            # API layer — OpenAI-compatible endpoints + Qwen interaction
│   ├── routes.js                   # Main route handler. chatId resolution, streaming/non-streaming paths
│   ├── chatSession.js              # Chat ID map/model defaults, session persistence, folding trigger, ownership
│   │   ├── resolveQwenChatId() — layered fallback: chatIdMap → modelDefaultChats → create new
│   │   ├── invalidateQwenChatId() — clean ALL maps (chatIdMap, modelDefaultChats, sessionToChatMap, chatTokenOwner)
│   │   ├── setChatTokenOwner(qwenChatId, tokenId) — bind Qwen chat to account that created it
│   │   ├── getChatTokenOwner(qwenChatId) — resolve owner for sendMessage token selection
│   │   └── _runGC() — cleanup stale sessions (>24h), cap maps (chatIdMap 500, idempotency 1000, chatTokenOwner 500)
│   ├── openaiUtils.js              # Message parsing/normalization, tool state detection, folding helpers (buildStatelessTranscript)
│   ├── responseBuilders.js         # SSE chunk construction: tool_call delivery, streaming fallback
│   ├── qwenApi.js                  # Qwen API interaction: sendMessage, retry policy, error handling
│   │   ├── buildPayloadV2() — construct /api/v2/chat/completions payload
│   │   ├── parseNonSseCompletionBody() — detect ret[], code, captcha/overload in non-SSE 200 responses (S43)
│   │   ├── resolveAuthToken(browserContext, preferredOwnerId) — account binding + rotation logic
│   │   ├── executeApiRequest(page, apiUrl, payload, token) — evaluateInBrowser fetch with SSE reader timeouts
│   │   ├── createChatV2(model, title, parentId, tokenObj) — new chat creation via browser evaluate (JWT inject fallback: Node.js fetch)
│   │   ├── resolveCaptchaAndRetry() — centralized CAPTCHA handler: JWT save/inject, visible browser cycle, retry (S52)
│   │   └── handleApiError() — classify & route errors to retry paths
│   │       ├─ 401 → rotate token, retry
│   │       ├─ 429 RateLimited → mark rate-limited, try next token
│   │       ├─ 503 overload/CAPTCHA → trigger resolveCaptchaAndRetry or backoff retry (S48, S52)
│   │       └─ generic → return error with details
│   ├── chat.js                     # Token state + model/key loaders. Re-exports from qwenApi.js, pagePool.js
│   │   └── Re-exports: evaluateWithTimeout, evaluateInBrowser, EVALUATE_HEALTH_TIMEOUT (from pagePool)
│   ├── toolUtils.js                # Tool prompt injection & parseToolCallParts (JSON extraction)
│   │   ├── toolsToPrompt() / toolsToLightPrompt() — full vs compact schema injection
│   │   ├── normalizeToolCalls() — argument normalization + repair truncated braces
│   │   └── getRepeatedToolCalls() / getBlockedToolCalls() — anti-loop guards (S26)
│   ├── fileRoutes.js               # File upload STS token, chat history GET/POST endpoints
│   ├── fileUpload.js               # Alibaba Cloud OSS upload via STS credentials (evaluateInBrowser for browser context)
│   ├── modelMapping.js             # External → internal model name mapping table
│   ├── projectContext.js           # Anti-hallucination: FS scan → compact tree injected into system msg
│   ├── tokenManager.js             # Token rotation, account status tracking (OK/RATELIMIT/INVALID)
│   └── timeoutWrapper.js           # withRequestTimeout() — Promise.race wrapper for REQUEST_TIMEOUT_MINUTES
│
├── browser/                        # Puppeteer + Chromium management
│   ├── browser.js                  # Puppeteer launch config, stealth evasion, protocolTimeout setting (S41)
│   │   ├── dumpio: false — suppress Chromium crashpad binary dumps on stderr (S52)
│   │   ├── waitUntil: "domcontentloaded" — replaces networkidle2 in manual auth, eliminates 60s timeout (S52)
│   │   ├── skipManualRestart param — visible browser init without blocking auth flow for CAPTCHA resolver (S52)
│   │   └── protocolTimeout — calculated from REQUEST_TIMEOUT_MINUTES (~180 min default), prevents CDP disconnect during long SSE streams
│   ├── pagePool.js                 # Page pool + evaluate helpers: health-check checkout/release, idle TTL GC (S31)
│   │   ├── getPage() — acquire page from pool with evaluate timeout health check
│   │   ├── releasePage() — return to pool or close if invalid
│   │   ├── safeClosePage() — suppress Target closed errors on page.close() (S45)
│   │   ├── _runGC() / _ensureGC() — lazy-started periodic GC at PAGE_GC_INTERVAL_MS (S31)
│   │   ├── evaluateWithTimeout(page, fn, timeoutMs=5s) — health check with short timeout
│   │   ├── evaluateInBrowser(page, fn, args, timeoutMs=longTimeout) — long-lived browser fetch wrapper (≥ 180s)
│   │   └── Memory Guard: periodic RSS check → trigger restartBrowserIfLeaking() if threshold exceeded (BROWSER_RESTART_RSS_MB)
│   ├── auth.js                     # Auth verification + CAPTCHA resolution entry points
│   │   ├── checkAuthentication() — detect login needed, extract token after manual auth
│   │   ├── startManualAuthentication() — visible browser for first-time setup
│   │   └── checkVerification(page) — page-level verification prompt
│   └── session.js                  # Cookie/token extraction + persistence (per-account: session/accounts/{id}/cookies.json)
│       ├── saveSession(context, accountId?) → cookies.json per account or global fallback
│       ├── loadSession(context, accountId?) → restore cookies from file
│       ├── clearSession(accountId?) → remove saved session files
│       └── hasSession(accountId?) → check if session exists on disk
│
├── logger/                         # Logging infrastructure
│   └── index.js                    # Winston-based structured logging. logInfo/logWarn/logError/logDebug
│
└── utils/                          # Cross-cutting utilities
    ├── branding.js                 # ForgetMeAI watermark injection into messages
    ├── prompt.js                   # Prompt formatting helpers (multiline, dedent)
    └── accountSetup.js             # Account CLI: addAccountInteractive, reloginAccountInteractive, removeAccountInteractive


scripts/
├── auth.js                         # Account management CLI (--list, --add, --relogin, --remove, interactive menu)
└── addAccount.js                   # Direct account addition shortcut (wraps interactiveAccountMenu)

tests/unit/                         # Node.js built-in test runner (npm test)
├── toolUtils.test.js               # parseToolCallParts, normalizeToolCalls, toolsToPrompt variants
├── chatSession.test.js             # resolveQwenChatId helpers, idempotency cache, session detection
└── openaiUtils.test.js             # Message parsing, combinedTools building, anti-loop guards
```

## Key data objects

### Payload v2 (sent to Qwen API)

```typescript
interface PayloadV2 {
  stream: true;                    // always streaming
  incremental_output: true;
  chat_id: string;                 // resolved qwenChatId
  chat_mode: "normal";
  messages: [{                     // single user message
    fid: string;                   // UUID for this turn
    parentId?: string | null;      // response ID from previous assistant reply
    parent_id?: string | null;     // alias (both required)
    role: "user";
    content: string | Array<{type, text|image}>;  // tool prompt prepended if applicable
    chat_type: "t2t";
    sub_chat_type: "t2t";
    models: [string];             // mapped model name (e.g. qwen3-coder-plus)
    feature_config: {              // Qwen builtin tools disabled at payload level (S18, S20)
      auto_search: false;
      web_search: false;
      code_interpreter: false;
      browser_enabled: false;
      plugins_enabled: false;
      ...
    };
  }];
  model: string;                   // target model
  parent_id?: string | null;       // top-level parentId (for v2 API routing)
  system_message?: string;         // tool protocol instructions appended here
}
```

### Session state (in-memory, per-model defaults + chat maps)

| Store | Purpose | GC policy |
|-------|---------|-----------|
| `modelDefaultChats` Map<model → {chatId, parentId, toolCallCount, inAgentLoop}> | One "default" Qwen chat per model — auto-created and reused for new conversations | 24h TTL (S40 GC) |
| `chatIdMap` Map<effectiveChatId → qwenChatId> | Maps generated `chat_XXXXX` IDs to real Qwen internal UUIDs | Hard cap 500, evict oldest on spike (S40) |
| `sessionToChatMap` Map<scopedSessionKey → {chatId, parentId}> | Scoped sessions keyed by IP + User-Agent + conversation_hint hash | Cleared every 10 min GC tick (S40) |
| `idempotencyCache` Map<hash → response> | Prevents Zed retry spam — cache last successful response for 5s TTL | Lazy cleanup >1000 entries; proactive on each tick (S40) |
| **`chatTokenOwner`** Map<qwenChatId → tokenId> | **Binds Qwen chat to the account that created it. Prevents cross-account "not exist" errors on token rotation.** | Hard cap 500, evict unreferenced entries (S40) |

### Tool call result from parseToolCallParts()

```typescript
interface ParseResult {
  visible: string | null;          // reasoning text extracted before JSON block
  calls: Array<{                   // normalized OpenAI tool_calls format
    id: string;                    // tool_call UUID
    type: "function";
    function: {
      name: string;                // e.g. "terminal", "read_file"
      arguments: string;           // minified JSON (via repair + normalize)
    };
  } | null;                        // null if no valid tool calls found
}
```

### Account storage (disk)

```
session/
├── auth_token.txt                 # Global fallback token (used by proxy when no specific account needed)
└── accounts/
    ├── acc_1718234567890/
    │   ├── cookies.json           # Per-account Puppeteer cookies (for relogin session restore)
    │   └── token.txt              # Token backup per account
    └── ...                        # One directory per account ID
```

## Cross-module dependency graph

```mermaid
flowchart LR
    R[routes.js] --> S[chatSession.js]
    R --> U[openaiUtils.js]
    R --> T[toolUtils.js]
    R --> B2[qwenApi.js]
    R --> RB[responseBuilders.js]
    R --> TM[tokenManager.js]

    Q[qwenApi.js::sendMessage] --> S["chatSession.js<br/>(getChatTokenOwner, setChatTokenOwner)"]
    Q --> CQ["qwenApi.js::resolveAuthToken<br/>(preferredOwnerId → token selection)"]
    Q --> PP[pagePool.js]
    Q --> BR[browser.js::getBrowserContext]

    S --> CF[config.js]
    B2 --> CF

    PP --> BR
    PP ["pagePool.js + evaluateInBrowser<br/>+ evaluateWithTimeout + Memory Guard"]

    AU[auth.js] --> SE[session.js]

    AC[accountSetup.js] --> TM
    AC --> SE

    A[adminRoutes.js] --> TM
    
    FU[fileUpload.js] --> PP["evaluateInBrowser(fetch)"]
```

## Module size (lines, approximate)

| File | LOC | Notes |
|------|-----|-------|
| routes.js | ~1030 | Main handler. Grew with agent-loop logic (S22, S42). Refactored from 2390 → current via S11-14 splits. |
| qwenApi.js | ~1400 | Qwen API interaction: sendMessage, createChatV2, executeApiRequest (evaluateInBrowser), resolveCaptchaAndRetry (S52), resolveAuthToken (account binding) |
| chatSession.js | ~630 | Chat ID resolution/generation/normalization, session persistence, folding trigger, **chatTokenOwner Map + GC** |
| pagePool.js | ~374 | Page lifecycle with health checks, **evaluateInBrowser/evaluateWithTimeout helpers**, Memory Guard RSS restart (S31, S45) |
| openaiUtils.js | ~400 | Message parsing, tool state detection, buildStatelessTranscript, compact builder port from Python fork (S23) |
| responseBuilders.js | ~260 | buildOpenAIToolResponse, writeToolCallsSse with chunk splitting (S29) |
| toolUtils.js | ~500 | Prompt injection, parseToolCallParts (brace repair), anti-loop detection |
| chat.js | ~180 | Token state wrapper + model/key loaders. Re-exports evaluate helpers from pagePool. Grew thin after S14 split. |

## Important constants (from config.js)

```javascript
REQUEST_TIMEOUT_MINUTES = 5         // withRequestTimeout enforcement — increased to handle long in-browser SSE (S53+)
PROTOCOL_TIMEOUT = ~180 min        // puppeteer protocol timeout, calculated as (RT+5) × 60 × 2, prevents CDP disconnect during generation (S53+)
PAGE_POOL_SIZE = 3                  // soft pool size hint
MAX_ACTIVE_PAGES = 5                // hard limit on concurrent checked-out pages (S31)
PAGE_IDLE_TTL_MS = 5*60s           // idle page eviction TTL (S31)
PAGE_GC_INTERVAL_MS = 60s          // GC run frequency (S31)
EVALUATE_HEALTH_TIMEOUT = 5s       // health check evaluate timeout — prevents page.evaluate hangs
MAX_SCHEMA_LEN = 6000              // tool prompt schema cap in chars (S27)
BROWSER_RESTART_RSS_MB = 512       // RSS threshold to trigger Chromium restart, prevents OOM during long agent loops
MEMORY_CHECK_INTERVAL = 20         // check Node.js RSS every N getPage() calls (not every request — overhead reduction)
```

## Evaluate helpers (pagePool.js)

Two distinct evaluate wrappers serve different purposes:

| Function | Default timeout | Use case | Called from |
|----------|----------------|----------|-------------|
| `evaluateWithTimeout(page, fn)` | 5s (`EVALUATE_HEALTH_TIMEOUT`) | Page health check — is the CDP connection alive? | Pool checkout (`getPage`), verification checks in qwenApi.js |
| `evaluateInBrowser(page, fn, args)` | ≥ 180s (calculated from `REQUEST_TIMEOUT_MINUTES × 60 + 30s`) | Long-lived browser fetch — SSE stream inside Chromium tab for up to 5 minutes | All API requests (`executeApiRequest`), CAPTCHA JWT injection, file upload operations |

**Key difference:** `evaluateInBrowser` wraps `page.evaluate(fn, ...args)` (passes args as evaluate parameters) while `evaluateWithTimeout` uses simple `page.evaluate(fn)` (no args). Both use `Promise.race` against a timeout reject.
