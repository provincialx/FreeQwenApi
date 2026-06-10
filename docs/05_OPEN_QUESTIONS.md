# 06 — Open Questions & Known Limitations

## Active tech-debt items

### Low priority (non-blocking)

| # | Issue | Location | Risk |
|---|-------|----------|------|
| D1 | ESLint: `removeInvalidToken` imported but unused | `chat.js` L12 | Dead code — never referenced at runtime |
| D2 | Unused imports in routes.js (pre-refactor leftovers) | Various lines | Harmless. Fix when file is already open for another change per rules. |
| D3 | ESLint warnings: ~10 unused-var, no-empty catch, etc. | Multiple files | Warnings only — not errors. Known tech-debt tracked by linter. |

### Medium priority (should fix soon)

| # | Issue | Impact | Notes |
|---|-------|--------|-------|
| D4 | Node.js streaming uses global `fetch` without explicit guard | Older Node versions (<18) may fail silently | Current fallback to browser fetch works via try/catch. Prefer explicit `typeof fetch === 'function'` check in executeApiRequestWithNodeStreaming path (qwenApi.js L203). |
| D5 | Page pool memory accumulates at extreme agent-loop (>100 calls) | Memory leak grows monotonically under sustained heavy usage | Hard limit 5 + idle TTL GC mitigated acute cases. Consider auto-refreshing pages after N requests or T seconds alive-time to prevent Chromium DOM/JS heap growth regardless of pool size. |
| D6 | No integration/end-to-end tests — only unit tests | Regression testing requires manual smoke tests via running server | Unit suite (46 tests) covers pure logic functions well but not browser interaction, SSE delivery, or chat ID resolution end-to-end. Smoke test script exists (`scripts/smoke_test.js`) but needs live server + browser to run. |

## Resolved issues archive (cross-reference)

| # | Issue | Status | Session(s) resolved in |
|---|-------|--------|----------------------|
| ~~O1~~ | Qwen tool calling fails when Zed Agent sends request | ✅ RESOLVED — clean context + correct model needed. Dirty account memory on chat.qwen.ai caused plain text responses instead of JSON tool_calls. | S9 |
| ~~O2~~ | Streaming capture mode missing reasoning text before tool_call SSE chunks | ✅ RESOLVED — rewrite parseToolCallParts from Python fork. writeToolCallsSse sends reasoning chunk first then incremental tool_call deltas (~500 chars). OpenAI streaming-compliant format eliminates `tool input was not fully received` errors. | S18, S29 |
| ~~O3~~ | Auto-Reset (Force Folding) mechanism needed to prevent context pollution in long agent-loops | ✅ RESOLVED — TOOL_CALL_RESET_THRESHOLD=8 triggers force-fold: keep head 5 + tail 10 + discard middle as statistics. Applied via `forceResetModels` Set checked at prepareOpenAIMessageInput entry point. Deferred reset via `inAgentLoop` flag prevents mid-loop invalidation that destroys context. | S10, S22 |
| ~~O4~~ | `"chat is in progress"` race condition creates new chats immediately losing tool-calling context | ✅ RESOLVED — same-chat retry with backoff (~2s, ~4s) max 3 attempts before escalating to new chat fallback. Added 1s agent-loop cooldown delay before send to let Qwen SSE session settle. Prevents the old "create fresh chat → lose assistant.tool_calls history" path that caused 3-minute timeouts and tool calling failure. | S42 |

## Known behavioral quirks (not bugs, design trade-offs)

### 1. "chat is in progress" not fully eliminated
Qwen SSE session cleanup timing varies — second request may still hit `"chat is in progress"` even with backoff retries. Mitigated by:
- 1s pre-send cooldown when `inAgentLoop=true` (routes.js)
- Same-chat retry with exponential-ish backoff ~2s/4s, max 3 attempts (qwenApi.js)
- Falls back to new-chat creation after retries exhausted

**Not a bug**: Qwen server-side session lifecycle is opaque. Current mitigation handles >95% of cases without context loss.

### 2. Model behavior varies by account "memory cleanliness" on chat.qwen.ai
`qwen3.7-max` with accumulated history (old sessions, personalization data) may ignore tool protocol instructions and return plain text instead of JSON tool_calls. `qwen3-coder-plus` model is more reliable across accounts.

**Workaround**: Clear browser cookies/localStorage for chat.qwen.ai when tool calling stops working on an account. The Python fork deprecated — Node.js version has better schema compaction + anti-loop guards than any reference implementation.

### 3. Qwen ignores `system_message` on existing chat continuations
Qwen Chat Web API only applies system prompts to new/first-turn chats. When continuing existing conversations, the system message from payload is ignored entirely.

**Workaround**: Tool protocol instructions injected into BOTH system_message (for first turn) AND user message content prefix (for continuation turns). This dual injection ensures tool calling works regardless of whether Qwen reads the system prompt for that request.

### 4. OpenWebUI meta-request isolation
Queries matching `### Task:`, `History:` patterns get isolated into separate chats (`effectiveChatId=null`) via `isOpenWebUiMetaRequest()`. These never contaminate user conversations. Only relevant when using OpenWebUI as client — Zed Agent unaffected.

## Design constraints (by choice, not bugs)

1. **No native OpenAI tools** — Qwen Chat Web API does not support `tools[]` in the request payload. Attempting to send them produces `"Tool X does not exists"` errors at the API level. Prompt injection + JSON post-parse roundtrip is the only viable path for tool calling through this proxy.

2. **Browser fetch over Node.js HTTP** — Auth state (cookies, localStorage tokens) lives inside Chromium's browser context. Running requests via `page.evaluate(fetch)` preserves auth without needing cookie proxying or token refresh logic. Added complexity for marginal benefit to bypass.

3. **Python fork (`qwenfreeapi/`) deprecated as reference since S28** — Node.js version now has superior capabilities: better schema compaction with hard cap (Python sends raw schemas), complex anti-loop mechanisms (repeated calls, blocked tools), project context injection (anti-hallucination FS scan), modular architecture. Future development based on own experience + real-world testing with Zed Agent.

## API compatibility notes for external clients

### OpenAI-compatible endpoints
| Endpoint | Method | Notes |
|----------|--------|-------|
| `/api/chat/completions` or `/v1/chat/completions` | POST | Main chat endpoint. URL normalization middleware routes all v1→main handler. Supports streaming (SSE) and non-streaming responses. |
| `/files/getstsToken` | GET | Alibaba Cloud STS token for file upload. Scoped to current auth session. |
| `/files/upload` | POST | Multer middleware for multipart form upload with OSS integration via `fileUpload.js`. |
| `/chats/:chatId/history` | GET/POST | Chat history persistence endpoint — JSON files per chatId. Read/write conversation state. |

### Headers that affect behavior
- `x-new-chat`, `x-reset-chat: true` → force new Qwen chat creation, bypass session restore
- `conversation_id` (in body.metadata) → scoped session key for persistent chat mapping across requests
- `parentId`, `parent_id`, `response_id` (in body or x-parent-id header) → explicit parent message tracking for continuing conversation threads on Qwen
