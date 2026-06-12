# FreeQwenApi — Status (2026-06-12)

## Health: GREEN — DeepSeek direct API mode (2026-06-12)

DeepSeek: полностью убран Puppeteer из API вызовов. Теперь используются прямые `fetch()`
из Node.js с сохранёнными credentials (cookie + Bearer token + WASM solver).
Браузер используется только для одноразовой авторизации (auth.js). PoW решается через
WASM модуль (sha3_wasm_bg.wasm) с хардкодным fallback URL. Больше нет зависаний
из-за WAF/CAPTCHA — API запросы не проходят через браузер.
Qwen: без изменений.

### Architecture S61+: Multi-Provider Separation

Project refactored into **process-level isolation**: `index.js` dispatcher forks independent service processes. Each provider runs in its own process with dedicated browser/memory/resources. Shared utilities (`shared/`) reused across all services via relative imports.

| Area                              | Status    | Notes                                                                                                                                                                                                                                                       |
| --------------------------------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Multi-provider architecture       | Working   | S61: `index.js` dispatcher → forks Qwen and DeepSeek as isolated child processes via `child_process.fork()` with signal forwarding                                                                                                                          |
| Tool calling (SSE + streaming)    | Working   | Qwen only. Anti-loop guards, chunk splitting, parse reliability. DeepSeek: native OpenAI tool_calls supported at API level — requires agent-loop routing in routes.js layer.                                                                                |
| Agent-loop stability              | Working   | Qwen: Deferred auto-reset, cooldown, same-chat retry on "in progress". DeepSeek: not implemented (single-message model).                                                                                                                                    |
| Chat management                   | Working   | S46: resolveQwenChatId creates chat when no default exists. invalidateQwenChatId cleans ALL maps on "not exist" error. Early mapChatId (S57) saves mapping before SSE timeout loses it. DeepSeek: simple in-memory Map<conversation_id → deepseek_chat_id>. |
| Page pool memory (Qwen)           | Mitigated | Hard limit 5 pages, idle TTL 5min, periodic GC every 60s, Memory Guard RSS restart                                                                                                                                                                          |
| Timeout enforcement               | Active    | `REQUEST_TIMEOUT_MINUTES` (5m) wrapper + protocolTimeout synced at ~180s+ CDP limit. SSE reader abort 3min (S57). DeepSeek: configurable per-service timeout via `DEEPSEEK_REQUEST_TIMEOUT` env var (default 5 min).                                        |
| CAPTCHA resolver (Qwen)           | Working   | S52: centralized `resolveCaptchaAndRetry()`, JWT inject, `SIMULATE_CAPTCHA` test mode. DeepSeek: Cloudflare Turnstile — bypassed via cookie extraction on initial browser auth.                                                                             |
| Unit tests                        | Passing   | 46/46 (`npm test`) — Qwen unit suite unchanged. DeepSeek: no dedicated tests yet (D12).                                                                                                                                                                     |
| ESLint                            | Clean     | 0 errors, ~37 warnings (known unused imports — tech-debt)                                                                                                                                                                                                   |
| Prettier                          | Formatted | All files clean                                                                                                                                                                                                                                             |
| Aliyun WAF bypass (Qwen)          | Reworked  | S59→S62: убран `Authorization: Bearer` (фронтенд Qwen его не шлёт). Path 2 переписан: XHR → `fetch()` в main world (через WAF SDK страницы). Path 1 (Node.js) — только для `chats/new`. `networkidle0` + 2s пауза для WAF SDK.                     |
| Cookie auth extraction (DeepSeek)     | Working   | Puppeteer one-time visible launch → user login → deepseek_accounts.json saved with Qwen-style format (cookies + authData with token/wasmUrl/hif_dliq/hif_leim). Deep recursive search extracts nested keys from localStorage/sessionStorage JSON objects.                                                                                   |
| PoW solver (DeepSeek)                | Working   | Proof-of-Work via WASM: fetches challenge from `/create_pow_challenge`, solves with `wasm_solve()`, sends Base64-encoded answer in `X-DS-PoW-Response` header. Critical for DeepSeek Web API — without it returns `INVALID_TOKEN`.                                                                                   |
| Account binding (Qwen)               | Working   | chatTokenOwner Map, resolveAuthToken(preferredOwner) — chats belong to the account that created them                                                                                                                                                                                                |
| Multi-account management (Qwen)      | Working   | Add account clears old token + saves per-account dir. Relogin restores from cookies first, then manual fallback                                                                                                                                                                                     |

## Provider Comparison

| Feature              | Qwen (`services/qwen/`)                                                                       | DeepSeek (`services/deepseek/`)                                                                                                  |
| -------------------- | --------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| **API URL**          | `chat.qwen.ai/api/v2/chat/completions`                                                        | `chat.deepseek.com/api/v0/chat/completion`                                                                                       |
| **Auth**             | Token-based (JWT in localStorage). Multi-account via cookie-per-account.                      | Cookie + Deep recursive storage extraction (token, wasmUrl, hif_dliq/hif_leim). Stored in `deepseek_accounts.json` like Qwen.      |
| **WAF/Protection**   | Aliyun WAF + CSP block on evaluate fetch. Requires `evaluateInBrowser()` + two-path strategy. | CloudFront + Proof-of-Work (PoW): solves WASM challenge before each request via `/create_pow_challenge`. Header: `X-DS-PoW-Response`.
| **Tool Calls**       | Custom prompt injection (no native support). JSON parse roundtrip via `toolUtils.js`.         | Native OpenAI `tools[]` format supported by underlying R1/V3 models — proxy pass-through only, agent-loop logic in routes layer. |
| **Models**           | qwen3.7-max, qwen3-coder-plus, qwen3.5-plus/flash                                             | 7 aliases: v3/chat (V4 Flash), r1/reasoner (Thinking), expert/v4-pro (Expert + reasoning). Mapped via DEEPSEEK_MODELS config.          |
| **Memory footprint** | ~500MB+ (Chromium browser pool + page.evaluate locks). Heavy Puppeteer infrastructure.        | ~50MB (Express server only, no persistent browser — headless auth on-demand for session refresh).                                |
| **Code size**        | ~28 files, ~4500 LOC total                                                                    | 5 files, ~600 LOC total                                                                                                          |

## Shared Infrastructure (`shared/`)

| File              | Purpose                                                                | Shared by                                                                                                                 |
| ----------------- | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `config.js`       | PORT, HOST, LOG_LEVEL, LOG_MAX_SIZE, LOGS_DIR                          | All services import here for base server settings. Per-service config overrides service-specific values (URLs, timeouts). |
| `logger/index.js` | Winston + Morgan structured logging (`logInfo`, `logWarn`, `logError`) | All services use relative path imports (`../../../shared/logger/...`).                                                    |
| `utils/prompt.js` | CLI readline prompt helper for interactive menus                       | Qwen account menu, DeepSeek auth menu, main dispatcher.                                                                   |

## Quick Start

```bash
node index.js          # Dispatcher: choose provider (1=Qwen, 2=DeepSeek) → forks child process
npm test               # unit tests (no browser required)
npm run lint           # ESLint check
npm run format         # Prettier write
node scripts/auth.js   # Qwen account management CLI (--list, --add, --relogin, --remove)
```

## Critical Architecture Changes (S61+)

### Process-level isolation via child_process.fork()

`index.js` is now a pure dispatcher. Selected service entry point forked as separate process with `stdio: "inherit"` for interactive CLI menus in child. Parent forwards SIGINT/SIGTERM/SIGHUP to child via `child.kill(sig)`. Each provider runs on its own port (Qwen: 3264, DeepSeek: configurable via DEEPSEEK_PORT or shared PORT).

### Shared directory pattern

Common utilities extracted to `shared/` with absolute-relative imports from any depth (`../../../../shared/logger/...`). Eliminates duplication of logging, CLI prompts, base config across providers. Future providers only need their own `services/<name>/index.js` + API layer — no logger/config rewrites.

### Old src/ removed

Legacy single-repo structure (`src/api`, `src/browser`, `src/utils`) migrated to provider-scoped directories under `services/qwen/`. Directories cleaned, imports rewritten. Backward-compatible via new paths only.
