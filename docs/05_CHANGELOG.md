# 05 — Changelog

## Recent stabilization (Sessions 34–42, 2026-06-09)

| S | Title | Fix | Files changed |
|---|-------|-----|---------------|
| 34 | handleApiError warn spam | Extended error check to include `.status \|\| .errorBody`. Moved `logError` from handler to caller — only logs after retries exhausted. | qwenApi.js, routes.js |
| 35–36 | ESLint + Prettier setup | Flat config with Node+browser globals. Fixed modelMapping duplicate keys bug found by linter. Formatted all files. Added c8 coverage support. | eslint.config.js, .prettierrc, package.json |
| 37 | Tool call delivery reliability | Explicit `streamingCallback = null` guard in captureToolCalls block. Regex-strip JSON markers from visible text before SSE/JSON delivery. | routes.js |
| 38 | Strip bracket garbage | `_stripTrailingBracketGarbage()` trims trailing `[}\]]+` at all parse exit points. Final sanitization before SSE delivery skips empty chunks. | toolUtils.js, routes.js |
| 39 | unhandledRejection graceful shutdown | Added `process.on("unhandledRejection")`. Atomic `_shuttingDown` guard prevents double-shutdown race with uncaughtException handler. | index.js |
| 40 | Cache GC for modelDefaultChats + chatIdMap | Extended 10min GC: expire >24h entries from modelDefaultChats, hard cap 500 on chatIdMap (evict to 250), proactive idempotency cleanup. | chatSession.js |
| 41 | protocolTimeout alignment | `protocolTimeout = max(env, (REQUEST_TIMEOUT_MINUTES+5)*60s)`. Synced CDP timeout to ~8m instead of raw 10m so zombie promises don't hold page pool slots. | browser.js |
| 42 | "in progress" race condition | Same-chat retry with backoff (~2s, ~4s delay, max 3 attempts). Agent-loop cooldown: 1s pre-send delay when `inAgentLoop=true`. | qwenApi.js, routes.js |
| 43 | Memory Guard (RSS-based Chromium restart) | Periodic RSS check every N getPage() calls. Auto-restart Chromium via save-token → shutdown → init headless when RSS > BROWSER_RESTART_RSS_MB (default 512MB). Prevents OOM kills during long agent loops. Config: `BROWSER_RESTART_RSS_MB`, `MEMORY_CHECK_INTERVAL`. | browser.js, pagePool.js, config.js |
| 44 | Infinite loop on chat_not_exist after bulk delete | Two bugs: (1) createChatV2 rotated to a different token than sendMessage — newly created chats owned by another account immediately returned "not exist". Fixed by passing resolved tokenObj from sendMessage context. (2) No retryCount guard on chat_not_exist handler — infinite recursion when new chat also fails. Added `retryCount === 0` check for one-shot retry. | qwenApi.js |

## Tool calling (Sessions 7–38, ongoing)

| S | Title | Summary |
|---|-------|---------|
| 7-8 | Stabilize tool calling + dedup | Reduced toolsToPrompt from ~60 lines to ~12. Idempotency cache (5s TTL) prevents Zed retry spam hitting Qwen multiple times. |
| 9-10 | Force Folding for context pollution | TOOL_CALL_RESET_THRESHOLD=8 triggers force-compress: keep head (5 msgs) + tail (10 msgs) + discard middle as statistics summary. Prevents Qwen instruction decay in long loops. |
| 16 | Anti-hallucination project context injection | Phase 4 final: async FS scan → compact tree format (~30 tokens) injected into system message via buildProjectContext(). Cache TTL 60s, pre-warm on import. |
| 18 | Rewrite parseToolCallParts from Python fork | Multi-step strategy: full JSON parse → marker search with brace repair fallback → legacy fallback. Reasoning text sent as SSE chunk BEFORE tool_calls chunks (OpenAI streaming compliant). |
| 20 | Tool protocol injection + Qwen builtin tools disabled | Injected tool prompt into user message content prefix. Disabled all Qwen builtin tools at both payload root level AND feature_config (web_search, code_interpreter, etc.). |
| 23 | Compact tool results builder port from Python fork | buildCompactToolResults: dedup identical calls by signature, explicit continuation instruction ("Продолжи исходную задачу"), specific error hints. Replaces raw `Tool result(name): text` folding. |
| 24 | Strip empty tool_calls JSON + no-tool-needed prompt rule | Prompt updated: "If no action needs tools → write plain text WITHOUT any JSON". routes.js strips `{tool_calls:[]}` markers from fallback visible content when captureToolCalls falls through. |
| 26-27 | Terminal anti-loop + full schema compaction | Full tool parameter schemas in prompt (was only compact name list). `getRepeatedToolCalls()` / `getBlockedToolCalls()` ported from Python fork. Unified `_buildCompactTools()` with MAX_SCHEMA_LEN=6000 cap that drops descriptions on overflow. |
| 29 | SSE tool_call delivery chunk splitting | Rewrite writeToolCallsSse: metadata chunk first, then arguments split into ~500 char partial deltas (OpenAI streaming spec). Eliminates `tool input was not fully received` loops caused by TCP buffer loss. |
| 37-38 | Delivery reliability + bracket garbage strip | Final cleanup layers to ensure raw JSON artifacts never leak into visible SSE/JSON response content. |

## Agent-loop stability (Sessions 21–42)

| S | Title | Summary |
|---|-------|---------|
| 21 | Infinite retry spam on stale parentId | Split parent_id vs chat_not_exist error handlers. parent_id retry resets to null on same-chat without creating new Qwen chat. captureToolCalls path now calls persistSessionState before early return. |
| 22 | Defer auto-reset until agent loop ends | inAgentLoop flag added to modelDefaultChats entries. Auto-reset deferred until model returns text (no tool_calls). Mid-loop invalidation destroyed context — new chats had no assistant.tool_calls history. |

## Refactoring & architecture (Sessions 11–17, 2026-06-08)

| S | Title | Summary |
|---|-------|---------|
| 11-12 | routes.js module split + dead handler removal | routes.js: ~2390 → ~930 lines. Extracted chatSession.js (469), openaiUtils.js (207), responseBuilders.js (225), fileRoutes.js (101). Removed dead /v1/chat/completions handler, URL normalization middleware reroutes all v1→main handler. |
| 13 | chat.js → pagePool module split | Extracted pool management (~158 lines) into browser/pagePool.js: createPage, evaluateWithTimeout (Promise.race health check), getPage/releasePage/clear with stats getter. Re-exported for backward compat. |
| 14 | chat.js → qwenApi.js API layer split | Moved Qwen interaction logic (~1300 lines) to api/qwenApi.js: sendMessage, createChatV2, testToken, executeApiRequest variants (browser + Node streaming), buildPayloadV2, handleApiError. Chat.js now 180-line thin wrapper for token state + model loaders + re-exports. |
| 15 | Fix ESM immutable import bindings | Rewired to getter/setter pattern: `getAuthToken()` / `setAuthToken(val)` across qwenApi.js → chat.js boundary (13 replacements). Root cause: `authToken = val` on ESM import binding throws "Assignment to constant variable" even when target is `let`. |
| 17 | Dedup session persistence | Unified streaming + non-streaming paths into single `persistSessionState()` call in chatSession.js. Eliminated ~46 lines duplicated inline per path block in routes.js. |

## Critical bug fixes (Sessions 1–15, 2026-06-07)

| S | Title | Summary |
|---|-------|---------|
| 1 | resolveQwenChatId return + handleApiError undefined | resolveQwenChatId returned `undefined` — chat mapping never persisted. handleApiError could swallow errors returning `{error: undefined}` instead of string fallbacks (`HTTP 500`, `Неизвестная ошибка`). |
| 2-3 | protocolTimeout, evaluate timeout, goto retry, sliding window pair preservation | protocolTimeout → 10min (was 180s). evaluateWithTimeout via Promise.race (5s limit, prevents CDP hangs). Retry-loop for page.goto with exponential backoff. Sliding window: preserve tool_call/tool_result pairs — orphaned tools get assistant context prepended after `.slice(-40)`. |
| 4-6 | Warnings + SyntaxError + log spam | applyToolPrompt added inAgentLoop → light prompt for agent-loop (toolsToLightPrompt). Model-ignore-tools warning fixed: was checking `tools` param which is always null. Removed logRaw JSON dumps, debug-trace middleware auto-start, LOG_LEVEL default from 'debug' to info. |
| 12-13 | Import fixes + double injection prevention | logWarn missing import in routes.js (ReferenceError crash). buildPayloadV2 removed duplicate applyToolPrompt call — system_message already prepared by routes.js via applyToolPrompt upstream. Natural-language transcript folding: `"Assistant used tools: write_file"` instead of `JSON.stringify(tool_calls)`. |
| 19-20 | Stale chat cache after retry + tool protocol injection | Invalidated modelDefaultChats at persistSessionState when newChatId differs from existing — prevents next request resolving stale ID. Tool prompt now injected into BOTH system_message AND user message content prefix (Qwen ignores system on continuation). |
| 33 | Missing import of withRequestTimeout | Added missing `import { withRequestTimeout }` to routes.js after timeout wrapper created in S30. All subsequent requests crashed. |

## Infrastructure & quality (Sessions 30–39, 2026-06-08/09)

| S | Title | Summary |
|---|-------|---------|
| 30-31 | Timeout enforcement + memory leak mitigation | withRequestTimeout wrapper enforces REQUEST_TIMEOUT_MINUTES via Promise.race (previously dead code). Page pool: hard limit MAX_ACTIVE_PAGES=5, idle TTL eviction (PAGE_IDLE_TTL_MS), lazy-started periodic GC at PAGE_GC_INTERVAL_MS. Active pages counter tracks checkout/release. |
| 32 | Unit test infrastructure (46 tests) | node --test runner via `npm test`. toolUtils.test.js: parseToolCallParts, normalizeToolCalls, compactJsonSchema variants. chatSession.test.js: resolveQwenChatId helpers, idempotency cache, session extraction functions. openaiUtils.test.js: message parsing, combinedTools building, anti-loop guards. No browser/server required — pure unit tests. |
| 35-36 | ESLint + Prettier dev tooling | Flat config eslint.config.js with globals for Node+browser context (page.evaluate). Fixed modelMapping duplicate keys bug found by linter. Formatted all files via Prettier. Added c8 coverage (`npm run test:cov`). package-lock.json now tracked per Node.js standards. |
